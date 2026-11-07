// The command classifier: what one tool call of an Agent amounts to in Kiln's terms (a PolicyAction
// and a detail) and what the effective Policy says about it: allow runs it, deny blocks it, and ask
// hands it to the Agent's permission callback, which reports a Kiln permission request and waits for
// the answer. Shared by every Agent Widget; the tool names an Agent uses are its ToolVocabulary
// (Claude Code's is the default). Node-only (node:os, node:path), so it is the subpath export
// `@kiln/widget-sdk/tool-classifier`, not part of the browser-safe index.
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import type { EffectivePolicy, PolicyAction, PolicyDecision } from './policy.ts';
import { decide } from './policy.ts';
import { shellRequest } from './shell-commands.ts';

/** What one tool call asks for, in Kiln's terms. */
export interface ToolRequest {
  action: PolicyAction;
  detail: string;
  decision: PolicyDecision;
}

/** The tool names an Agent uses, sorted by what Kiln does with them. */
export interface ToolVocabulary {
  /** Tools that only touch the Agent's own state, or Kiln's: always allowed. */
  harmless: ReadonlySet<string>;
  /** Tools that would go around Kiln: denied, with what to use instead. */
  aroundKiln: Readonly<Record<string, string>>;
  /** Tools that read a file or folder. */
  reads: ReadonlySet<string>;
  /** Tools that write a file. */
  writes: ReadonlySet<string>;
  /** Tools that run a shell command (the command is in `input.command`). */
  shells: ReadonlySet<string>;
  /** Tools that fetch a URL (in `input.url`). */
  fetches: ReadonlySet<string>;
  /** Tools that search the web. */
  searches: ReadonlySet<string>;
  /** Prefix of a module's MCP server tools, e.g. `mcp__`; unset: the Agent has none. */
  mcpPrefix?: string;
  /** Prefix of Kiln's own tools, always allowed. */
  kilnPrefix?: string;
}

/** Claude Code's tool names. */
export const CLAUDE_CODE_TOOLS: ToolVocabulary = {
  harmless: new Set([
    'TodoWrite',
    'Task',
    'Agent',
    'TaskCreate',
    'TaskGet',
    'TaskList',
    'TaskUpdate',
    'TaskStop',
    'TaskOutput',
    // Read or stop the Session's own background shells.
    'BashOutput',
    'KillShell',
    'KillBash',
    'EnterPlanMode',
    'ExitPlanMode',
    'ToolSearch',
    // Loads one of the Session's skills: instructions, not a grant (what it says to run is still checked).
    'Skill',
    'WaitForMcpServers',
    'ListMcpResourcesTool',
    'ReadMcpResourceTool',
    'ReadMcpResourceDirTool',
  ]),
  aroundKiln: {
    AskUserQuestion: 'ask the person with the kiln raise_ask tool instead',
    EnterWorktree: 'Kiln gives each Session its worktree; work in this one',
    ExitWorktree: 'Kiln gives each Session its worktree; work in this one',
  },
  reads: new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']),
  writes: new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']),
  // Monitor runs a shell command too (a watch loop), so it is judged the same way.
  shells: new Set(['Bash', 'PowerShell', 'Monitor']),
  fetches: new Set(['WebFetch']),
  searches: new Set(['WebSearch']),
  mcpPrefix: 'mcp__',
  kilnPrefix: 'mcp__kiln__',
};

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  if (process.platform === 'win32' && /^[a-z]:/i.test(rel)) return false;
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

const samePathCase = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path);
const slashes = (path: string) => path.split('\\').join('/');

/**
 * The scratch folders: the system temp folder (where an Agent keeps background task output) and
 * the shell's `/tmp` (the same folder in Git Bash). Files there are scratch, not the person's work.
 */
export const SCRATCH = [...new Set([tmpdir(), '/tmp'])];

/**
 * Where a tool call runs, as the Agent's hook reports it: `cwd`, the folder its shell stands in
 * (it can `cd` away from the worktree), and `ownFolder`, the Session's own Agent folder
 * (where Claude Code saves long tool results for the Session to read back).
 */
export interface ToolPlace {
  cwd?: string;
  ownFolder?: string;
}

/**
 * The Session's own Claude Code folder, from a hook's `transcript_path` and `session_id`: the
 * transcript `<projects>/<slug>/<session id>.jsonl` sits beside it (a subagent's inside it).
 */
export function ownFolderOf(transcriptPath: unknown, sessionId: unknown): string | undefined {
  if (typeof transcriptPath !== 'string' || typeof sessionId !== 'string' || !transcriptPath || !/^[\w-]+$/.test(sessionId)) return undefined;
  const m = new RegExp(`^(.*[\\\\/]${sessionId})(?:\\.jsonl$|[\\\\/])`).exec(transcriptPath);
  return m?.[1];
}

/** The file or folder a read or write tool touches, if it names one. */
function pathOf(input: Record<string, unknown>): string | undefined {
  for (const key of ['file_path', 'notebook_path', 'path']) if (typeof input[key] === 'string' && input[key]) return input[key] as string;
  return undefined;
}

/**
 * What a tool call amounts to and what the Policy says about it. `undefined` means the tool needs
 * no Kiln decision (it is harmless or a Kiln tool); a tool Kiln does not know asks. `skillFolders`
 * are the Session's own skill copies: reading them needs no decision. `readRoots` are folders the
 * Session may read but not write (see SessionStart); its own Agent folder (`where.ownFolder`)
 * is one too. Shell commands are judged from `where.cwd`. `vocab` names the Agent's tools.
 */
export function requestFor(
  policy: EffectivePolicy,
  worktree: string,
  tool: string,
  input: Record<string, unknown>,
  skillFolders: string[] = [],
  givenReadRoots: string[] = [],
  allScratch: string[] = SCRATCH,
  where: ToolPlace = {},
  vocab: ToolVocabulary = CLAUDE_CODE_TOOLS,
): ToolRequest | undefined {
  const readRoots = where.ownFolder ? [...givenReadRoots, where.ownFolder] : givenReadRoots;
  // A Stage that denies acting outside the worktree (a chat, a Project Thread) gets no scratch either.
  const scratch = policy.actions.outside_worktree === 'deny' ? [] : allScratch;
  const { harmless, aroundKiln, reads: READS, writes: WRITES } = vocab;
  if (harmless.has(tool) || (vocab.kilnPrefix && tool.startsWith(vocab.kilnPrefix))) return undefined;
  if (Object.hasOwn(aroundKiln, tool)) return { action: 'other_commands', detail: `${tool}: ${aroundKiln[tool]}`, decision: 'deny' };
  // A module's MCP server: its calls are checked like a command, so rules can name a server's
  // tools (`mcp__<server>__*`) and the action's rule covers the rest.
  if (vocab.mcpPrefix && tool.startsWith(vocab.mcpPrefix)) {
    const detail = `${tool} ${JSON.stringify(input)}`;
    return { action: 'other_commands', detail, decision: decide(policy, 'other_commands', detail) };
  }
  if (READS.has(tool) || WRITES.has(tool)) {
    const target = resolve(worktree, pathOf(input) ?? '.');
    if (READS.has(tool) && skillFolders.some((folder) => inside(samePathCase(folder), samePathCase(target)))) return undefined;
    // A read tool inside a read root is a read, whatever the worktree is.
    const inReadRoot = READS.has(tool) && readRoots.some((root) => inside(samePathCase(resolve(root)), samePathCase(target)));
    if (inReadRoot) {
      const detail = target.split('\\').join('/');
      return { action: 'worktree_read', detail, decision: decide(policy, 'worktree_read', detail) };
    }
    // The temp folder is the Session's scratch space: reading and writing there is like the worktree.
    if (scratch.some((root) => inside(samePathCase(resolve(root)), samePathCase(target)))) {
      const action: PolicyAction = READS.has(tool) ? 'worktree_read' : 'worktree_write';
      const detail = slashes(target);
      return { action, detail, decision: decide(policy, action, detail) };
    }
    const action: PolicyAction = !inside(samePathCase(worktree), samePathCase(target)) ? 'outside_worktree' : READS.has(tool) ? 'worktree_read' : 'worktree_write';
    const detail = action === 'outside_worktree' ? target : relative(worktree, target).split('\\').join('/') || '.';
    return { action, detail, decision: decide(policy, action, detail) };
  }
  // Reads and writes inside the worktree (`ls`, `git log`, `git add`) count as such; see shellRequest.
  if (vocab.shells.has(tool)) {
    return shellRequest(policy, worktree, String(input.command ?? ''), scratch.map(slashes), {
      ...(where.cwd ? { cwd: where.cwd } : {}),
      readRoots: where.ownFolder ? [slashes(where.ownFolder)] : [],
    });
  }
  if (vocab.fetches.has(tool)) {
    let domain = '';
    try {
      domain = new URL(String(input.url)).hostname;
    } catch {
      domain = String(input.url ?? '');
    }
    return { action: 'network', detail: domain, decision: decide(policy, 'network', domain) };
  }
  if (vocab.searches.has(tool)) return { action: 'network', detail: 'web search', decision: decide(policy, 'network', 'web search') };
  return { action: 'other_commands', detail: `${tool} ${JSON.stringify(input)}`, decision: 'ask' };
}
