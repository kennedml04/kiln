// The Kiln Policy in OpenCode's terms, both ways.
//
// Out: `openCodePermission` turns the Session's effective Policy into OpenCode's `permission` config.
// OpenCode then runs what Kiln allows, refuses what Kiln denies, and asks about the rest. Within one
// tool OpenCode lets the last matching pattern win, while Kiln lets the strictest matching rule win;
// so the catch-all goes first and every narrower pattern follows sorted allow, ask, deny: the last
// match is then the strictest. Where OpenCode can't say what Kiln means (path or domain rules), the
// tool is set to ask, and Kiln answers each request from the Policy.
//
// Back: `kilnRequest` turns one OpenCode permission request into the Kiln action and detail (the
// command, path or domain) for a `permission_request`.
import type { EffectivePolicy, PolicyAction, PolicyDecision } from '@kiln/widget-sdk';

/** Commands that write outside Kiln: pushes, PRs, issues, releases, API calls. */
export const EXTERNAL_WRITE_COMMANDS = ['git push', 'gh pr', 'gh issue', 'gh release', 'gh api', 'gh repo', 'gh gist'];

export type PermissionValue = PolicyDecision | Record<string, PolicyDecision>;

const RANK: Record<PolicyDecision, number> = { allow: 0, ask: 1, deny: 2 };

/** One action's decision, or ask when its rules (paths, domains) differ from it. */
function flat(policy: EffectivePolicy, action: PolicyAction): PolicyDecision {
  const decision = policy.actions[action];
  return policy.rules.some((r) => r.action === action && r.decision !== decision) ? 'ask' : decision;
}

/** `cmd` and everything that starts with `cmd `, as OpenCode bash patterns. */
const commandPatterns = (cmd: string): string[] => (cmd.endsWith('*') ? [cmd] : [cmd, `${cmd} *`]);

function bash(policy: EffectivePolicy): Record<string, PolicyDecision> {
  const entries: [string, PolicyDecision][] = [];
  for (const known of policy.knownCommands) for (const p of commandPatterns(known)) entries.push([p, policy.actions.known_commands]);
  for (const ext of EXTERNAL_WRITE_COMMANDS) for (const p of commandPatterns(ext)) entries.push([p, policy.actions.external_writes]);
  for (const rule of policy.rules) {
    if (rule.action === 'other_commands' || rule.action === 'known_commands' || rule.action === 'external_writes') {
      entries.push([rule.match, rule.decision]);
    }
  }
  // Stable sort: strictest last, so OpenCode's last match is Kiln's strictest.
  entries.sort((a, b) => RANK[a[1]] - RANK[b[1]]);
  const result: Record<string, PolicyDecision> = { '*': policy.actions.other_commands };
  for (const [pattern, decision] of entries) {
    // A pattern named twice keeps its strictest decision, in the strictest place.
    delete result[pattern];
    result[pattern] = decision;
  }
  return result;
}

/** OpenCode's `permission` config for this Policy. */
export function openCodePermission(policy: EffectivePolicy): Record<string, PermissionValue> {
  const read = flat(policy, 'worktree_read');
  const network = flat(policy, 'network');
  return {
    read,
    glob: read,
    grep: read,
    list: read,
    edit: flat(policy, 'worktree_write'),
    bash: bash(policy),
    webfetch: network,
    websearch: network,
    codesearch: network,
    external_directory: flat(policy, 'outside_worktree'),
    // Kiln watches for stalls and runaway loops itself.
    doom_loop: 'allow',
    // Questions go to people through the Kiln tools' raise_ask, which lands in Needs you.
    question: 'deny',
    task: 'allow',
    todowrite: 'allow',
    todoread: 'allow',
    skill: 'allow',
    lsp: 'allow',
  };
}

/** An OpenCode permission request, in either 1.x shape (`permission.asked` or the older `permission.updated`). */
export interface OpenCodePermission {
  id: string;
  sessionID: string;
  /** permission.asked */
  permission?: string;
  patterns?: string[];
  /** permission.updated */
  type?: string;
  pattern?: string | string[];
  metadata?: Record<string, unknown>;
  title?: string;
}

const isKnown = (command: string, known: string[]) => known.some((k) => command === k || command.startsWith(`${k} `));
const isExternalWrite = (command: string) => EXTERNAL_WRITE_COMMANDS.some((p) => command === p || command.startsWith(`${p} `));

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

/** A path relative to the worktree when it is inside it, with forward slashes. */
function relativePath(path: string, worktree: string | null): string {
  const norm = (p: string) => p.replace(/\\/g, '/');
  if (!worktree) return norm(path);
  const root = norm(worktree).replace(/\/$/, '');
  const p = norm(path);
  return p.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? p.slice(root.length + 1) : p;
}

/** The Kiln action and detail for one OpenCode permission request. */
export function kilnRequest(request: OpenCodePermission, policy: EffectivePolicy | undefined, worktree: string | null): { action: PolicyAction; detail: string } {
  const kind = request.permission ?? request.type ?? 'unknown';
  const patterns = request.patterns ?? (Array.isArray(request.pattern) ? request.pattern : request.pattern ? [request.pattern] : []);
  const meta = request.metadata ?? {};
  const str = (key: string) => (typeof meta[key] === 'string' ? (meta[key] as string) : undefined);
  const first = patterns[0] ?? request.title ?? '';
  switch (kind) {
    case 'bash': {
      const command = (str('command') ?? patterns.join(' && ')).trim();
      if (isExternalWrite(command)) return { action: 'external_writes', detail: command };
      if (isKnown(command, policy?.knownCommands ?? [])) return { action: 'known_commands', detail: command };
      return { action: 'other_commands', detail: command };
    }
    case 'edit':
    case 'write':
    case 'patch':
    case 'multiedit':
      return { action: 'worktree_write', detail: relativePath(str('filepath') ?? str('filePath') ?? first, worktree) };
    case 'read':
    case 'glob':
    case 'grep':
    case 'list':
    case 'lsp':
      return { action: 'worktree_read', detail: relativePath(str('filepath') ?? first, worktree) };
    case 'webfetch':
      return { action: 'network', detail: hostOf(str('url') ?? first) };
    case 'websearch':
    case 'codesearch':
      return { action: 'network', detail: `${kind}: ${str('query') ?? first}` };
    case 'external_directory':
      return { action: 'outside_worktree', detail: (str('filepath') ?? str('parentDir') ?? first).replace(/\\/g, '/') };
    default:
      // A tool Kiln has no action for: ask about it as a command, naming the tool.
      return { action: 'other_commands', detail: `${kind}${first ? ` ${first}` : ''}` };
  }
}
