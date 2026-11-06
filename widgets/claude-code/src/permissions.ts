// Kiln's Policy, translated for Claude Code. Every tool call Claude Code wants to make (the main
// thread's and every subagent's) goes through one PreToolUse hook, which names the Kiln action and
// detail the call amounts to and looks it up in the effective Policy: allow runs it, deny blocks it,
// and ask hands it to the permission callback, which reports a Kiln permission request and waits
// for the answer before the tool may run.
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import type { EffectivePolicy, PolicyAction, PolicyDecision } from '@kiln/widget-sdk';
import { decide, shellRequest } from '@kiln/widget-sdk';

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
const slashes = (path: string) => path.split('\\').join('/');

/**
 * The scratch folders: the system temp folder (where Claude Code keeps background task output) and
 * the shell's `/tmp` (the same folder in Git Bash). Files there are scratch, not the person's work.
 */
export const SCRATCH = [...new Set([tmpdir(), '/tmp'])];

/**
 * Where a tool call runs, as Claude Code's hook reports it: `cwd`, the folder its shell stands in
 * (it can `cd` away from the worktree), and `ownFolder`, the Session's own Claude Code folder
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
 * Session may read but not write (see SessionStart); its own Claude Code folder (`where.ownFolder`)
 * is one too. Shell commands are judged from `where.cwd`.
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
): ToolRequest | undefined {
  const readRoots = where.ownFolder ? [...givenReadRoots, where.ownFolder] : givenReadRoots;
  // A Stage that denies acting outside the worktree (a chat, a Project Thread) gets no scratch either.
  const scratch = policy.actions.outside_worktree === 'deny' ? [] : allScratch;
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
  // Monitor runs a shell command too (a watch loop), so it is judged the same way.
  if (tool === 'Bash' || tool === 'PowerShell' || tool === 'Monitor') {
    return shellRequest(policy, worktree, String(input.command ?? ''), scratch.map(slashes), {
      ...(where.cwd ? { cwd: where.cwd } : {}),
      readRoots: where.ownFolder ? [slashes(where.ownFolder)] : [],
    });
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
