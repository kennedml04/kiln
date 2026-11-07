import type { FinishReason, QuotaReading } from '@kiln/widget-sdk';

/**
 * One step of the fake Agent's script. Every Session the fake Agent starts runs
 * the current script from the top; `FakeAgent.setScript` changes it for later Sessions.
 * A script that ends without `finish` finishes with reason "completed".
 */
export type FakeAgentStep =
  /** Writes a file (relative to the Session's worktree). `{session}` in path, content or a commit message is the Session id. */
  | { do: 'write'; path: string; content: string }
  /** Stages everything in the worktree (or its `in` subfolder: a repo in a task folder) and commits it; with `amend`, rewrites the last commit with this message instead. */
  | { do: 'commit'; message: string; amend?: boolean; in?: string }
  /**
   * `{session}`, `{seed}` (the seed's artifact names, comma-separated) and `{artifact:<name>}` (that
   * seed artifact's content) are filled in.
   */
  | { do: 'progress'; text: string }
  /** Reports the effective Policy it got at Session start as progress "policy: <JSON>". */
  | { do: 'report_policy' }
  /**
   * Reports one turn's usage; turns are numbered from 1 per Session. `times` repeats the same turn
   * (each one numbered), checking for an interrupt between turns, `intervalMs` apart.
   */
  | {
      do: 'usage';
      inputTokens: number;
      outputTokens: number;
      model?: string;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      contextTokens?: number;
      contextWindow?: number;
      costUsd?: number;
      subagent?: { id?: string; description: string };
      times?: number;
      intervalMs?: number;
    }
  /** Reports a quota reading; `takenAt` defaults to now, `source` to "fake". */
  | { do: 'quota'; reading: Partial<QuotaReading> & { window: string } }
  /**
   * Raises a permission request (`action` is a Policy action, `detail` the command, domain or path)
   * and waits for its answer; reports it as progress "permission <decision>".
   */
  | { do: 'permission'; action: string; detail: string }
  /**
   * Repeats a tool call (as progress events), `times` times or until interrupted or stopped. With
   * `input` every call is the same (what the stall rule catches); without it each call gets its own
   * input (`{ call: n }`), so a long run reads as busy work.
   */
  | { do: 'tool'; name: string; input?: unknown; times: number | 'forever'; intervalMs?: number }
  /**
   * Raises an Ask with the Kiln tools' `raise_ask` (over MCP) and reports progress "ask raised: <id>".
   * A blocking Ask then waits for its answer and reports "answered: <answer>"; a non-blocking one
   * reports "carrying on with: <recommendation>" and goes on. An answer that arrives while the
   * script is not waiting for it (a changed non-blocking answer) is reported as "answer changed: <answer>".
   */
  | { do: 'ask'; ask: unknown }
  /** Lists the Kiln tools (MCP `tools/list`) and reports progress "tools: <names, comma-separated>". */
  | { do: 'kiln_tools_list' }
  /** Calls one Kiln tool and reports its text result as progress ("error: <text>" when it failed). */
  | { do: 'kiln_tool'; name: string; input?: unknown }
  /**
   * Raises an Ask as the Widget itself (`POST /api/widget/asks` with the Widget credential), waits
   * for its answer on the command stream and reports progress "widget heard: <answer>".
   * With `wait: false` it carries straight on; the answer is still reported when it comes.
   */
  | { do: 'widget_ask'; ask: unknown; wait?: boolean }
  /** Waits for the next text message and reports it as progress "heard: <text>". */
  | { do: 'wait_for_message' }
  /** Reports a `digest_written` event with this text (an Agent that does not use `write_digest`). */
  | { do: 'digest'; text: string }
  /**
   * Reports what the Session was started with, as progress "seed: <JSON {sessionId, prompt, seed}>",
   * so a test can check what a fresh Session is seeded with.
   */
  | { do: 'report_seed' }
  /**
   * Reports `finished`. A `completed` or `interrupted` finish with more steps after it keeps the
   * Session open (as a real Agent keeps its conversation): the next text message (Kiln's Exit
   * feedback, or a Thread message that resumes it) is reported as "heard: <text>" and the script goes on.
   */
  | { do: 'finish'; reason?: FinishReason; message?: string };

export type FakeAgentScript = FakeAgentStep[];

/**
 * What the fake Agent runs: one script for every Session, or a script per Session role
 * (e.g. `{ implementer: [...], reviewer: [...] }`). A key may also be `"<role>@<text>"`, used when
 * `<text>` appears in the Session's prompt, which names the Item's title (`for the ticket "Add slugify"`),
 * so Items that share a role can run different scripts. A Session runs, in order: the matching
 * `<role>@<text>` with the longest text, the plain `<role>`, `*`, or else finishes at once.
 */
export type FakeAgentScripts = FakeAgentScript | Record<string, FakeAgentScript>;

/** The fake Agent's install config: where the harness keeps its script (JSON FakeAgentScripts). */
export interface FakeAgentConfig {
  scriptFile: string;
}

/**
 * Settings the harness writes beside the script file (`agent.json`) on every install, read when
 * the fake Agent starts.
 */
export interface FakeAgentSettings {
  /** The `cacheLifetimeMs` the fake Agent registers with. Default 300000. */
  cacheLifetimeMs?: number;
  /** The model the fake Agent registers with. Default `fake-model`; null registers none. */
  model?: string | null;
  /** Model ids the fake Agent lists as the ones it can run, as a real Agent Widget does. Default none. */
  models?: string[];
}
