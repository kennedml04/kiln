// The default Tracker: markdown files in the Project's repo, in the `.scratch` layout as-is.
//
//   .scratch/epics/<epic>.md                 Epic    (frontmatter: title, optional stage)
//   .scratch/<story>/story.md                Story   (frontmatter: title, epic, stage)
//   .scratch/<story>/spec.md                 the Story's spec (also marks a folder as a Story)
//   .scratch/<story>/issues/NN-<slug>.md     Ticket  (`# NN: title`, `**Status:**`, optional `**Stage:**`)
//   .scratch/items/<kind>/<slug>.md          any other Item kind a custom Workflow names
//                                            (frontmatter: title, stage, optional parent key)
//
// Keys: `epic/<slug>`, `story/<slug>`, `ticket/<story>/<NN>`, `<kind>/<slug>`.
// Stages are the Project's Workflow's: a record whose Stage its kind does not have reads as the
// kind's first Stage (or its last, when the record says it shipped).
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Tracker, TrackerCreateInput, TrackerItem, Workflow } from '@kiln/widget-sdk';
import { currentBranch, defaultBranch, git } from '../flow/git.ts';
import { DEFAULT_WORKFLOW } from './default-workflow.ts';

const SCRATCH = '.scratch';
/** Where records of the kinds the `.scratch` layout has no place for go. */
const ITEMS = 'items';
/** Folders under `.scratch` that are not Stories. */
const NOT_STORIES = new Set(['epics', 'questions', ITEMS]);
/** The kinds with a place of their own in the `.scratch` layout. */
const LAYOUT_KINDS = new Set(['epic', 'story', 'ticket']);
const TICKET_FILE = /^(\d+)-.*\.md$/;
const WATCH_DEBOUNCE_MS = 100;
const SHIPPED_STATUSES = new Set(['done', 'resolved', 'shipped', 'closed']);

/** Old-board Story stages that the default Workflow folds into its own. */
const STORY_STAGE_ALIASES: Record<string, string> = { roadmap: 'grill', implementing: 'tickets', review: 'tickets' };

/** The Stage ids each kind has in a Workflow. */
type StageSets = Map<string, Set<string>>;
const stageSets = (workflow: Workflow): StageSets => new Map(workflow.kinds.map((k) => [k.id, new Set(k.stages.map((s) => s.id))]));
const has = (stages: StageSets, kind: string, stage: string | undefined) => !!stage && !!stages.get(kind)?.has(stage);

interface Parsed {
  front: Record<string, string>;
  body: string;
}

function parseFrontmatter(text: string): Parsed {
  const normalized = text.replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  if (!match) return { front: {}, body: normalized };
  const front: Record<string, string> = {};
  for (const line of match[1]!.split('\n')) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) front[kv[1]!.toLowerCase()] = kv[2]!.trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return { front, body: normalized.slice(match[0].length) };
}

const heading = (body: string) => /^#\s+(.+)$/m.exec(body)?.[1]?.trim();

/** The first plain paragraph of a body (no headings, field lines or checklists). */
function firstParagraph(body: string): string | undefined {
  for (const block of body.split(/\n\s*\n/)) {
    const text = block.trim();
    if (text && !/^(#|\*\*|- \[|[A-Z][\w ]*:)/.test(text)) return text;
  }
  return undefined;
}

/** A `**Name:** value` or `Name: value` field line. */
const field = (body: string, name: string) =>
  new RegExp(`^(?:\\*\\*${name}:\\*\\*|${name}:)\\s*(.+)$`, 'mi').exec(body)?.[1]?.trim();

const read = (file: string) => readFileSync(file, 'utf8');
const isDir = (path: string) => existsSync(path) && statSync(path).isDirectory();

function readEpics(root: string, stages: StageSets): TrackerItem[] {
  const dir = join(root, SCRATCH, 'epics');
  if (!isDir(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => {
      const slug = name.slice(0, -3);
      const { front, body } = parseFrontmatter(read(join(dir, name)));
      return {
        key: `epic/${slug}`,
        kind: 'epic',
        title: front.title || heading(body) || slug,
        stage: has(stages, 'epic', front.stage) ? front.stage! : front.stage === 'shipped' ? 'shipped' : 'roadmap',
        description: firstParagraph(body),
        path: `${SCRATCH}/epics/${name}`,
      };
    });
}

function storyStage(stages: StageSets, front: Record<string, string>, hasSpec: boolean, hasTickets: boolean): string {
  const raw = front.stage?.toLowerCase();
  if (has(stages, 'story', raw) || raw === 'shipped') return raw!;
  if (raw && STORY_STAGE_ALIASES[raw]) return STORY_STAGE_ALIASES[raw]!;
  if (hasTickets) return 'tickets';
  return hasSpec ? 'spec' : 'grill';
}

function readTickets(root: string, story: string, stages: StageSets): TrackerItem[] {
  const dir = join(root, SCRATCH, story, 'issues');
  if (!isDir(dir)) return [];
  return readdirSync(dir)
    .filter((name) => TICKET_FILE.test(name))
    .sort()
    .map((name) => {
      const number = TICKET_FILE.exec(name)![1]!;
      const body = read(join(dir, name)).replace(/\r\n/g, '\n');
      const status = field(body, 'Status');
      const stage = field(body, 'Stage')?.toLowerCase();
      const title = heading(body)?.replace(/^\d+:\s*/, '') || name.slice(0, -3);
      return {
        key: `ticket/${story}/${number}`,
        kind: 'ticket',
        title,
        stage: has(stages, 'ticket', stage) || stage === 'shipped' ? stage! : SHIPPED_STATUSES.has(status?.toLowerCase() ?? '') ? 'shipped' : 'implementing',
        status,
        description: field(body, 'What to build'),
        parentKey: `story/${story}`,
        path: `${SCRATCH}/${story}/issues/${name}`,
      };
    });
}

function readStories(root: string, epicKeys: Set<string>, stages: StageSets): TrackerItem[] {
  const scratch = join(root, SCRATCH);
  if (!isDir(scratch)) return [];
  const items: TrackerItem[] = [];
  for (const slug of readdirSync(scratch).sort()) {
    const dir = join(scratch, slug);
    if (NOT_STORIES.has(slug) || !isDir(dir)) continue;
    const storyFile = join(dir, 'story.md');
    const specFile = join(dir, 'spec.md');
    const tickets = readTickets(root, slug, stages);
    const hasStory = existsSync(storyFile);
    const hasSpec = existsSync(specFile);
    if (!hasStory && !hasSpec && !isDir(join(dir, 'issues'))) continue;
    const { front, body } = hasStory ? parseFrontmatter(read(storyFile)) : { front: {}, body: '' };
    const specTitle = hasSpec ? heading(read(specFile))?.replace(/^Spec:\s*/i, '') : undefined;
    const epicKey = front.epic ? `epic/${front.epic}` : undefined;
    items.push({
      key: `story/${slug}`,
      kind: 'story',
      title: front.title || heading(body) || specTitle || slug,
      stage: storyStage(stages, front, hasSpec, tickets.length > 0),
      description: firstParagraph(body),
      parentKey: epicKey && epicKeys.has(epicKey) ? epicKey : undefined,
      path: `${SCRATCH}/${slug}/${hasStory ? 'story.md' : hasSpec ? 'spec.md' : 'issues'}`,
    });
    items.push(...tickets);
  }
  return items;
}

/** Records of kinds without a place in the layout: `.scratch/items/<kind>/<slug>.md`. */
function readOtherKinds(root: string): TrackerItem[] {
  const dir = join(root, SCRATCH, ITEMS);
  if (!isDir(dir)) return [];
  const items: TrackerItem[] = [];
  for (const kind of readdirSync(dir).sort()) {
    if (LAYOUT_KINDS.has(kind) || !isDir(join(dir, kind))) continue;
    for (const name of readdirSync(join(dir, kind)).sort()) {
      if (!name.endsWith('.md')) continue;
      const slug = name.slice(0, -3);
      const { front, body } = parseFrontmatter(read(join(dir, kind, name)));
      items.push({
        key: `${kind}/${slug}`,
        kind,
        title: front.title || heading(body) || slug,
        stage: front.stage?.toLowerCase() ?? '',
        status: front.status,
        description: firstParagraph(body),
        parentKey: front.parent || undefined,
        path: `${SCRATCH}/${ITEMS}/${kind}/${name}`,
      });
    }
  }
  return items;
}

/** A Stage the record's kind does not have reads as its first Stage, or its last once it shipped. */
function settle(records: TrackerItem[], workflow: Workflow): TrackerItem[] {
  for (const record of records) {
    const stages = workflow.kinds.find((k) => k.id === record.kind)?.stages;
    if (!stages?.length || stages.some((s) => s.id === record.stage)) continue;
    const shipped = record.stage === 'shipped' || SHIPPED_STATUSES.has(record.status?.toLowerCase() ?? '');
    record.stage = (shipped ? stages[stages.length - 1]! : stages[0]!).id;
  }
  return records;
}

/** Reads every Item record in the repo at `root`, with the Stages of the Project's Workflow. */
export function readScratch(root: string, workflow: Workflow = DEFAULT_WORKFLOW): TrackerItem[] {
  const stages = stageSets(workflow);
  const epics = readEpics(root, stages);
  return settle([...epics, ...readStories(root, new Set(epics.map((e) => e.key)), stages), ...readOtherKinds(root)], workflow);
}

export interface MarkdownTrackerOptions {
  /** The Project's Workflow now (it can change while the Tracker is open). Default: the default Workflow. */
  workflow?: () => Workflow;
  /**
   * `root` is a Session's worktree, on its Stage branch: new Items are committed there and merge
   * with the branch. Otherwise `root` is the main checkout, and new Items go only on its default branch.
   */
  sessionCheckout?: boolean;
}

/** The markdown Tracker for the repo at `root`. */
export function createMarkdownTracker(root: string, options: MarkdownTrackerOptions = {}): Tracker {
  const workflow = options.workflow ?? (() => DEFAULT_WORKFLOW);
  return {
    async list() {
      return readScratch(root, workflow());
    },
    watch(onChange) {
      // `.scratch` is watched recursively; the repo root only to see `.scratch` appear or go.
      let timer: ReturnType<typeof setTimeout> | undefined;
      let scratchWatcher: FSWatcher | undefined;
      const changed = () => {
        clearTimeout(timer);
        timer = setTimeout(onChange, WATCH_DEBOUNCE_MS);
      };
      const attach = () => {
        const dir = join(root, SCRATCH);
        if (scratchWatcher || !isDir(dir)) return;
        scratchWatcher = watch(dir, { recursive: true }, changed);
        scratchWatcher.on('error', () => {
          scratchWatcher?.close();
          scratchWatcher = undefined;
          changed();
        });
      };
      const rootWatcher = watch(root, (_event, name) => {
        if (name !== SCRATCH) return;
        attach();
        changed();
      });
      rootWatcher.on('error', () => undefined);
      attach();
      return () => {
        clearTimeout(timer);
        rootWatcher.close();
        scratchWatcher?.close();
      };
    },
    async create(input) {
      const { relativePath, content, key } = newRecord(root, input);
      const file = join(root, relativePath);
      if (existsSync(file)) throw new Error(`${relativePath} already exists`);
      if (!options.sessionCheckout && (await isGitRepo(root))) await assertSafeToCommit(root, relativePath);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content, { flag: 'wx' });
      await commitFile(root, relativePath, `Add ${input.kind}: ${oneLine(input.title)}`);
      return key;
    },
    async writeStage(key, change, message) {
      const record = readScratch(root, workflow()).find((r) => r.key === key);
      if (!record?.path) throw new Error(`No Item record for ${key}`);
      // A Story without a story.md (only a spec or Tickets) gets one, holding its Stage.
      const path = record.kind === 'story' && !record.path.endsWith('/story.md') ? `${SCRATCH}/${key.slice(6)}/story.md` : record.path;
      const inGit = await isGitRepo(root);
      if (inGit) await assertSafeToCommit(root, path);
      const file = join(root, path);
      if (record.kind === 'ticket') {
        const text = read(file);
        const eol = text.includes('\r\n') ? '\r\n' : '\n';
        const lines = text.split(/\r?\n/);
        if (change.status !== undefined) setField(lines, 'Status', change.status);
        setField(lines, 'Stage', change.stage);
        writeFileSync(file, lines.join(eol));
      } else {
        const text = existsSync(file) ? read(file) : `---\ntitle: ${yamlValue(record.title)}\n---\n`;
        writeFileSync(file, setFrontmatter(text, 'stage', change.stage));
      }
      if (inGit) await commitFile(root, path, message);
    },
  };
}

const fieldLine = (name: string) => new RegExp(`^(\\*\\*${name}:\\*\\*|${name}:)\\s*`, 'i');

/**
 * Sets a `**Name:** value` line in place, keeping its style. A missing line goes in its own
 * paragraph after the Status line (or at the end), so no other line changes.
 */
function setField(lines: string[], name: string, value: string): void {
  const index = lines.findIndex((line) => fieldLine(name).test(line));
  if (index !== -1) {
    lines[index] = `${fieldLine(name).exec(lines[index]!)![1]} ${value}`;
    return;
  }
  const status = lines.findIndex((line) => fieldLine('Status').test(line));
  let at = status === -1 ? lines.length : status + 1;
  if (status === -1) while (at > 0 && lines[at - 1] === '') at--;
  lines.splice(at, 0, '', `**${name}:** ${value}`);
}

/**
 * Sets one frontmatter key in place, keeping every other line (and the file's line endings). A
 * missing key goes last in the frontmatter; a file without frontmatter gets some.
 */
function setFrontmatter(text: string, name: string, value: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') return ['---', `${name}: ${value}`, '---', ...lines].join(eol);
  const close = lines.indexOf('---', 1);
  if (close === -1) return ['---', `${name}: ${value}`, '---', ...lines].join(eol);
  const at = lines.slice(1, close).findIndex((line) => new RegExp(`^${name}:`, 'i').test(line));
  if (at === -1) lines.splice(close, 0, `${name}: ${value}`);
  else lines[at + 1] = `${name}: ${value}`;
  return lines.join(eol);
}

async function isGitRepo(root: string): Promise<boolean> {
  try {
    await git(root, 'rev-parse', '--is-inside-work-tree');
    return true;
  } catch {
    return false;
  }
}

/** Tracker writes go on the default branch and never sweep up a person's uncommitted edits. */
async function assertSafeToCommit(root: string, relativePath: string): Promise<void> {
  const [base, current] = await Promise.all([defaultBranch(root), currentBranch(root)]);
  if (current !== base) {
    throw new Error(`The main checkout is on ${current ?? 'a detached HEAD'}, not the default branch ${base}`);
  }
  const stdout = await git(root, 'status', '--porcelain', '--', relativePath);
  if (stdout.trim()) throw new Error(`${relativePath} has uncommitted changes in the main checkout`);
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'item';

/** A frontmatter value, quoted when plain YAML would misread it. */
const yamlValue = (text: string) => (/^[\w(][^:#]*$/.test(text) ? text : JSON.stringify(text));

const paragraph = (description?: string) => (description?.trim() ? `\n${description.trim()}\n` : '');

function newRecord(root: string, input: TrackerCreateInput): { relativePath: string; content: string; key: string } {
  const title = oneLine(input.title);
  const slug = slugify(title);
  if (input.kind === 'epic') {
    return {
      key: `epic/${slug}`,
      relativePath: `${SCRATCH}/epics/${slug}.md`,
      content: `---\ntitle: ${yamlValue(title)}\n---\n${paragraph(input.description)}`,
    };
  }
  if (input.kind === 'story') {
    const epic = input.parentKey?.startsWith('epic/') ? `epic: ${input.parentKey.slice(5)}\n` : '';
    return {
      key: `story/${slug}`,
      relativePath: `${SCRATCH}/${slug}/story.md`,
      content: `---\ntitle: ${yamlValue(title)}\n${epic}stage: ${input.stage ?? 'grill'}\n---\n${paragraph(input.description)}`,
    };
  }
  if (input.kind === 'ticket' && input.parentKey?.startsWith('story/')) {
    const story = input.parentKey.slice(6);
    // Numbered past every Ticket of the Story anywhere: here, on the default branch and in live worktrees.
    const prefix = `ticket/${story}/`;
    const keys = [...readTickets(root, story, new Map()).map((t) => t.key), ...(input.takenKeys ?? []).filter((k) => k.startsWith(prefix))];
    const numbers = keys.map((k) => Number(k.split('/').pop()));
    const number = String(Math.max(0, ...numbers) + 1).padStart(2, '0');
    const what = input.description?.trim() ? `**What to build:** ${oneLine(input.description)}\n\n` : '';
    return {
      key: `ticket/${story}/${number}`,
      relativePath: `${SCRATCH}/${story}/issues/${number}-${slug}.md`,
      content: `# ${number}: ${title}\n\n${what}**Blocked by:** None\n\n**Status:** needs-triage\n`,
    };
  }
  if (!LAYOUT_KINDS.has(input.kind) && /^[a-z0-9][a-z0-9-]*$/.test(input.kind)) {
    const parent = input.parentKey ? `parent: ${input.parentKey}\n` : '';
    const stage = input.stage ? `stage: ${input.stage}\n` : '';
    return {
      key: `${input.kind}/${slug}`,
      relativePath: `${SCRATCH}/${ITEMS}/${input.kind}/${slug}.md`,
      content: `---\ntitle: ${yamlValue(title)}\n${parent}${stage}---\n${paragraph(input.description)}`,
    };
  }
  throw new Error(`The markdown Tracker cannot create a ${input.kind} here`);
}

/** Commits one file as Kiln, leaving anything else staged or changed alone. Skipped outside git. */
async function commitFile(root: string, relativePath: string, message: string): Promise<void> {
  if (!(await isGitRepo(root))) return;
  await git(root, 'add', '--', relativePath);
  await git(root, 'commit', '-q', '-m', message, '--', relativePath);
}
