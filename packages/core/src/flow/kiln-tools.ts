// The Kiln tools: the MCP server the core offers every Session, scoped to that Session's own Item,
// or, for a Project Thread Session, to its Project read-only.
//
// Transport: MCP Streamable HTTP, answered with plain JSON (no server-initiated stream).
//   POST /api/kiln-tools   one JSON-RPC message; requests get a JSON-RPC response, notifications 202
//   GET  /api/kiln-tools   405 (Kiln never pushes messages to the client)
// The caller is the Session itself, by the bearer credential in SessionStart.kilnTools.headers.
// An Item's Session gets tools that take no Item id: every tool acts on the Session's own Item, so
// it cannot reach another Item through them. A Project Thread Session gets read tools that take
// any Item id in its Project (and none outside it), and no tool that writes to the Project: it
// proposes changes through raise_ask's `proposal`, which Kiln applies only when a person accepts.
import { ASK_TYPES, projectOfThread, PROPOSAL_KINDS, type Ask, type Digest, type Item, type Project, type Proposal, type RaiseAskRequest, type SessionInfo } from '@kiln/widget-sdk';

export const KILN_TOOLS_PATH = '/api/kiln-tools';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/** What an Item's Session's tools act on: the Session and its Item. */
export interface ItemToolsScope {
  kind: 'item';
  item(): Item;
  /** The Item's artifacts, read from where the Session works. */
  artifacts(): { name: string; content: string }[];
  /** Raises an Ask on the Item; a blocking one pauses the Session. Throws on a bad request. */
  raiseAsk(request: RaiseAskRequest): Ask;
  /** Writes the Session's Digest to the Knowledge store. Throws on a bad input. */
  writeDigest(input: unknown): Digest;
  /**
   * Creates a child Item of the Session's Item in the Session's worktree (a Story's Ticket), when its
   * Stage's Exit asks for children; unset otherwise, and the create_child_item tool is not offered.
   */
  createChild?(input: { title: string; description?: string }): Promise<Item>;
}

/** What a Project Thread Session's tools act on: its Project, read-only. Each throws for an Item outside it. */
export interface ProjectToolsScope {
  kind: 'project';
  overview(): { project: Pick<Project, 'id' | 'name'>; items: Item[]; upNext: string[] };
  item(itemId: string): Item;
  artifacts(itemId: string): { name: string; content: string }[];
  /** The Item's Digests as markdown, oldest first (a rollup stands in for the Digests it covers). */
  digests(itemId: string): string[];
  /** Raises an Ask on the Project Thread, carrying a proposal when it has one. */
  raiseAsk(request: RaiseAskRequest & { proposal?: Proposal }): Ask;
  writeDigest(input: unknown): Digest;
}

export type KilnToolsScope = ItemToolsScope | ProjectToolsScope;

interface ToolResult {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface Tool<S> {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Whether the Session gets this tool. Unset: always. */
  offered?(scope: S): boolean;
  call(scope: S, input: Record<string, unknown>): ToolResult | Promise<ToolResult>;
}

const text = (value: string, structured?: Record<string, unknown>): ToolResult => ({
  content: [{ type: 'text', text: value }],
  ...(structured ? { structuredContent: structured } : {}),
});

const ASK_PROPERTIES = {
  type: { type: 'string', enum: [...ASK_TYPES] },
  question: { type: 'string', description: 'What the person is asked.' },
  why: { type: 'string', description: 'Why it matters: what depends on the answer.' },
  recommendation: { type: 'string', description: 'The answer you recommend.' },
  options: { type: 'array', items: { type: 'string' }, description: 'Answers to pick from, if there is a fixed set.' },
  blocking: { type: 'boolean', description: 'Whether you must wait for the answer.' },
};

const askRaised = (ask: Ask): ToolResult =>
  text(
    ask.blocking
      ? `Ask ${ask.id} raised. Kiln has paused this Session until a person answers; the answer arrives as a message. Stop here and wait.`
      : `Ask ${ask.id} raised. Carry on with your recommendation (${ask.recommendation}). If the person answers differently, the answer arrives as a message.`,
    { askId: ask.id, blocking: ask.blocking, recommendation: ask.recommendation, state: ask.state },
  );

/** What a Session sees of an Item. */
const itemView = (item: Item) => ({
  id: item.id,
  kind: item.kind,
  title: item.title,
  stage: item.stage,
  runState: item.runState,
  ...(item.status !== undefined ? { status: item.status } : {}),
  ...(item.description !== undefined ? { description: item.description } : {}),
  ...(item.parentId !== undefined ? { parentId: item.parentId } : {}),
  ...(item.childIds.length ? { childIds: item.childIds } : {}),
  ...(item.path !== undefined ? { path: item.path } : {}),
});

const artifactsResult = (all: { name: string; content: string }[], name: unknown): ToolResult => {
  if (typeof name === 'string') {
    const one = all.find((a) => a.name === name);
    if (!one) return { ...text(`No artifact "${name}". Artifacts: ${all.map((a) => a.name).join(', ')}`), isError: true };
    return text(one.content, { artifacts: [one] });
  }
  return text(all.map((a) => `--- ${a.name}\n${a.content}`).join('\n'), { artifacts: all });
};

const writeDigestTool: Tool<KilnToolsScope> = {
  name: 'write_digest',
  title: 'Write your Digest',
  description:
    'Record what this Session decided, what it changed and what is still open, before you finish. The next Session starts from Digests, not from this conversation, so write what it needs to know. One short line per entry. Writing again adds a newer Digest.',
  inputSchema: {
    type: 'object',
    properties: {
      decided: { type: 'array', items: { type: 'string' }, description: 'Decisions made, and why when it matters.' },
      changed: { type: 'array', items: { type: 'string' }, description: 'What changed: files, behaviour, commits.' },
      open: { type: 'array', items: { type: 'string' }, description: 'What is still open or unresolved.' },
      summary: { type: 'string', description: 'Optional free text.' },
    },
    required: ['decided', 'changed', 'open'],
  },
  call(scope, input) {
    const digest = scope.writeDigest(input);
    return text(`Digest ${digest.id} written to ${digest.path}.`, { digestId: digest.id, path: digest.path });
  },
};

const ITEM_TOOLS: Tool<ItemToolsScope>[] = [
  {
    name: 'raise_ask',
    title: 'Raise an Ask',
    description:
      "Ask a person for input on your Item. Say why it matters and what you recommend. A blocking Ask pauses you until it is answered; a non-blocking one lets you carry on with your recommendation (if the person answers differently later, the answer arrives as a message). Permission Asks always block.",
    inputSchema: { type: 'object', properties: ASK_PROPERTIES, required: ['type', 'question', 'why', 'recommendation', 'blocking'] },
    call: (scope, input) => askRaised(scope.raiseAsk(input as unknown as RaiseAskRequest)),
  },
  {
    name: 'read_item',
    title: 'Read your Item',
    description: 'Your Item: its kind, title, Stage, Status, description and parent.',
    inputSchema: { type: 'object', properties: {} },
    call(scope) {
      const view = itemView(scope.item());
      return text(JSON.stringify(view), view);
    },
  },
  {
    name: 'read_artifacts',
    title: "Read your Item's artifacts",
    description: "Your Item's artifacts (its record, its parent's record and the parent's spec), as in your worktree. Give a name to read just one.",
    inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
    call: (scope, input) => artifactsResult(scope.artifacts(), input.name),
  },
  {
    name: 'create_child_item',
    title: 'Create a child Item',
    description:
      "Create one child Item of your Item (a Ticket of your Story): a short title and what to build. Kiln writes and commits its record in your worktree; it shows on the boards at once and starts once your Stage's Gate is approved.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'A short title.' },
        description: { type: 'string', description: 'What to build, in a sentence or two.' },
      },
      required: ['title'],
    },
    offered: (scope) => scope.createChild !== undefined,
    async call(scope, input) {
      if (typeof input.title !== 'string' || !input.title.trim()) throw new Error('A child Item needs a title');
      const description = typeof input.description === 'string' ? input.description : undefined;
      const child = await scope.createChild!({ title: input.title, ...(description ? { description } : {}) });
      return text(`Created ${child.kind} ${child.key}: ${child.title} (${child.path}).`, { itemId: child.id, key: child.key, path: child.path });
    },
  },
  writeDigestTool,
];

const ITEM_ID = { itemId: { type: 'string', description: 'An Item id from read_project.' } };

const PROJECT_TOOLS: Tool<ProjectToolsScope>[] = [
  {
    name: 'read_project',
    title: 'Read the Project',
    description: 'The Project and every one of its Items (kind, title, Stage, run state, parent and children), and the Item ids waiting in Up next, first to start first.',
    inputSchema: { type: 'object', properties: {} },
    call(scope) {
      const { project, items, upNext } = scope.overview();
      const view = { project, items: items.map(itemView), upNext };
      return text(JSON.stringify(view), view);
    },
  },
  {
    name: 'read_item',
    title: 'Read an Item',
    description: "One of the Project's Items: its kind, title, Stage, Status, description, parent and children.",
    inputSchema: { type: 'object', properties: ITEM_ID, required: ['itemId'] },
    call(scope, input) {
      const view = itemView(scope.item(String(input.itemId ?? '')));
      return text(JSON.stringify(view), view);
    },
  },
  {
    name: 'read_artifacts',
    title: "Read an Item's artifacts",
    description: "An Item's artifacts (its record, its parent's record and the parent's spec), as on the default branch. Give a name to read just one.",
    inputSchema: { type: 'object', properties: { ...ITEM_ID, name: { type: 'string' } }, required: ['itemId'] },
    call: (scope, input) => artifactsResult(scope.artifacts(String(input.itemId ?? '')), input.name),
  },
  {
    name: 'read_digests',
    title: "Read an Item's Digests",
    description: 'What Sessions on an Item decided, changed and left open, oldest first (a rollup stands in for the Digests it covers).',
    inputSchema: { type: 'object', properties: ITEM_ID, required: ['itemId'] },
    call(scope, input) {
      const digests = scope.digests(String(input.itemId ?? ''));
      return text(digests.length ? digests.join('\n\n') : 'This Item has no Digests yet.', { digests });
    },
  },
  {
    name: 'raise_ask',
    title: 'Raise an Ask or propose a change',
    description:
      'Ask a person for input on the Project, or propose a change. You cannot change the Project yourself: give a "proposal" (a Decision Ask) and Kiln applies it, as the person, only if they accept. Proposals: {"kind":"create_items","items":[{"kind","title","parentId?","description?"}]} or {"kind":"reorder_queue","order":[Item ids in Up next, first to start first]}.',
    inputSchema: {
      type: 'object',
      properties: {
        ...ASK_PROPERTIES,
        proposal: {
          type: 'object',
          description: 'The change you propose. Kiln offers the answers Accept and Decline.',
          properties: { kind: { type: 'string', enum: [...PROPOSAL_KINDS] }, items: { type: 'array' }, order: { type: 'array', items: { type: 'string' } } },
          required: ['kind'],
        },
      },
      required: ['type', 'question', 'why', 'recommendation', 'blocking'],
    },
    call: (scope, input) => askRaised(scope.raiseAsk(input as unknown as RaiseAskRequest & { proposal?: Proposal })),
  },
  writeDigestTool,
];

/** The tools this Session gets: its kind's list, less any its scope does not offer. */
const toolsOf = (scope: KilnToolsScope): Tool<KilnToolsScope>[] =>
  ((scope.kind === 'project' ? PROJECT_TOOLS : ITEM_TOOLS) as Tool<KilnToolsScope>[]).filter((tool) => !tool.offered || tool.offered(scope));

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const reply = (id: JsonRpcMessage['id'], result: unknown) => ({ jsonrpc: '2.0', id, result });
const failure = (id: JsonRpcMessage['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/**
 * Answers one JSON-RPC message for a Session's Kiln tools. Returns the response to send, or
 * undefined for a notification (answer 202 with no body).
 */
export async function answerKilnTools(scope: KilnToolsScope, message: unknown): Promise<unknown> {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return failure(null, -32600, 'Expected one JSON-RPC message');
  const { id, method, params = {} } = message as JsonRpcMessage;
  if (typeof method !== 'string') return undefined; // a response or a malformed notification: nothing to answer
  if (id === undefined) return undefined; // a notification, e.g. notifications/initialized
  switch (method) {
    case 'initialize': {
      const asked = params.protocolVersion;
      return reply(id, {
        protocolVersion: typeof asked === 'string' && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'kiln', title: 'Kiln tools', version: '0.1.0' },
        instructions:
          scope.kind === 'project'
            ? "Kiln tools for the Project, read-only: read its Items, their artifacts and Digests, raise Asks to propose changes, and write your Digest before you finish."
            : 'Kiln tools for your Item: raise an Ask when you need a person, read your Item and its artifacts, and write your Digest before you finish.',
      });
    }
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: toolsOf(scope).map(({ call: _call, offered: _offered, ...tool }) => tool) });
    case 'tools/call': {
      const tool = toolsOf(scope).find((t) => t.name === params.name);
      if (!tool) return failure(id, -32602, `Unknown tool: ${String(params.name)}`);
      const input = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        return reply(id, await tool.call(scope, input));
      } catch (err) {
        return reply(id, { ...text(err instanceof Error ? err.message : String(err)), isError: true });
      }
    }
    default:
      return failure(id, -32601, `Method not found: ${method}`);
  }
}

/** The name of a tools/call message's tool, for the audit entry. */
export const calledTool = (message: unknown): string | undefined => {
  const m = message as JsonRpcMessage | null;
  return m?.method === 'tools/call' && typeof m.params?.name === 'string' ? m.params.name : undefined;
};

/** What a Session's Kiln tools call is audited against: its Item, or its Project for a Project Thread Session. */
export const kilnToolsTarget = (session: Pick<SessionInfo, 'itemId' | 'projectId'>) =>
  projectOfThread(session.itemId) !== undefined ? `project:${session.projectId}` : `item:${session.itemId}`;
