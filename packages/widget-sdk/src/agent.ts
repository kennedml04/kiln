// The Agent interface (ADR 0004). The core knows Agents only through this.
// Commands flow core -> Agent Widget; events flow Agent Widget -> core.
import type { ModuleMcpServer } from './module.ts';
import type { EffectivePolicy } from './policy.ts';

/** Everything a fresh Session starts from. */
export interface SessionStart {
  sessionId: string;
  role: string;
  model?: string;
  prompt: string;
  /** Artifacts and Digests the Session is seeded with. */
  seed?: { artifacts?: { name: string; content: string }[]; digests?: string[] };
  /** The worktree the Session works in, or null when it has none. */
  worktree: string | null;
  /**
   * The effective Policy for this Session (Org, Project and Stage, strictest wins). Translate it
   * into the tool's own permission settings; report a `permission_request` for anything it says to ask.
   */
  policy?: EffectivePolicy;
  /** The Kiln tools for this Session: an MCP server scoped to the Session's own Item (see kiln-tools.ts). */
  kilnTools?: KilnToolsEndpoint;
  /**
   * The skills the Session runs with, decided by the core. Give the Agent exactly these: copy or
   * link the folders into the Session's own config, never into the worktree, and load nothing else
   * from them (no settings, hooks or permissions). A skill is instructions, not a grant.
   */
  skills?: SessionSkill[];
  /**
   * MCP servers from the Project's modules, by server name, in the Claude Code entry shape. Their
   * tool calls go through `policy` like any other tool. The `kiln` server is always Kiln's own.
   */
  mcpServers?: Record<string, ModuleMcpServer>;
}

/** One skill a Session runs with: a folder holding `SKILL.md` (and whatever files it refers to). */
export interface SessionSkill {
  name: string;
  /** Where it comes from: `module:<id>` for a module's own skill folder (later a Skill repo, or the Project). */
  source: string;
  /** The commit the folder is at, when its source is a pinned checkout; null when it is not. */
  commit: string | null;
  /** The skill's folder. Read-only to the Agent Widget. */
  folder: string;
}

/**
 * Where a Session reaches its Kiln tools: an MCP server over Streamable HTTP. Hand it to the Agent's
 * MCP client as is (Claude Code: `{ type: 'http', url, headers }`). The headers carry the Session's
 * own credential, valid only while the Session runs.
 */
export interface KilnToolsEndpoint {
  url: string;
  headers: Record<string, string>;
}

/**
 * A message sent into a running Session: a Thread message, the answer to a permission request, or
 * a person's answer to an Ask the Session raised. `changed` is true when it replaces an earlier
 * answer, or the recommendation a non-blocking Ask let the Session carry on with.
 */
export type AgentMessage =
  | { kind: 'text'; text: string }
  | { kind: 'permission_answer'; requestId: string; decision: 'allow' | 'deny' }
  | { kind: 'ask_answer'; askId: string; answer: string; changed: boolean };

/** One quota reading, as `docs/research/claude-code-quota-readings.md` describes. */
export interface QuotaReading {
  /** "5h", "week", ... */
  window: string;
  /** The model the window is scoped to, or null for all models. */
  model: string | null;
  /** 0-100, or null when the source doesn't say. */
  percent: number | null;
  /** ISO 8601. */
  resetsAt: string | null;
  /** ISO 8601. */
  takenAt: string;
  source: string;
  usingOverage: boolean;
  /**
   * The plan's paid usage credits used so far this month (Claude: `extra_usage.used_credits`), when
   * the source reports them. Kiln treats a rise as paid overage.
   */
  usedCredits?: number | null;
}

export type FinishReason = 'completed' | 'interrupted' | 'stopped' | 'error';

export type AgentEvent =
  | { kind: 'progress'; text?: string; tool?: { name: string; input?: unknown } }
  | { kind: 'permission_request'; requestId: string; action: string; detail: string }
  | {
      /**
       * One turn's measured usage, sent after every turn (subagent turns too). Report what the
       * model API returned; Kiln stores it as is and never estimates a missing number.
       */
      kind: 'usage';
      turn: number;
      /** The model that ran the turn; it decides the Budget. Unset: the Session's model. */
      model?: string;
      /** Uncached input tokens. */
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      /** The turn's context size. Unset: input + cache reads + cache writes. */
      contextTokens?: number;
      /** The model's context window in tokens, when the Agent knows it (the context alarm uses it). */
      contextWindow?: number;
      /** API-equivalent US dollars for the turn; a metered Budget converts it to its unit. */
      costUsd?: number;
      /** Set for a subagent's turn. `id` tells parallel subagents apart (default: the description). */
      subagent?: { id?: string; description: string };
    }
  | { kind: 'quota_reading'; reading: QuotaReading }
  | { kind: 'digest_written'; digest: string }
  | { kind: 'finished'; reason: FinishReason; message?: string };

export type AgentEventKind = AgentEvent['kind'];

export type AgentCommand =
  | { type: 'agent.start_session'; agentId: string; session: SessionStart }
  | { type: 'agent.send_message'; sessionId: string; message: AgentMessage }
  | { type: 'agent.interrupt'; sessionId: string }
  | { type: 'agent.resume'; sessionId: string }
  | { type: 'agent.stop'; sessionId: string };

/** What an Agent Widget tells the core about each Agent when it registers. */
export interface AgentRegistration {
  id: string;
  name: string;
  /** Prompt-cache lifetime for the model in use, so the Session manager can choose resume or fresh. */
  cacheLifetimeMs?: number;
  /** The model this Agent runs when a Stage names none; it decides which Budget such Sessions draw from. */
  model?: string;
  /**
   * The models this Agent can run, offered when an Admin decides which Budget each model draws
   * from. Each id must be exactly the name the Agent reports usage under.
   */
  models?: AgentModel[];
}

/** A model an Agent can run. */
export interface AgentModel {
  /** Exactly as the Agent reports it in usage, e.g. `claude-opus-5-5`. */
  id: string;
  /** For people, e.g. `Opus 5.5`. */
  name?: string;
  /** Served on this machine. Setup puts it in a local Budget by default. */
  local?: boolean;
}

/** Handed to the Agent for each Session, to report its events. */
export interface AgentSession {
  readonly start: SessionStart;
  emit(event: AgentEvent): Promise<void>;
}

/** Implemented by every Agent Widget. */
export interface Agent {
  startSession(session: AgentSession): void | Promise<void>;
  sendMessage(sessionId: string, message: AgentMessage): void | Promise<void>;
  /** Pause after the current step and stay resumable. */
  interrupt(sessionId: string): void | Promise<void>;
  resume(sessionId: string): void | Promise<void>;
  stop(sessionId: string): void | Promise<void>;
}
