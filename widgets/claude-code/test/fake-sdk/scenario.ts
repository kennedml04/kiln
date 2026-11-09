// What the fake Claude Agent SDK plays back. Each user message the Widget sends starts the next
// turn; a turn's steps run in order and the turn ends with a `result` message, as Claude Code's do.

/** Token counts as the Anthropic API reports them on one assistant message. */
export interface FakeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export type FakeStep =
  /**
   * Claude asks to use a tool: hooks and the permission callback run, then the tool really runs
   * (Write, Edit, Read and Bash on disk; `mcp__kiln__*` against the Kiln tools). `subagent` names
   * a subagent started earlier in the turn to run it inside.
   */
  | { tool: string; input: Record<string, unknown>; subagent?: string }
  /** An assistant text reply. */
  | { text: string }
  /** One model API call's usage (an assistant message), priced at `costUsd` toward the turn's cost. */
  | { assistant: { model: string; usage: FakeUsage; costUsd: number; subagent?: string } }
  /** Starts a subagent (an Agent tool call): later steps name it by `id` to run inside it. */
  | { subagent: { id: string; description: string } }
  /** A `rate_limit_event`. */
  | { rateLimit: { rateLimitType: string; utilization: number; resetsAt: number; isUsingOverage?: boolean } }
  /** Waits here until the Widget interrupts the query (the turn then ends as interrupted). */
  | { waitForInterrupt: true }
  /** Makes the next turn's `usage_EXPERIMENTAL...()` reply this (or throw, for 'unavailable'). */
  | { setUsage: unknown };

export interface FakeScenario {
  turns: FakeStep[][];
  /** What `usage_EXPERIMENTAL...()` replies; 'unavailable' makes it throw. Default 'unavailable'. */
  usage?: unknown;
  /** The Claude session id the fake reports. */
  sessionId?: string;
  /** The context window `result.modelUsage` reports for every model. Default 200,000. */
  contextWindow?: number;
  /**
   * Run a real child process in the Session's folder for as long as the query is open, as
   * `claude.exe` does (on Windows it keeps the folder from being removed). It exits `exitDelayMs`
   * after `close()`, and only then does the query's message stream end.
   */
  holdsCwd?: { exitDelayMs?: number };
  /** The `transcript_path` hooks get. Default ''. */
  transcriptPath?: string;
  /** The `cwd` hooks get, as Claude Code reports its shell's folder after a `cd`. Default the Session's folder. */
  hookCwd?: string;
}

/** One line of the fake's log (`<scenario>.log`, JSON lines), for tests to check what happened. */
export type FakeLogEntry =
  /** `configDirFiles`: what the `env.CLAUDE_CONFIG_DIR` folder held when the query started (null: no such folder). */
  | { kind: 'options'; options: Record<string, unknown>; configDirFiles?: string[] | null }
  /** A turn's model call, made only when `env.ANTHROPIC_BASE_URL` is set (a local Session). */
  | { kind: 'api'; url: string; model: string; token: string | null; status: number }
  | { kind: 'user'; text: string }
  | { kind: 'tool'; name: string; input: Record<string, unknown>; outcome: 'ran' | 'denied'; via: 'hook' | 'permission'; message?: string }
  | { kind: 'mcp'; tool: string; result: unknown }
  | { kind: 'interrupt' }
  | { kind: 'close' }
  /** The `holdsCwd` process exited. */
  | { kind: 'exited'; cwd: string };
