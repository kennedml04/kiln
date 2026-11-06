// The Session manager: starts a fresh Session per Item Stage through the Agent interface, in the
// Stage's own worktree when it needs one, turns the Agent's events into `session.*` events, and
// has the Exit checked when the Agent finishes. A met Exit moves the Item; a missing one goes back
// to the Session as feedback.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  CHAT_KIND,
  CHAT_POLICY,
  CHAT_ROLE,
  CHAT_STAGE,
  alwaysAllowMatch,
  chatOfThread,
  chatThreadId,
  decide,
  isPolicyAction,
  PERMISSION_ANSWERS,
  POLICY_ACTION_NAMES,
  PROJECT_THREAD_KIND,
  PROJECT_THREAD_POLICY,
  PROJECT_THREAD_ROLE,
  PROJECT_THREAD_STAGE,
  projectOfThread,
  projectThreadId,
} from '@kiln/widget-sdk';
import type {
  AgentEvent,
  Ask,
  RaiseAskRequest,
  AgentEventReport,
  Digest,
  DigestContent,
  FinishReason,
  Item,
  ItemRun,
  Project,
  RoleModel,
  ScratchChat,
  SessionInfo,
  SessionState,
  SessionUsage,
  Stage,
  ThreadEntry,
  TicketSize,
  Variant,
  ThreadMessageResult,
} from '@kiln/widget-sdk';
import type { AskService } from '../asks/ask-service.ts';
import type { AuditLog } from '../audit.ts';
import type { PolicyEngine, PolicyScope } from '../policy/policy.ts';
import type { EventBus } from '../events.ts';
import { WidgetHostError, type WidgetHost } from '../widget-host.ts';
import { WorkError, type Work } from '../work/work.ts';
import { readProjectFiles } from '../work/project-files.ts';
import { moduleSessionKit } from '../work/skills.ts';
import { checkExit, exitFeedback, grillPathOf, readProjectSettings, specPathOf } from './exit-checker.ts';
import { findingsPathOf, type Gates } from './gates.ts';
import { CO_AUTHORED_BY, defaultBranch, ensureWorktree, git, readHead, worktreePath } from './git.ts';
import { modeOf, ticketSize, type Routing } from '../local/routing.ts';
import type { ChatToolsScope, KilnToolsScope, ProjectToolsScope } from './kiln-tools.ts';
import { createMarkdownKnowledgeStore, digestContent, type KnowledgeStore } from '../knowledge/markdown-store.ts';

export interface SessionManager {
  /** Starts a fresh Session for the Item's current Stage. 409 when the Stage runs none or one is running. */
  start(itemId: string): Promise<SessionInfo>;
  sessions(itemId?: string): SessionInfo[];
  session(id: string): SessionInfo | undefined;
  /** The Item's Thread: its Session events, oldest first. */
  thread(itemId: string): ThreadEntry[];
  /** Interrupts a running Session (Stop all). It stays `paused`, keeps its worktree and can resume. */
  pause(id: string): void;
  /**
   * Continues a paused Session while its Agent's cache is warm ('resumed'). Past the cache lifetime
   * it ends the Session as stopped instead ('expired'), so the caller starts a fresh one from Digests.
   */
  resume(id: string): Promise<'resumed' | 'expired' | undefined>;
  /** Sessions that are running, paused or waiting on an Ask now. */
  active(): SessionInfo[];
  /** Waits for in-flight Exit checks (used on shutdown). */
  idle(): Promise<void>;
  /**
   * The Session a Kiln tools credential belongs to, and the tools' scope (its own Item), while the
   * Session runs or waits on an Ask. Undefined for any other token.
   */
  kilnTools(token: string): { session: SessionInfo; scope: KilnToolsScope } | undefined;
  /** The Sessions running right now. */
  running(): SessionInfo[];
  /** The model a Session started for the Item now would run (its Stage's, else the ready Agent's). */
  plannedModel(itemId: string): string | undefined;
  /**
   * How the Item's next Session would start now: on which model (unset when neither its Stage nor
   * its Agent names one). Undefined when no Agent is ready for it, or it has no Stage to run.
   */
  plannedStart(itemId: string): { model?: string } | undefined;
  /**
   * Pauses a Session for a reason other than an Ask (a reached Budget cap): it waits, keeps its
   * slot and worktree, and continues only once every hold is released and no blocking Ask is open.
   */
  hold(id: string, reason: string): void;
  release(id: string, reason: string): void;
  /** Ends a live Session (its Agent stops it; it becomes `stopped`). */
  stop(id: string): void;
  /**
   * For a Project being unregistered: stops its live Sessions (saying `reason` in their Threads),
   * removes the worktrees and branches its Sessions made, and forgets its Sessions.
   */
  removeProject(project: Project, reason: string): Promise<void>;
  /** Shows a Session's live usage on it and its Item. */
  noteUsage(id: string, usage: SessionUsage): void;
  /**
   * A person's Thread message. It goes into the Item's live Session, or resumes its last Session in
   * this Stage while the Agent's cache is warm. Otherwise it is held for the Item's next fresh
   * Session and `undefined` is returned: the caller starts one (through the scheduler), and
   * `start` delivers it. Throws 400 for an empty message and 409 when the Stage runs no Session.
   * With `resume: false` (Stop all is on) no ended Session is resumed.
   */
  message(itemId: string, text: string, options?: { resume?: boolean }): ThreadMessageResult | undefined;
  /** Drops the messages held for an Item's next Session (its start was refused). */
  dropHeld(itemId: string): void;
  /** The Item's Digests and rollups in the Knowledge store, oldest first. */
  digests(itemId: string): Digest[];
  /**
   * What a live Session has made so far, as an opaque mark: the commit its worktree (or the
   * Project) is at plus a hash of the Item's artifacts there. A new commit or an artifact edit
   * changes it. Undefined for a Session that is not live. It reads files only (no git process),
   * so it can be taken the moment a turn is reported.
   */
  progressMark(id: string): string | undefined;
  /**
   * Ends a live Session so its Item can go on in a fresh one (the context alarm): its Agent lets it
   * go, it becomes `stopped`, and a Digest is left behind, Kiln's with `reason` among its open
   * points when the Session wrote none. False when the Session is not live.
   */
  renew(id: string, reason: string): Promise<boolean>;
  /**
   * The Item's worktree is going (its branch merged): lets go of the Agents its finished Sessions
   * kept warm for a follow-up message, and waits (a few seconds at most) until each has stopped, so
   * no Agent process still works in the worktree.
   */
  releaseItem(itemId: string): Promise<void>;
  /**
   * Ends every live Session of a subject (a Scratch chat being archived or deleted) and lets go of
   * the Agents kept warm. With `forget`, drops its Session rows too.
   */
  endItem(itemId: string, forget: boolean): Promise<void>;
}

/** How long releaseItem waits for an Agent to report its Session stopped. */
const RELEASE_WAIT_MS = 10_000;

interface Live {
  info: SessionInfo;
  /** Set for a Session on a local variant: its result is recorded when it ends. */
  local?: { variantId: string; size: TicketSize; startedMs: number; failure?: string; recorded?: boolean };
  /** The Session's Kiln tools credential (in memory only: it dies with the Session or the core). */
  toolsToken: string;
  /** The branch the worktree started from. */
  base: string | null;
  /** Finished events are handled one at a time, in order. */
  queue: Promise<void>;
  /** Stops the Session if the Agent goes quiet after Exit feedback. */
  idleTimer?: ReturnType<typeof setTimeout>;
  /** Whether the Session has written a Digest since it last started or came back. */
  digested: boolean;
  /** Why the Session is paused (saved, so a restart knows whether to resume it). */
  pauseReason?: 'stop_all';
  /** When Stop all paused it (ms), to tell whether its Agent's cache is still warm on resume. */
  pausedAt?: number;
  /**
   * Kiln interrupted the Agent for a blocking Ask, so it needs `agent.resume` once the Asks are
   * answered. A Permission Ask doesn't interrupt: the Agent is already waiting on its answer.
   */
  interrupted: boolean;
  /**
   * Interrupts Kiln sent that the Agent has not answered with an `interrupted` finish yet. Such a
   * finish can arrive after the Session was let go on again (a quick Continue), so it is not an end.
   */
  interruptsSent: number;
}

// An Agent that keeps finishing with its Exit unmet has one bound: the stall rule (runaway.ts). Each
// unmet round with no new commit or artifact change counts as a turn, so after the Admin's stall
// turns (8 by default) the Session pauses behind a Continue / Stop Ask. Nothing is killed.
/** How long Kiln waits for the Agent to act on Exit feedback before stopping it (`KILN_EXIT_IDLE_MS`). */
const EXIT_IDLE_MS = Number(process.env.KILN_EXIT_IDLE_MS) || 15 * 60_000;

interface SessionRow {
  id: string;
  item_id: string;
  project_id: string;
  stage: string;
  role: string;
  agent_id: string;
  widget_id: string;
  model: string | null;
  worktree: string | null;
  branch: string | null;
  base: string | null;
  state: SessionState;
  exit: string | null;
  started_at: string;
  ended_at: string | null;
}

/** States in which a Session is still alive: working, paused by Stop all, or waiting on a blocking Ask. */
const ACTIVE = new Set<SessionState>(['running', 'paused', 'waiting']);

/** States a Thread message can resume a Session from while its Agent's cache is warm. */
const RESUMABLE = new Set<SessionState>(['finished', 'interrupted']);

/** What an Item's Thread holds: its Sessions' events, Exit checks, Digests and Stage moves. */
const THREAD_TYPES = /^(session\.|exit\.checked$|digest\.written$|item\.stage_changed$|item\.from_chat$|chat\.story_made$)/;

const FINISHED_STATE: Record<Exclude<FinishReason, 'completed'>, SessionState> = {
  interrupted: 'interrupted',
  stopped: 'stopped',
  error: 'error',
};

const fromRow = (row: SessionRow): SessionInfo => ({
  id: row.id,
  itemId: row.item_id,
  projectId: row.project_id,
  stage: row.stage,
  role: row.role,
  agentId: row.agent_id,
  widgetId: row.widget_id,
  ...(row.model ? { model: row.model } : {}),
  worktree: row.worktree,
  branch: row.branch,
  state: row.state,
  startedAt: row.started_at,
  ...(row.ended_at ? { endedAt: row.ended_at } : {}),
  ...(row.exit ? { exit: JSON.parse(row.exit) as SessionInfo['exit'] } : {}),
});

const toRun = (info: SessionInfo): ItemRun => ({
  sessionId: info.id,
  stage: info.stage,
  state: info.state,
  worktree: info.worktree,
  branch: info.branch,
  ...(info.exit ? { exit: info.exit } : {}),
  ...(info.usage ? { usage: info.usage } : {}),
});

/** The Stage a Project Thread Session runs in: no worktree, no Exit, and the read-only Policy. */
const THREAD_STAGE: Stage = {
  id: PROJECT_THREAD_STAGE,
  name: 'Project Thread',
  role: PROJECT_THREAD_ROLE,
  policy: PROJECT_THREAD_POLICY,
};

/**
 * A Project's Thread as the Session manager sees it: Item-shaped, so Sessions, Asks and Digests
 * work as they do for Items, but never one of the Project's Items (the Tracker has no record of it).
 */
export const threadSubject = (project: Project): Item => ({
  id: projectThreadId(project.id),
  projectId: project.id,
  key: PROJECT_THREAD_KIND,
  kind: PROJECT_THREAD_KIND,
  title: `${project.name} Project Thread`,
  stage: PROJECT_THREAD_STAGE,
  runState: 'backlog',
  childIds: [],
});

/** The Stage a Scratch chat Session runs in: no worktree, no Exit, and the chat Policy. */
const scratchChatStage = (model?: RoleModel): Stage => ({
  id: CHAT_STAGE,
  name: 'Scratch chat',
  role: CHAT_ROLE,
  policy: CHAT_POLICY,
  ...(model ? { model: model.model } : {}),
  ...(model?.fallbackModel ? { fallbackModel: model.fallbackModel } : {}),
  ...(model?.agent ? { agent: model.agent } : {}),
});

/**
 * A Scratch chat as the Session manager sees it: Item-shaped like `threadSubject`, but with no
 * Project at all (`projectId` is empty and must never be looked up).
 */
export const chatSubject = (chat: Pick<ScratchChat, 'id' | 'title'>): Item => ({
  id: chatThreadId(chat.id),
  projectId: '',
  key: chat.id,
  kind: CHAT_KIND,
  title: chat.title,
  stage: CHAT_STAGE,
  runState: 'backlog',
  childIds: [],
});

/** What a Session's audit entries are about: its Item, or its Project for a Project Thread Session. */
const auditTarget = (info: SessionInfo) =>
  projectOfThread(info.itemId) !== undefined || chatOfThread(info.itemId) !== undefined ? info.itemId : `item:${info.itemId}`;

const readIfExists = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined);

export interface SessionManagerDeps {
  db: DatabaseSync;
  bus: EventBus;
  work: Work;
  widgets: WidgetHost;
  asks: AskService;
  /** Where Digests are written and read back for seeding. */
  knowledge: KnowledgeStore;
  /** The Policy each Session runs under; permission requests are decided against it. */
  policy: PolicyEngine;
  audit: AuditLog;
  dataDir: string;
  /** The Kiln tools endpoint's URL, e.g. `http://127.0.0.1:51234/api/kiln-tools` (known once the core listens). */
  kilnToolsUrl: () => string;
  /** Why no Session may start right now (e.g. a pending Restart when idle), or undefined. */
  startBlocked?: () => string | undefined;
  /** The Project's Item ids waiting in Up next, first to start first (read by Project Thread Sessions). */
  upNext?: (projectId: string) => string[];
  /** A model a person moved this Stage to (e.g. off Fable at its reserve), over the Workflow's. */
  stageModel?: (projectId: string, kind: string, stage: string) => string | undefined;
  /** The id of the Budget a model draws from, if any: it decides which Agent offers a Stage's model. */
  budgetOf?: (model: string) => string | undefined;
  /** Local-first routing (Ticket 07), read when a Session starts. Unset: every Stage runs on its own model. */
  local?: () => { routing: Routing; variants: () => Variant[]; /** Whether local models are set up at all (a server is configured). */ inUse: () => boolean };
  /** Holds Items at Gate Stages once their Exit is met, and seeds rework Sessions. */
  gates?: Gates;
  /** Scratch chats: the chat records, and the model (and fallback) the `chat` role runs on. */
  chats?: { get(id: string): ScratchChat | undefined; folder(id: string): string; roleModel(): RoleModel | undefined };
  /**
   * Scratch chats' side of draft_story: stores a Make it a Story draft for the chat, and throws
   * when none is pending. Unset: a chat's draft_story is always refused.
   */
  draftStory?: (chatId: string, draft: { title: string; description: string }) => void;
  /** The `toolPaths` Setting, read each time a module check or MCP server names a tool. */
  toolPaths?: () => Record<string, string> | undefined;
}

export function createSessionManager({
  db,
  bus,
  work,
  widgets,
  asks,
  knowledge,
  policy,
  audit,
  dataDir,
  kilnToolsUrl,
  startBlocked,
  upNext = () => [],
  stageModel,
  budgetOf,
  gates,
  local,
  draftStory,
  toolPaths = () => undefined,
  chats,
}: SessionManagerDeps): SessionManager {
  const live = new Map<string, Live>();
  /** Why each held Session waits besides its Asks (e.g. a reached Budget cap). */
  const holds = new Map<string, Set<string>>();
  const insert = db.prepare(
    `INSERT INTO sessions (id, item_id, project_id, stage, role, agent_id, widget_id, model, worktree, branch, base, state, exit, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateRow = db.prepare('UPDATE sessions SET state = ?, exit = ?, ended_at = ? WHERE id = ?');
  const updateLive = db.prepare('UPDATE sessions SET interrupted = ?, local_attempt = ?, pause_reason = ? WHERE id = ?');
  const selectAll = db.prepare('SELECT * FROM sessions ORDER BY started_at, id');
  const selectProject = db.prepare('SELECT * FROM sessions WHERE project_id = ?');
  const deleteProject = db.prepare('DELETE FROM sessions WHERE project_id = ?');

  // Sessions a previous core process left alive: their Agent processes are gone, so each one is
  // classified by what it needs to resume from its saved conversation (the resume token).
  //  - paused for a restart, or running when the core stopped unexpectedly (once): marked to resume
  //    (stays `paused` with pause_reason 'restart' / 'crash'; the crash-resume count is spent).
  //  - paused by Stop all: stays paused. Waiting: stays waiting, its Ask stays open.
  //  - no token, or a second unplanned stop: the failed-resume path (the Session ends with an error).
  {
    const now = new Date().toISOString();
    const fail = db.prepare(`UPDATE sessions SET state = 'error', ended_at = ?, failed_resume_count = failed_resume_count + 1 WHERE id = ?`);
    const markResume = db.prepare(`UPDATE sessions SET state = 'paused', pause_reason = ?, crash_resume_count = crash_resume_count + ? WHERE id = ?`);
    const alive = db.prepare(`SELECT id, state, resume_token, pause_reason, crash_resume_count FROM sessions WHERE state IN ('running', 'paused', 'waiting') ORDER BY started_at, id`).all() as unknown as {
      id: string; state: SessionState; resume_token: string | null; pause_reason: string | null; crash_resume_count: number;
    }[];
    for (const row of alive) {
      if (!row.resume_token) fail.run(now, row.id);
      else if (row.state === 'running') {
        if (row.crash_resume_count === 0) markResume.run('crash', 1, row.id);
        else fail.run(now, row.id);
      } else if (row.state === 'paused' && row.pause_reason !== 'stop_all') markResume.run('restart', 0, row.id);
    }
  }
  const latest = new Map<string, SessionInfo>();
  for (const row of selectAll.all() as unknown as SessionRow[]) latest.set(row.item_id, fromRow(row));
  for (const info of latest.values()) work.setRun(info.itemId, toRun(info), { quiet: true });

  const ref = (info: SessionInfo) => ({ sessionId: info.id, itemId: info.itemId, projectId: info.projectId });

  /** Saves a Session's state and shows it on its Item. */
  const save = (info: SessionInfo) => {
    updateRow.run(info.state, info.exit ? JSON.stringify(info.exit) : null, info.endedAt ?? null, info.id);
    const session = live.get(info.id);
    if (session) updateLive.run(session.interrupted ? 1 : 0, session.local ? JSON.stringify(session.local) : null, session.pauseReason ?? null, info.id);
    work.setRun(info.itemId, toRun(info));
    bus.publish('session.updated', { ...ref(info), session: info });
  };

  /** The Item's Stage, on the model a person moved it to if they did. */
  const stageOf = (item: Item): Stage | undefined => {
    if (item.kind === PROJECT_THREAD_KIND) return THREAD_STAGE;
    if (item.kind === CHAT_KIND) return scratchChatStage(chats?.roleModel());
    const stage = work.project(item.projectId)?.workflow.kinds.find((k) => k.id === item.kind)?.stages.find((s) => s.id === item.stage);
    const moved = stage && stageModel?.(item.projectId, item.kind, stage.id);
    return moved ? { ...stage, model: moved } : stage;
  };

  /** What a Session works on: an Item, or the stand-in for a Project's Thread (see `threadSubject`). */
  const subjectOf = (id: string): Item | undefined => {
    const chatId = chatOfThread(id);
    if (chatId !== undefined) {
      const chat = chats?.get(chatId);
      return chat && chatSubject(chat);
    }
    const projectId = projectOfThread(id);
    if (projectId === undefined) return work.item(id);
    const project = work.project(projectId);
    return project && threadSubject(project);
  };

  /**
   * The Agent a Stage's Session runs on: the one it names, else the one that offers its model (runs
   * it, or runs a model of the same Budget), else, when the model is in no Budget, the first ready.
   */
  const pickAgent = (stage: Stage) => {
    const ready = widgets
      .list()
      .filter((w) => w.state === 'ready')
      .flatMap((w) => w.agents.filter((a) => !stage.agent || a.id === stage.agent).map((agent) => ({ widgetId: w.id, agent })));
    const wanted = stage.agent ? undefined : stage.model;
    const budget = wanted ? budgetOf?.(wanted) : undefined;
    // An Agent runs its default model and every model it lists.
    const runs = (agent: (typeof ready)[number]['agent']) => [
      ...(agent.model ? [agent.model] : []),
      ...(agent.models ?? []).map((m) => m.id),
    ];
    const offers =
      ready.find((r) => wanted && runs(r.agent).includes(wanted)) ??
      ready.find((r) => budget && runs(r.agent).some((m) => budgetOf?.(m) === budget));
    if (wanted && budget && !offers) {
      throw new WorkError(409, `No Agent is ready to run the model "${wanted}": none that is ready runs a model of its Budget`);
    }
    const pick = offers ?? ready[0];
    if (!pick) throw new WorkError(409, stage.agent ? `The Agent "${stage.agent}" is not ready` : 'No Agent is ready to run a Session');
    return { widgetId: pick.widgetId, agentId: pick.agent.id, model: stage.model ?? pick.agent.model };
  };

  /**
   * Where the Stage's Session runs (Ticket 07): by its role's mode, a local variant the picker names,
   * or the Stage's own model, with the words the Thread shows. A local-only Project or install, or
   * a local-only role, never runs on cloud: with no variant to run it, the start is refused.
   */
  const planLocal = (item: Item, stage: Stage, project: Project): { stage: Stage; attempt?: Live['local']; note?: string } => {
    if (!local) return { stage };
    const { routing, variants, inUse } = local();
    const mode = readProjectSettings(project.path).localOnly || routing.localOnlyInstall() ? 'local-only' : modeOf(stage);
    if (mode === 'cloud-only') return { stage };
    const role = stage.role!;
    const estimate = item.path ? /\*\*Estimate:\*\*\s*(\w+)/i.exec(readIfExists(join(project.path, item.path)) ?? '')?.[1] : undefined;
    const size = ticketSize(routing.results().filter((r) => r.itemId === item.id), estimate);
    const pick = routing.pick({ role, size, itemId: item.id, variants: variants().map((v) => ({ id: v.id, name: v.name })) });
    if (pick) {
      const variant = variants().find((v) => v.id === pick.variant.id)!;
      return {
        stage: { ...stage, model: variant.serverModelId },
        attempt: { variantId: variant.id, size, startedMs: Date.now() },
        note: `Running locally on ${variant.name} (${size} Ticket): ${pick.reason}`,
      };
    }
    const why = variants().length ? `every enabled variant is cut off for ${size} Tickets` : 'it has no enabled local variant';
    if (mode === 'local-only') throw new WorkError(409, `${item.title}'s ${stage.name} Stage is local only, and ${why}, so it cannot start: no Session runs on a cloud model there`);
    // An install that has not set up local models gets no note: local first is then just cloud.
    if (!inUse() && !variants().length) return { stage };
    return { stage, note: `The ${role} role is local first, but ${why}: running on cloud (${stage.model ?? "the Agent's model"})` };
  };

  /**
   * The Item's own record (with the grill record and spec beside it, for a Story), its parent's,
   * and the parent's spec, read from where the Session works.
   */
  const seedArtifacts = (item: Item, root: string) => {
    const paths: string[] = [];
    if (item.path) {
      paths.push(item.path);
      paths.push(grillPathOf(posix.dirname(item.path)), specPathOf(posix.dirname(item.path)));
    }
    const parent = item.parentId ? work.item(item.parentId) : undefined;
    if (parent?.path) {
      paths.push(parent.path);
      paths.push(posix.join(posix.dirname(parent.path), 'spec.md'));
    }
    const artifacts: { name: string; content: string }[] = [];
    for (const name of new Set(paths)) {
      const content = readIfExists(join(root, name));
      if (content !== undefined) artifacts.push({ name, content });
    }
    return artifacts;
  };

  const chatPrompt = () =>
    [
      'You are a Scratch chat: a person asks you a quick, one-off question. You belong to no Project and no Item.',
      'You change nothing; the Policy denies every write. Answer briefly, and raise an Ask only when you cannot go on without a person.',
      'Before you finish, write your Digest with the write_digest Kiln tool.',
    ].join('\n');

  const threadPrompt = (item: Item) =>
    [
      `You are the Project Thread of the Project "${work.project(item.projectId)?.name ?? item.projectId}": a person talks to you about the Project as a whole.`,
      'You can read everything in the Project: its Items and their artifacts and Digests with your Kiln tools, and its repo, where you are started.',
      'You change nothing yourself; the Policy denies every write. To change something (new Items, a new Up next order), propose it with raise_ask and its "proposal": Kiln applies it only if a person accepts.',
      'Before you finish, write your Digest with the write_digest Kiln tool.',
    ].join('\n');

  const prompt = (item: Item, stage: Stage, rework: { name: string }[]) =>
    item.kind === CHAT_KIND ? chatPrompt() : item.kind === PROJECT_THREAD_KIND ? threadPrompt(item) : itemPrompt(item, stage, rework);

  const itemPrompt = (item: Item, stage: Stage, rework: { name: string }[]) =>
    [
      `You are the ${stage.role} for the ${item.kind} "${item.title}", in its ${stage.name} Stage.`,
      'Its artifacts are attached, with the Digests earlier Sessions left (what they decided, changed and left open).',
      'Work only in your worktree and commit your work.',
      stage.exit?.includes('findings_exist')
        ? `Review the branch's changes against the Ticket. Write your findings to ${findingsPathOf(item)} and commit them.`
        : '',
      stage.exit?.includes('grill_record_exists') && item.path
        ? `Grill the ${item.kind} until its open questions are settled (raise Asks for a person's answers). Write the grill record to ${grillPathOf(posix.dirname(item.path))} and commit it.`
        : '',
      stage.exit?.includes('spec_exists') && item.path
        ? `Write the ${item.kind}'s spec, from its grill record, to ${specPathOf(posix.dirname(item.path))} and commit it.`
        : '',
      stage.exit?.includes('children_exist')
        ? `Split the spec into child Items: create each with the create_child_item Kiln tool (a title and what to build). Kiln writes and commits their records in your worktree.`
        : '',
      rework.length
        ? `This is rework: it was sent back to this Stage. Read the attached ${rework.map((a) => `"${a.name}"`).join(' and ')} and fix what they say.`
        : '',
      'Before you finish, write your Digest with the write_digest Kiln tool: what was decided, what changed and what is still open.',
      stage.exit?.length
        ? `Kiln checks this Stage's Exit itself when you finish (${stage.exit.join(', ')}); saying you are done does not count.`
        : '',
    ]
      .filter(Boolean)
      .join('\n');

  /** Ends a Session Kiln gave up on (its Agent ignored Exit feedback). */
  const giveUp = async (session: Live, why: string) => {
    const { info } = session;
    clearTimeout(session.idleTimer);
    if (!ACTIVE.has(info.state)) return;
    bus.publish('session.message', { ...ref(info), from: 'kiln', text: `Kiln stopped this Session: ${why}` });
    if (session.local) session.local.failure = why;
    stopAgent(info);
    await end(session, 'stopped');
  };

  const send = (info: SessionInfo, text: string, from: 'kiln' | 'person' = 'kiln') => {
    bus.publish('session.message', { ...ref(info), from, text });
    widgets.sendCommand(info.widgetId, { type: 'agent.send_message', sessionId: info.id, message: { kind: 'text', text } });
  };

  /**
   * Whether the Session's Agent still holds its conversation in cache, `since` a time (ms): it is
   * ready and registered a cache lifetime that has not passed. No lifetime means never warm.
   */
  const cacheWarm = (info: SessionInfo, since: number) => {
    const widget = widgets.list().find((w) => w.id === info.widgetId && w.state === 'ready');
    const lifetime = widget?.agents.find((a) => a.id === info.agentId)?.cacheLifetimeMs;
    return lifetime !== undefined && Number.isFinite(since) && Date.now() - since <= lifetime;
  };

  /** Interrupts the Agent's turn (it answers with an `interrupted` finish). */
  const interrupt = (session: Live) => {
    session.interruptsSent++;
    widgets.sendCommand(session.info.widgetId, { type: 'agent.interrupt', sessionId: session.info.id });
  };

  /** Sessions whose Agent was told to let go, and who waits for the Agent's `stopped` finish. */
  const letGo = new Set<string>();
  const stopWaiters = new Map<string, () => void>();

  /** Tells the Agent to let a Session go (its conversation is not coming back). False when its Widget isn't running. */
  const stopAgent = (info: SessionInfo) => {
    letGo.add(info.id);
    try {
      widgets.sendCommand(info.widgetId, { type: 'agent.stop', sessionId: info.id });
      return true;
    } catch {
      // The Agent's Widget is not running: there is nothing to let go.
      return false;
    }
  };

  /** Thread messages waiting for the Item's next fresh Session, by Item id. */
  const held = new Map<string, string[]>();

  /** Chat Digests are runtime data in the chat's own folder, never in the Knowledge store. */
  const chatStores = new Map<string, KnowledgeStore>();
  const knowledgeFor = (item: Item): KnowledgeStore => {
    const chatId = chatOfThread(item.id);
    if (chatId === undefined || !chats) return knowledge;
    let store = chatStores.get(chatId);
    if (!store) chatStores.set(chatId, (store = createMarkdownKnowledgeStore({ root: chats.folder(chatId) })));
    return store;
  };

  /** Writes a Digest for the Session's Item and publishes it (and the rollup it may trigger). */
  const recordDigest = (session: Live, content: DigestContent, writtenBy: Digest['writtenBy']): Digest => {
    const { info } = session;
    const item = subjectOf(info.itemId);
    if (!item) throw new WorkError(404, `The Item "${info.itemId}" is gone`);
    const { digest, rollup } = knowledgeFor(item).writeDigest(item, { sessionId: info.id, stage: info.stage, writtenBy, content });
    session.digested = true;
    for (const written of rollup ? [digest, rollup] : [digest]) {
      bus.publish('digest.written', { itemId: item.id, projectId: item.projectId, sessionId: written.sessionId, digest: written });
    }
    return digest;
  };

  /** What Kiln records for a Session that ended without writing its own Digest. */
  const fallbackDigest = async (session: Live): Promise<DigestContent> => {
    const { info } = session;
    const changed: string[] = [];
    if (info.branch && session.base) {
      const project = work.project(info.projectId);
      const log = project ? await git(project.path, 'log', '--format=%s', `${session.base}..${info.branch}`).catch(() => '') : '';
      changed.push(...log.split('\n').map((s) => s.trim()).filter(Boolean).reverse().map((s) => `Commit: ${s}`));
    }
    return { decided: [], changed, open: [`The Session ended (${info.state}) without writing a Digest; check its Thread and branch.`] };
  };

  /** A local Session's result goes against its variant: a pass once its Exit is met, a fail when it errors or Kiln gave up on it. */
  const recordLocalResult = async (session: Live) => {
    const { info, local: attempt } = session;
    if (!attempt || attempt.recorded || !local) return;
    const failed = info.state === 'error' || (info.state === 'stopped' && attempt.failure !== undefined);
    if (info.state !== 'finished' && !failed) return;
    attempt.recorded = true;
    const wallMs = Math.max(1, Date.parse(info.endedAt ?? new Date().toISOString()) - attempt.startedMs);
    let diff: { diffLines: number; files: number } | undefined;
    if (info.worktree && session.base) {
      try {
        const rows = (await git(info.worktree, 'diff', '--numstat', session.base)).split('\n').map((row) => row.trim()).filter(Boolean);
        const count = (row: string) => row.split(/\s+/).slice(0, 2).reduce((n, c) => n + (Number(c) || 0), 0);
        diff = { files: rows.length, diffLines: rows.reduce((n, row) => n + count(row), 0) };
      } catch {
        // No diff to read: the size history just lacks this attempt.
      }
    }
    const output = info.usage?.outputTokens;
    local().routing.record({
      variantId: attempt.variantId,
      role: info.role,
      size: attempt.size,
      passed: !failed,
      ...(failed ? { reason: attempt.failure ?? (info.state === 'error' ? 'the Session ended in an error' : 'failed') } : {}),
      wallMs,
      ...(output ? { tokensPerSecond: Math.round((output / (wallMs / 1000)) * 10) / 10 } : {}),
      itemId: info.itemId,
      sessionId: info.id,
      ...(diff ?? {}),
    });
  };

  /** Every Session end: save the state, then make sure a Digest is left behind. */
  const end = async (session: Live, state: SessionState, note?: string) => {
    const { info } = session;
    Object.assign(info, { state, endedAt: new Date().toISOString() });
    save(info);
    await recordLocalResult(session);
    if (!session.digested) {
      const digest = await fallbackDigest(session);
      if (note) digest.open.unshift(note);
      recordDigest(session, digest, 'kiln');
    }
  };

  const onFinished = async (session: Live, event: Extract<AgentEvent, { kind: 'finished' }>) => {
    const { info } = session;
    if (!ACTIVE.has(info.state)) return;
    // Kiln asked for the interrupt (Stop all, or a blocking Ask): the Session stays paused or
    // waiting until it is resumed or the Ask is answered.
    if (event.reason === 'interrupted' && session.interruptsSent > 0) {
      session.interruptsSent--;
      return;
    }
    if (event.reason === 'interrupted' && (info.state === 'paused' || info.state === 'waiting')) return;
    if (event.reason !== 'completed') return end(session, FINISHED_STATE[event.reason]);
    const item = subjectOf(info.itemId);
    const stage = item ? stageOf(item) : undefined;
    if (!item || !stage || stage.id !== info.stage) return;
    // A Stage with a worktree always has the built-in checks (no Co-Authored-By trailers), Exit or not.
    const named = stage.exit ?? [];
    if (!named.length && !(info.worktree && session.base)) return end(session, 'finished');
    const project = work.project(info.projectId)!;
    const findingsPath = findingsPathOf(item);
    // A Stage without a worktree has only worktree-free checks (the Workflow validator sees to it).
    const exit = await checkExit(stage.id, named, {
      repo: project.path,
      ...(info.worktree ? { worktree: info.worktree } : {}),
      ...(session.base ? { base: session.base } : {}),
      ...(findingsPath ? { findingsPath } : {}),
      ...(item.path ? { itemDir: posix.dirname(item.path), itemPath: item.path } : {}),
      children: item.childIds.length,
      openBlockingAsks: asks.list({ itemId: item.id }).filter((a) => a.blocking).map((a) => a.question),
      toolPaths: toolPaths(),
    });
    info.exit = exit;
    bus.publish('exit.checked', { ...ref(info), exit });
    if (!exit.met) {
      save(info);
      send(info, exitFeedback(exit));
      // An Agent that ignores the feedback would otherwise hold its slot for ever.
      // (A Session paused by Stop all or waiting on an Ask is not idle.)
      session.idleTimer = setTimeout(() => {
        if (info.state !== 'running') return;
        giveUp(session, `the Agent did nothing for ${Math.round(EXIT_IDLE_MS / 1000)}s after Exit feedback`).catch((err: unknown) => {
          bus.publish('session.message', { ...ref(info), from: 'kiln', text: `Kiln could not stop the Session: ${String(err)}` });
        });
      }, EXIT_IDLE_MS);
      session.idleTimer.unref?.();
      return;
    }
    // A Stage with no Exit of its own ends as before once the built-in checks pass.
    if (!named.length) return end(session, 'finished');
    await end(session, 'finished');
    if (stage.gate && gates && session.base) await gates.raise(info, session.base);
    else if (stage.mergeOnExit && gates && info.worktree) await gates.mergeOnExit(info);
    else await work.advance(info.itemId);
  };

  widgets.routeAgentEvents((widgetId, report: AgentEventReport) => {
    const session = live.get(report.sessionId);
    if (!session) return false;
    // Only the Widget running a Session reports for it (the refusal is audited with the call).
    if (session.info.widgetId !== widgetId) {
      throw new WidgetHostError(403, `The Widget "${widgetId}" does not run the Session "${session.info.id}"`, 'session');
    }
    const { event } = report;
    clearTimeout(session.idleTimer);
    bus.publish(`session.${event.kind}`, { ...event, ...ref(session.info) });
    // An Agent that reports its Digest as an event (not through write_digest) gets it stored too.
    if (event.kind === 'digest_written' && event.digest.trim()) {
      recordDigest(session, { decided: [], changed: [], open: [], summary: event.digest.trim() }, 'session');
    }
    if (event.kind === 'permission_request') onPermissionRequest(session, event);
    if (event.kind === 'finished' && event.reason === 'stopped') stopWaiters.get(session.info.id)?.();
    if (event.kind === 'finished') {
      session.queue = session.queue
        .then(() => onFinished(session, event))
        .catch((err: unknown) => {
          bus.publish('session.message', { ...ref(session.info), from: 'kiln', text: `Kiln could not finish the Stage: ${String(err)}` });
        });
    }
    return true;
  });

  /** Raises an Ask on the Session's own Item. A blocking one pauses the Session until it is answered. */
  const raiseAsk = (session: Live, request: RaiseAskRequest & { proposal?: unknown }): Ask => {
    const { info } = session;
    const ask = asks.raise({ ...request, itemId: info.itemId, raisedBy: { kind: 'session', sessionId: info.id } });
    if (ask.blocking && info.state === 'running') {
      info.state = 'waiting';
      session.interrupted = true;
      save(info);
      interrupt(session);
    }
    return ask;
  };

  const scopeOf = (info: SessionInfo): PolicyScope | undefined => {
    const project = work.project(info.projectId);
    const item = subjectOf(info.itemId);
    return project && item ? { project, kind: item.kind, stage: info.stage } : undefined;
  };

  const answerPermission = (info: SessionInfo, requestId: string, decision: 'allow' | 'deny') =>
    widgets.sendCommand(info.widgetId, {
      type: 'agent.send_message',
      sessionId: info.id,
      message: { kind: 'permission_answer', requestId, decision },
    });

  /**
   * An Agent asked to do something. The Policy decides allow and deny at once (audited as Kiln);
   * for "ask" (or an action Kiln doesn't know) a person answers a blocking Permission Ask. The
   * Agent is waiting on its answer already, so the Session waits without being interrupted.
   */
  const onPermissionRequest = (session: Live, event: Extract<AgentEvent, { kind: 'permission_request' }>) => {
    const { info } = session;
    const { requestId, action, detail } = event;
    try {
      const chat = chatOfThread(info.itemId) !== undefined;
      const scope = chat ? undefined : scopeOf(info);
      if (!chat && !scope) throw new Error(`the Item "${info.itemId}" is gone`);
      // Nothing Kiln runs commits a Co-Authored-By trailer, whatever the Policy or an "Always allow"
      // says: refused before anyone is asked, and the Agent is told how to do it instead.
      if (CO_AUTHORED_BY.test(detail)) {
        audit.record({
          actor: { kind: 'kiln' },
          action: 'permission.deny',
          target: auditTarget(info),
          outcome: 'refused',
          detail: { sessionId: info.id, action, detail, by: 'no_coauthor_trailers' },
        });
        bus.publish('session.message', {
          ...ref(info),
          from: 'kiln',
          text: 'Kiln refused that command: it adds a Co-Authored-By trailer, which Kiln never commits. Run it again without the trailer, and add no attribution lines to any commit or pull request.',
        });
        answerPermission(info, requestId, 'deny');
        return;
      }
      const known = isPolicyAction(action);
      // A Project Thread or chat Session never leaves anything to a person: what its Policy doesn't name is denied.
      const thread = chat || projectOfThread(info.itemId) !== undefined;
      const decision = known ? decide(chat ? policy.chat() : policy.effective(scope!), action, detail) : thread ? 'deny' : 'ask';
      if (decision !== 'ask') {
        audit.record({
          actor: { kind: 'kiln' },
          action: `permission.${decision}`,
          target: auditTarget(info),
          outcome: decision === 'allow' ? 'allowed' : 'refused',
          detail: { sessionId: info.id, action, detail, by: 'policy' },
        });
        answerPermission(info, requestId, decision);
        return;
      }
      const rule = isPolicyAction(action) ? alwaysAllowMatch(action, detail) : undefined;
      const offered = isPolicyAction(action) && rule !== undefined && policy.alwaysAllowOffered(scope!, action, detail);
      const label = known ? POLICY_ACTION_NAMES[action] : action;
      const saves = offered && rule !== detail ? ` Always allow saves the rule "${rule}".` : '';
      asks.raise({
        type: 'permission',
        question: `${label}: ${detail}?`,
        why: `The ${info.role} wants to do this, and the Policy says to ask first. The Session waits for your answer.${saves}`,
        recommendation: PERMISSION_ANSWERS.once,
        options: [PERMISSION_ANSWERS.once, ...(offered ? [PERMISSION_ANSWERS.always] : []), PERMISSION_ANSWERS.deny],
        blocking: true,
        itemId: info.itemId,
        raisedBy: { kind: 'session', sessionId: info.id },
        permission: { sessionId: info.id, requestId, action, detail },
      });
      if (info.state === 'running') {
        info.state = 'waiting';
        save(info);
      }
    } catch (err) {
      bus.publish('session.message', { ...ref(info), from: 'kiln', text: `Kiln refused "${detail}": ${String(err)}` });
      answerPermission(info, requestId, 'deny');
    }
  };

  asks.setRecipient('session', {
    reaches: (raiser) => raiser.kind === 'session' && ACTIVE.has(live.get(raiser.sessionId)?.info.state as SessionState),
    prepare(ask, answer) {
      // "Always allow" writes its rule first, so an answer that can't be kept is refused (409).
      if (!ask.permission || answer !== PERMISSION_ANSWERS.always) return;
      const info = live.get(ask.permission.sessionId)?.info;
      const scope = info && scopeOf(info);
      const { action, detail } = ask.permission;
      const match = isPolicyAction(action) ? alwaysAllowMatch(action, detail) : undefined;
      if (!scope || !isPolicyAction(action) || match === undefined || !policy.alwaysAllowOffered(scope, action, detail)) {
        throw new WorkError(409, 'The Org or Stage Policy no longer lets this Project always allow it');
      }
      policy.alwaysAllow(scope.project, { action, match });
    },
    deliver(ask, changed) {
      if (ask.raisedBy.kind !== 'session' || ask.answer === undefined) return;
      const session = live.get(ask.raisedBy.sessionId);
      if (!session) return;
      const { info } = session;
      const text = `${changed ? 'Changed answer' : 'Answer'} to "${ask.question}": ${ask.answer}`;
      bus.publish('session.message', { ...ref(info), from: 'person', text, askId: ask.id });
      if (ask.permission) {
        const decision = ask.answer === PERMISSION_ANSWERS.deny ? 'deny' : 'allow';
        const kind = ask.answer === PERMISSION_ANSWERS.always ? 'always_allow' : decision === 'deny' ? 'deny' : 'allow_once';
        audit.record({
          actor: ask.answeredBy ?? { kind: 'kiln' },
          action: `permission.${kind}`,
          target: auditTarget(info),
          outcome: decision === 'allow' ? 'allowed' : 'refused',
          detail: { sessionId: info.id, action: ask.permission.action, detail: ask.permission.detail, askId: ask.id },
        });
        answerPermission(info, ask.permission.requestId, decision);
      } else {
        widgets.sendCommand(info.widgetId, {
          type: 'agent.send_message',
          sessionId: info.id,
          message: { kind: 'ask_answer', askId: ask.id, answer: ask.answer, changed },
        });
      }
      if (info.state === 'waiting' && !holds.has(info.id) && asks.openBlocking(info.id).length === 0) {
        info.state = 'running';
        save(info);
        if (session.interrupted) widgets.sendCommand(info.widgetId, { type: 'agent.resume', sessionId: info.id });
        session.interrupted = false;
      }
    },
  });

  /** A Project Thread Session's tools: any Item of its Project, read-only, from the default branch's checkout. */
  const projectScope = (session: Live): ProjectToolsScope => {
    const { info } = session;
    const project = () => {
      const found = work.project(info.projectId);
      if (!found) throw new WorkError(404, `The Project "${info.projectId}" is gone`);
      return found;
    };
    const item = (itemId: string) => {
      const found = typeof itemId === 'string' ? work.item(itemId) : undefined;
      if (!found || found.projectId !== info.projectId) throw new WorkError(404, `No Item "${itemId}" in this Project`);
      return found;
    };
    return {
      kind: 'project',
      overview: () => {
        const { id, name } = project();
        return { project: { id, name }, items: work.items(id), upNext: upNext(id) };
      },
      item,
      artifacts: (itemId) => seedArtifacts(item(itemId), project().path),
      digests: (itemId) => knowledge.seed(item(itemId)).map(knowledge.render),
      raiseAsk: (request) => raiseAsk(session, request),
      writeDigest: (input) => recordDigest(session, digestContent(input), 'session'),
    };
  };

  /** A Scratch chat Session's tools: every Project, read-only, from each default branch's checkout. */
  const chatScope = (session: Live, chatId: string): ChatToolsScope => {
    const projectOf = (projectId: string) => {
      const found = work.project(projectId);
      if (!found) throw new WorkError(404, `No Project "${projectId}"`);
      return found;
    };
    const item = (itemId: string) => {
      const found = typeof itemId === 'string' ? work.item(itemId) : undefined;
      if (!found) throw new WorkError(404, `No Item "${itemId}"`);
      return found;
    };
    return {
      kind: 'chat',
      projects: () => work.projects().map(({ id, name }) => ({ id, name })),
      items: (projectId) => (projectOf(projectId), work.items(projectId)),
      item,
      artifacts: (itemId) => seedArtifacts(item(itemId), projectOf(item(itemId).projectId).path),
      digests: (itemId) => knowledge.seed(item(itemId)).map(knowledge.render),
      raiseAsk: (request) => raiseAsk(session, request),
      writeDigest: (input) => recordDigest(session, digestContent(input), 'session'),
      draftStory: (draft) => {
        if (!draftStory) throw new Error('No Make it a Story draft is pending for this chat');
        draftStory(chatId, draft);
      },
    };
  };

  const list = (): SessionInfo[] => {
    const rows = (selectAll.all() as unknown as SessionRow[]).map(fromRow);
    return rows.map((row) => live.get(row.id)?.info ?? row);
  };

  return {
    async start(itemId) {
      const item = subjectOf(itemId);
      if (!item) throw new WorkError(404, `No Item "${itemId}"`);
      const blocked = startBlocked?.();
      if (blocked) throw new WorkError(409, blocked);
      const chat = chatOfThread(itemId) !== undefined;
      // A chat belongs to no Project: there is nothing to look up.
      const project = chat ? undefined : work.project(item.projectId)!;
      const stage = stageOf(item);
      if (!stage?.role) throw new WorkError(409, `${item.title} is in a Stage that runs no Session`);
      if (project && item.path && !existsSync(join(project.path, item.path))) {
        throw new WorkError(409, `${item.title} is still being written in its parent's worktree; it can start once its parent's Gate merges it`);
      }
      if ([...live.values()].some((s) => s.info.itemId === itemId && ACTIVE.has(s.info.state))) {
        throw new WorkError(409, `${item.title} already has a running Session`);
      }
      const planned: ReturnType<typeof planLocal> = project ? planLocal(item, stage, project) : { stage };
      const { widgetId, agentId, model } = pickAgent(planned.stage);
      // Never the Agent tool's own default: the Budget guard holds such an Item before it gets here.
      if (!model) throw new WorkError(409, `${item.title}'s ${stage.name} Stage names no model, and neither does its Agent`);
      const sessionPolicy = project ? policy.effective({ project, kind: item.kind, stage: stage.id }) : policy.chat();
      // The Project's modules as they stand now: the Session keeps these skills and servers to the end.
      const kit = project ? moduleSessionKit(readProjectFiles(project.path).modules, toolPaths()) : { skills: [], mcpServers: {} };
      // A chat's Session runs in its own empty scratch folder (never a checkout, never a git repo).
      const scratch = chat ? chats!.folder(chatOfThread(itemId)!) : null;
      let worktree: string | null = null;
      let branch: string | null = null;
      let base: string | null = null;
      if (project && stage.worktree) {
        base = await defaultBranch(project.path);
        branch = `kiln/${item.key}`;
        worktree = worktreePath(dataDir, project.id, item.key);
        await ensureWorktree(project.path, worktree, branch, base);
      }
      const previous = list().filter((s) => s.itemId === itemId).at(-1);
      const rework = chat ? [] : (gates?.reworkSeed(itemId, previous?.startedAt) ?? []);
      const info: SessionInfo = {
        id: `s-${randomUUID()}`,
        itemId,
        projectId: project?.id ?? '',
        stage: stage.id,
        role: stage.role,
        agentId,
        widgetId,
        ...(model ? { model } : {}),
        worktree,
        branch,
        state: 'running',
        startedAt: new Date().toISOString(),
      };
      insert.run(info.id, itemId, info.projectId, stage.id, stage.role, agentId, widgetId, model ?? null, worktree, branch, base, 'running', null, info.startedAt, null);
      const toolsToken = randomBytes(32).toString('base64url');
      live.set(info.id, { info, toolsToken, base, queue: Promise.resolve(), digested: false, interrupted: false, interruptsSent: 0, ...(planned.attempt ? { local: planned.attempt } : {}) });
      work.setRun(itemId, toRun(info));
      bus.publish('session.started', { ...ref(info), session: info });
      if (planned.note) bus.publish('session.message', { ...ref(info), from: 'kiln', text: planned.note });
      widgets.sendCommand(widgetId, {
        type: 'agent.start_session',
        agentId,
        session: {
          sessionId: info.id,
          role: stage.role,
          model,
          prompt: prompt(item, stage, rework),
          seed: {
            artifacts: project ? [...seedArtifacts(item, worktree ?? project.path), ...rework] : [],
            digests: (() => { const store = knowledgeFor(item); return store.seed(item).map((d) => store.render(d)); })(),
          },
          worktree: scratch ?? worktree,
          kilnTools: { url: kilnToolsUrl(), headers: { authorization: `Bearer ${toolsToken}` } },
          policy: sessionPolicy,
          ...(kit.skills.length ? { skills: kit.skills } : {}),
          ...(Object.keys(kit.mcpServers).length ? { mcpServers: kit.mcpServers } : {}),
        },
      });
      for (const text of held.get(itemId) ?? []) send(info, text, 'person');
      held.delete(itemId);
      return info;
    },
    message(itemId, text, { resume = true } = {}) {
      const item = subjectOf(itemId);
      if (!item) throw new WorkError(404, `No Item "${itemId}"`);
      if (typeof text !== 'string' || !text.trim()) throw new WorkError(400, 'A Thread message needs some text');
      const stage = stageOf(item);
      if (!stage?.role) throw new WorkError(409, `${item.title} is in a Stage that runs no Session`);
      const current = [...live.values()].find((s) => s.info.itemId === itemId && ACTIVE.has(s.info.state));
      if (current) {
        send(current.info, text, 'person');
        return { delivery: 'running', sessionId: current.info.id };
      }
      // The Item's last Session in this Stage, if it ended in a way its Agent can pick up again.
      const last = [...live.values()].filter((s) => s.info.itemId === itemId && s.info.stage === item.stage).at(-1);
      if (last && RESUMABLE.has(last.info.state)) {
        if (resume && !letGo.has(last.info.id) && cacheWarm(last.info, Date.parse(last.info.endedAt!))) {
          const { info } = last;
          info.state = 'running';
          delete info.endedAt;
          last.digested = false;
          save(info);
          send(info, text, 'person');
          return { delivery: 'resumed', sessionId: info.id };
        }
        // Its cache has gone cold: the fresh Session starts from Digests, so the old one is let go.
        if (resume) stopAgent(last.info);
      }
      held.set(itemId, [...(held.get(itemId) ?? []), text]);
      return undefined;
    },
    dropHeld: (itemId) => void held.delete(itemId),
    progressMark(id) {
      const info = live.get(id)?.info;
      const item = info && work.item(info.itemId);
      const project = info && work.project(info.projectId);
      if (!info || !item || !project) return undefined;
      const root = info.worktree ?? project.path;
      const hash = createHash('sha256');
      for (const artifact of seedArtifacts(item, root)) hash.update(`${artifact.name}\u0000${artifact.content}\u0000`);
      return `${readHead(root) ?? ''} ${hash.digest('hex')}`;
    },
    async releaseItem(itemId) {
      const warm = [...live.values()].filter((s) => s.info.itemId === itemId && s.info.state === 'finished' && !letGo.has(s.info.id));
      await Promise.all(
        warm.map(
          ({ info }) =>
            new Promise<void>((done) => {
              const timer = setTimeout(finish, RELEASE_WAIT_MS);
              function finish() {
                clearTimeout(timer);
                stopWaiters.delete(info.id);
                done();
              }
              stopWaiters.set(info.id, finish);
              if (!stopAgent(info)) finish();
            }),
        ),
      );
    },
    async endItem(itemId, forget) {
      const sessions = [...live.values()].filter((s) => s.info.itemId === itemId);
      for (const session of sessions) {
        const { info } = session;
        clearTimeout(session.idleTimer);
        holds.delete(info.id);
        await session.queue;
        if (!ACTIVE.has(info.state)) continue;
        stopAgent(info);
        await end(session, 'stopped', 'The chat was archived');
      }
      await this.releaseItem(itemId);
      if (forget) {
        for (const session of sessions) live.delete(session.info.id);
        db.prepare('DELETE FROM sessions WHERE item_id = ?').run(itemId);
      }
    },
    async renew(id, reason) {
      const session = live.get(id);
      if (!session || !ACTIVE.has(session.info.state)) return false;
      holds.delete(id);
      stopAgent(session.info);
      await end(session, 'stopped', reason);
      return true;
    },
    digests(itemId) {
      const item = subjectOf(itemId);
      if (!item) throw new WorkError(404, `No Item "${itemId}"`);
      return knowledgeFor(item).digests(item);
    },
    kilnTools(token) {
      const session = [...live.values()].find((s) => s.toolsToken === token);
      if (!session || !ACTIVE.has(session.info.state)) return undefined;
      const { info } = session;
      const chatId = chatOfThread(info.itemId);
      if (chatId !== undefined) return { session: info, scope: chatScope(session, chatId) };
      if (projectOfThread(info.itemId) !== undefined) return { session: info, scope: projectScope(session) };
      const item = () => {
        const found = subjectOf(info.itemId);
        if (!found) throw new WorkError(404, `The Item "${info.itemId}" is gone`);
        return found;
      };
      const scope: KilnToolsScope = {
        kind: 'item',
        item,
        artifacts: () => seedArtifacts(item(), info.worktree ?? work.project(info.projectId)!.path),
        raiseAsk: (request) => raiseAsk(session, request),
        writeDigest: (input) => recordDigest(session, digestContent(input), 'session'),
      };
      const stage = stageOf(item());
      const childKind = work.project(info.projectId)?.workflow.kinds.find((k) => k.parentKind === item().kind);
      if (stage?.id === info.stage && stage.exit?.includes('children_exist') && info.worktree && childKind) {
        const checkout = info.worktree;
        scope.createChild = (input) =>
          work.createItem(info.projectId, { kind: childKind.id, parentId: info.itemId, ...input }, { checkout });
      }
      return { session: info, scope };
    },
    pause(id) {
      const session = live.get(id);
      if (!session || session.info.state !== 'running') return;
      const { info } = session;
      info.state = 'paused';
      session.pausedAt = Date.now();
      session.pauseReason = 'stop_all';
      save(info);
      interrupt(session);
    },
    async resume(id) {
      const session = live.get(id);
      if (!session || session.info.state !== 'paused') return undefined;
      const { info } = session;
      // Held while Stop all paused it: it goes on waiting for its hold, still interrupted.
      if (holds.has(id)) {
        info.state = 'waiting';
        save(info);
        return 'resumed';
      }
      if (!cacheWarm(info, session.pausedAt ?? Date.now())) {
        // Paused past its Agent's cache lifetime: a fresh Session from Digests is cheaper than resuming.
        stopAgent(info);
        await end(session, 'stopped');
        return 'expired';
      }
      info.state = 'running';
      session.pauseReason = undefined;
      save(info);
      widgets.sendCommand(info.widgetId, { type: 'agent.resume', sessionId: id });
      return 'resumed';
    },
    plannedModel(itemId) {
      const item = subjectOf(itemId);
      const stage = item ? stageOf(item) : undefined;
      if (!stage) return undefined;
      if (stage.model) return stage.model;
      try {
        return pickAgent(stage).model;
      } catch {
        return undefined;
      }
    },

    plannedStart(itemId) {
      const item = subjectOf(itemId);
      const stage = item ? stageOf(item) : undefined;
      if (!stage) return undefined;
      try {
        const { model } = pickAgent(stage);
        return model ? { model } : {};
      } catch {
        return undefined;
      }
    },
    hold(id, reason) {
      const session = live.get(id);
      const info = session?.info;
      if (!session || !info || !ACTIVE.has(info.state)) return;
      const reasons = holds.get(id) ?? new Set<string>();
      reasons.add(reason);
      holds.set(id, reasons);
      if (info.state !== 'running') return;
      info.state = 'waiting';
      save(info);
      interrupt(session);
    },
    release(id, reason) {
      const reasons = holds.get(id);
      if (!reasons?.delete(reason)) return;
      if (reasons.size) return;
      holds.delete(id);
      const info = live.get(id)?.info;
      if (!info || info.state !== 'waiting' || asks.openBlocking(id).length) return;
      info.state = 'running';
      save(info);
      widgets.sendCommand(info.widgetId, { type: 'agent.resume', sessionId: id });
    },
    stop(id) {
      holds.delete(id);
      const info = live.get(id)?.info;
      if (!info || !ACTIVE.has(info.state)) return;
      widgets.sendCommand(info.widgetId, { type: 'agent.stop', sessionId: id });
    },
    async removeProject(project, reason) {
      const sessions = [...live.values()].filter((s) => s.info.projectId === project.id);
      for (const session of sessions) {
        const { info } = session;
        clearTimeout(session.idleTimer);
        holds.delete(info.id);
        await session.queue;
        if (!ACTIVE.has(info.state)) continue;
        bus.publish('session.message', { ...ref(info), from: 'kiln', text: `Kiln stopped this Session: ${reason}` });
        stopAgent(info);
        await end(session, 'stopped', reason);
      }
      // Every worktree and branch Kiln made for the Project: one per Item, named by its Sessions.
      const rows = selectProject.all(project.id) as unknown as SessionRow[];
      const made = new Map(rows.filter((r) => r.worktree && r.branch).map((r) => [r.worktree!, r.branch!]));
      for (const [worktree, branch] of made) {
        if (existsSync(worktree)) await git(project.path, 'worktree', 'remove', '--force', worktree).catch(() => undefined);
        await git(project.path, 'worktree', 'prune').catch(() => undefined);
        // Unmerged work goes too: the Project is leaving Kiln.
        await git(project.path, 'branch', '-D', branch).catch(() => undefined);
      }
      rmSync(join(dataDir, 'worktrees', project.id), { recursive: true, force: true });
      for (const session of sessions) live.delete(session.info.id);
      deleteProject.run(project.id);
    },
    noteUsage(id, usage) {
      const info = live.get(id)?.info;
      if (!info) return;
      info.usage = usage;
      // Shown on the Item (item.updated); the Thread already has the turn, so no session.updated.
      work.setRun(info.itemId, toRun(info));
    },
    active: () => [...live.values()].map((s) => s.info).filter((info) => ACTIVE.has(info.state)),
    sessions: (itemId) => list().filter((s) => !itemId || s.itemId === itemId),
    session: (id) => list().find((s) => s.id === id),
    thread: (itemId) => bus.withPayload('itemId', itemId).filter((e) => THREAD_TYPES.test(e.type)) as ThreadEntry[],
    async idle() {
      await Promise.all([...live.values()].map((s) => s.queue));
    },
    running: () => [...live.values()].map((s) => s.info).filter((info) => info.state === 'running'),
  };
}
