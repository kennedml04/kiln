// Kiln's Policy, translated for Claude Code. Every tool call Claude Code wants to make (the main
// thread's and every subagent's) goes through one PreToolUse hook, which names the Kiln action and
// detail the call amounts to and looks it up in the effective Policy: allow runs it, deny blocks it,
// and ask hands it to the permission callback, which reports a Kiln permission request and waits
// for the answer before the tool may run.
import { isAbsolute, relative, resolve } from 'node:path';
import type { EffectivePolicy, PolicyAction, PolicyDecision } from '@kiln/widget-sdk';
import { decide } from '@kiln/widget-sdk';

/** What one tool call asks for, in Kiln's terms. */
export interface ToolRequest {
  action: PolicyAction;
  detail: string;
  decision: PolicyDecision;
}

/** Tools that only touch Claude Code's own state, or Kiln's: always allowed. */
const HARMLESS = new Set([
  'TodoWrite',
  'Task',
  'Agent',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskUpdate',
  'TaskStop',
  'TaskOutput',
  'EnterPlanMode',
  'ExitPlanMode',
  'ToolSearch',
  // Loads one of the Session's skills: instructions, not a grant (what it says to run is still checked).
  'Skill',
  'WaitForMcpServers',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
  'ReadMcpResourceDirTool',
]);
/** Tools that would go around Kiln: denied, with what to use instead. */
const AROUND_KILN: Record<string, string> = {
  AskUserQuestion: 'ask the person with the kiln raise_ask tool instead',
  EnterWorktree: 'Kiln gives each Session its worktree; work in this one',
  ExitWorktree: 'Kiln gives each Session its worktree; work in this one',
};
const READS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);
const WRITES = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  if (process.platform === 'win32' && /^[a-z]:/i.test(rel)) return false;
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

const samePathCase = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path);

/** The file or folder a read or write tool touches, if it names one. */
function pathOf(input: Record<string, unknown>): string | undefined {
  for (const key of ['file_path', 'notebook_path', 'path']) if (typeof input[key] === 'string' && input[key]) return input[key] as string;
  return undefined;
}

/** Splits a shell command line into its commands (on `&&`, `||`, `;`, `|` and newlines), outside quotes. */
export function splitCommands(line: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      current += c;
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < line.length) current += line[++i];
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      current += c;
      continue;
    }
    const two = line.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      parts.push(current);
      current = '';
      i++;
      continue;
    }
    if (c === ';' || c === '|' || c === '\n') {
      parts.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

const EXTERNAL_WRITES = [/^git\s+push\b/, /^gh\s+(pr|issue)\s+(create|comment|edit|close|merge|review)\b/, /^gh\s+release\s+create\b/, /^gh\s+api\b.*-X\s*(POST|PUT|PATCH|DELETE)/i];

const isKnown = (command: string, known: string[]) =>
  known.some((k) => (k.endsWith('*') ? command.startsWith(k.slice(0, -1)) : command === k));

/** One shell command's action. */
function commandRequest(policy: EffectivePolicy, command: string): ToolRequest {
  const action: PolicyAction = EXTERNAL_WRITES.some((re) => re.test(command))
    ? 'external_writes'
    : isKnown(command, policy.knownCommands)
      ? 'known_commands'
      : 'other_commands';
  return { action, detail: command, decision: decide(policy, action, command) };
}

const RANK: Record<PolicyDecision, number> = { allow: 0, ask: 1, deny: 2 };

/**
 * What a tool call amounts to and what the Policy says about it. `undefined` means the tool needs
 * no Kiln decision (it is harmless or a Kiln tool); a tool Kiln does not know asks. `skillFolders`
 * are the Session's own skill copies: reading them needs no decision.
 */
export function requestFor(
  policy: EffectivePolicy,
  worktree: string,
  tool: string,
  input: Record<string, unknown>,
  skillFolders: string[] = [],
): ToolRequest | undefined {
  if (HARMLESS.has(tool) || tool.startsWith('mcp__kiln__')) return undefined;
  if (AROUND_KILN[tool]) return { action: 'other_commands', detail: `${tool}: ${AROUND_KILN[tool]}`, decision: 'deny' };
  // A module's MCP server: its calls are checked like a command, so rules can name a server's
  // tools (`mcp__<server>__*`) and the action's rule covers the rest.
  if (tool.startsWith('mcp__')) {
    const detail = `${tool} ${JSON.stringify(input)}`;
    return { action: 'other_commands', detail, decision: decide(policy, 'other_commands', detail) };
  }
  if (READS.has(tool) || WRITES.has(tool)) {
    const target = resolve(worktree, pathOf(input) ?? '.');
    if (READS.has(tool) && skillFolders.some((folder) => inside(samePathCase(folder), samePathCase(target)))) return undefined;
    const action: PolicyAction = !inside(samePathCase(worktree), samePathCase(target)) ? 'outside_worktree' : READS.has(tool) ? 'worktree_read' : 'worktree_write';
    const detail = action === 'outside_worktree' ? target : relative(worktree, target).split('\\').join('/') || '.';
    return { action, detail, decision: decide(policy, action, detail) };
  }
  if (tool === 'Bash' || tool === 'PowerShell') {
    const commands = splitCommands(String(input.command ?? ''));
    if (!commands.length) return { action: 'other_commands', detail: '', decision: decide(policy, 'other_commands', '') };
    // The strictest of its commands decides, and is the one a Permission Ask names.
    return commands.map((c) => commandRequest(policy, c)).reduce((a, b) => (RANK[b.decision] > RANK[a.decision] ? b : a));
  }
  if (tool === 'WebFetch') {
    let domain = '';
    try {
      domain = new URL(String(input.url)).hostname;
    } catch {
      domain = String(input.url ?? '');
    }
    return { action: 'network', detail: domain, decision: decide(policy, 'network', domain) };
  }
  if (tool === 'WebSearch') return { action: 'network', detail: 'web search', decision: decide(policy, 'network', 'web search') };
  return { action: 'other_commands', detail: `${tool} ${JSON.stringify(input)}`, decision: 'ask' };
}
