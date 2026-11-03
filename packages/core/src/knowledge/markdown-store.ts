// The default Knowledge store: a folder of markdown files with YAML frontmatter, readable as an
// Obsidian vault. It holds the Digests every Session leaves behind (decisions, retros and notes
// come later). The files are the record: Kiln reads Digests back from them, so a person may edit
// one in Obsidian and the next Session is seeded with the edit, and losing Kiln's SQLite file
// loses no Digest.
//
// Layout (ticket 10):
//   <root>/Digests/<project id>/<item key, "/" -> "-">/<writtenAt>-<kind>-<id>.md
// Frontmatter holds the metadata (kind, id, item, project, session, stage, writtenBy, writtenAt,
// covers); the body holds the content under "## Summary", "## Decided", "## Changed" and "## Open",
// one "- " bullet per entry.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { Digest, DigestContent, Item } from '@kiln/widget-sdk';
import type { DoctorOutcome } from '../operations/doctor.ts';

export interface DigestInput {
  sessionId: string | null;
  stage: string;
  writtenBy: Digest['writtenBy'];
  content: DigestContent;
}

export interface KnowledgeStore {
  readonly root: string;
  /**
   * Writes one Digest for the Item. When that leaves `rollupAt` Digests not yet rolled up, they are
   * rolled up (with the previous rollup) into one, which is returned too.
   */
  writeDigest(item: Item, input: DigestInput): { digest: Digest; rollup?: Digest };
  /** Every Digest and rollup of the Item, oldest first. */
  digests(item: Item): Digest[];
  /** What a fresh Session is seeded with: the latest rollup, then the Digests it doesn't cover. */
  seed(item: Item): Digest[];
  /** A Digest as markdown, for a Session's seed (the file's body, without frontmatter). */
  render(digest: Digest): string;
  /** `kiln doctor`'s Knowledge store check. */
  check(): DoctorOutcome;
}

export const DEFAULT_ROLLUP_AT = 5;

const SECTIONS = [
  ['decided', 'Decided'],
  ['changed', 'Changed'],
  ['open', 'Open'],
] as const;

const PLAIN = /^[A-Za-z0-9][\w.:/-]*$/;
const yamlValue = (value: string | string[]) =>
  Array.isArray(value) ? JSON.stringify(value) : PLAIN.test(value) ? value : JSON.stringify(value);

const parseValue = (raw: string): unknown => (raw.startsWith('"') || raw.startsWith('[') ? JSON.parse(raw) : raw);

/** One entry per line: a newline inside an entry would split it into two bullets. */
const oneLine = (text: string) => text.replace(/\s*\n\s*/g, ' ').trim();

const strings = (value: unknown, field: string): string[] => {
  if (value === undefined) return [];
  if (typeof value === 'string') return value.trim() ? [value] : [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new Error(`"${field}" must be a list of strings`);
  return (value as string[]).map(oneLine).filter(Boolean);
};

/** Checks a `write_digest` input (or an Agent's Digest) and returns it in shape. */
export function digestContent(input: unknown): DigestContent {
  if (!input || typeof input !== 'object') throw new Error('A Digest needs decided, changed and open');
  const raw = input as Record<string, unknown>;
  const content: DigestContent = {
    decided: strings(raw.decided, 'decided'),
    changed: strings(raw.changed, 'changed'),
    open: strings(raw.open, 'open'),
  };
  if (raw.summary !== undefined) {
    if (typeof raw.summary !== 'string') throw new Error('"summary" must be text');
    if (raw.summary.trim()) content.summary = raw.summary.trim();
  }
  return content;
}

const dedupe = (lists: string[][]) => [...new Set(lists.flat())];

const folderName = (key: string) => key.replaceAll('/', '-').replace(/[<>:"\\|?*]/g, '_');

function renderBody(title: string, digest: Omit<Digest, 'path'>): string {
  const heading = digest.kind === 'rollup' ? `Rollup: ${title}` : `Digest: ${title} (${digest.stage})`;
  const parts = [`# ${heading}`, ''];
  if (digest.summary) parts.push('## Summary', '', digest.summary, '');
  for (const [field, name] of SECTIONS) {
    parts.push(`## ${name}`, '');
    const entries = digest[field];
    parts.push(...(entries.length ? entries.map((e) => `- ${e}`) : ['_Nothing._']), '');
  }
  return parts.join('\n');
}

function parseFile(text: string, path: string): Digest | undefined {
  const normalized = text.replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!match) return undefined;
  const meta: Record<string, unknown> = {};
  for (const line of match[1]!.split('\n')) {
    const at = line.indexOf(': ');
    if (at > 0) meta[line.slice(0, at)] = parseValue(line.slice(at + 2).trim());
  }
  if (meta.kiln !== 'digest' || typeof meta.id !== 'string' || typeof meta.item !== 'string') return undefined;
  const body = match[2]!;
  const sections = new Map<string, string>();
  const pieces = body.split(/^## (.+)$/m);
  for (let i = 1; i < pieces.length; i += 2) sections.set(pieces[i]!.trim().toLowerCase(), pieces[i + 1] ?? '');
  const bullets = (name: string) =>
    (sections.get(name) ?? '')
      .split('\n')
      .filter((line) => line.startsWith('- '))
      .map((line) => line.slice(2).trim())
      .filter(Boolean);
  const summary = sections.get('summary')?.trim();
  return {
    id: meta.id,
    kind: meta.kind === 'rollup' ? 'rollup' : 'digest',
    itemId: meta.item,
    projectId: String(meta.project ?? ''),
    sessionId: meta.session === undefined || meta.session === 'null' ? null : String(meta.session),
    stage: String(meta.stage ?? ''),
    writtenBy: meta.writtenBy === 'session' ? 'session' : 'kiln',
    writtenAt: String(meta.writtenAt ?? ''),
    ...(Array.isArray(meta.covers) ? { covers: meta.covers as string[] } : {}),
    ...(summary ? { summary } : {}),
    decided: bullets('decided'),
    changed: bullets('changed'),
    open: bullets('open'),
    path,
  };
}

export function createMarkdownKnowledgeStore({ root, rollupAt = DEFAULT_ROLLUP_AT }: { root: string; rollupAt?: number }): KnowledgeStore {
  const itemFolder = (item: Item) => posix.join('Digests', folderName(item.projectId), folderName(item.key));

  const write = (item: Item, digest: Omit<Digest, 'path'>): Digest => {
    const folder = itemFolder(item);
    const path = posix.join(folder, `${digest.writtenAt.replace(/:/g, '-')}-${digest.kind}-${digest.id.slice(2, 10)}.md`);
    const meta: [string, string | string[] | null][] = [
      ['kiln', 'digest'],
      ['kind', digest.kind],
      ['id', digest.id],
      ['item', digest.itemId],
      ['itemTitle', item.title],
      ['project', digest.projectId],
      ['session', digest.sessionId],
      ['stage', digest.stage],
      ['writtenBy', digest.writtenBy],
      ['writtenAt', digest.writtenAt],
      ['covers', digest.covers ?? null],
      ['tags', [`kiln/${digest.kind}`]],
    ];
    const frontmatter = meta.filter(([, v]) => v !== null).map(([k, v]) => `${k}: ${yamlValue(v!)}`);
    mkdirSync(join(root, folder), { recursive: true });
    writeFileSync(join(root, path), `---\n${frontmatter.join('\n')}\n---\n\n${renderBody(item.title, digest)}`);
    return { ...digest, path };
  };

  const digests = (item: Item): Digest[] => {
    const folder = itemFolder(item);
    const dir = join(root, folder);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith('.md'))
      .sort()
      .map((name) => parseFile(readFileSync(join(dir, name), 'utf8'), posix.join(folder, name)))
      .filter((d): d is Digest => d !== undefined && d.itemId === item.id);
  };

  const seed = (item: Item): Digest[] => {
    const all = digests(item);
    const rollup = all.filter((d) => d.kind === 'rollup').at(-1);
    if (!rollup) return all;
    const covered = new Set(rollup.covers ?? []);
    return [rollup, ...all.filter((d) => d.kind === 'digest' && !covered.has(d.id))];
  };

  return {
    root,
    writeDigest(item, { sessionId, stage, writtenBy, content }) {
      const digest = write(item, {
        id: `d-${randomUUID()}`,
        kind: 'digest',
        itemId: item.id,
        projectId: item.projectId,
        sessionId,
        stage,
        writtenBy,
        writtenAt: new Date().toISOString(),
        ...content,
      });
      const [previous, ...pending] = seed(item);
      const rollupOf = previous?.kind === 'rollup' ? previous : undefined;
      const uncovered = rollupOf ? pending : [previous!, ...pending];
      if (uncovered.length < rollupAt) return { digest };
      const parts = [...(rollupOf ? [rollupOf] : []), ...uncovered];
      const last = uncovered.at(-1)!;
      const rollup = write(item, {
        id: `d-${randomUUID()}`,
        kind: 'rollup',
        itemId: item.id,
        projectId: item.projectId,
        sessionId: null,
        stage: last.stage,
        writtenBy: 'kiln',
        writtenAt: new Date().toISOString(),
        covers: [...(rollupOf?.covers ?? []), ...uncovered.map((d) => d.id)],
        decided: dedupe(parts.map((d) => d.decided)),
        changed: dedupe(parts.map((d) => d.changed)),
        // Each Session saw the Digests before it, so the latest one's open list is what is still open.
        open: last.open,
      });
      return { digest, rollup };
    },
    digests,
    seed,
    render(digest) {
      const text = readFileSync(join(root, digest.path), 'utf8').replace(/\r\n/g, '\n');
      return text.replace(/^---\n[\s\S]*?\n---\n\n?/, '');
    },
    check() {
      const probe = join(root, `.kiln-doctor-${process.pid}`);
      try {
        mkdirSync(root, { recursive: true });
        writeFileSync(probe, 'ok');
        rmSync(probe, { force: true });
      } catch (err) {
        return {
          status: 'fail',
          detail: `Kiln cannot write to the Knowledge store folder ${root}: ${err instanceof Error ? err.message : String(err)}`,
          fix: 'Point KILN_KNOWLEDGE_DIR (or --knowledge-dir) at a folder Kiln can write to, such as a new folder or your Obsidian vault, and restart Kiln.',
        };
      }
      const count = existsSync(join(root, 'Digests'))
        ? readdirSync(join(root, 'Digests'), { recursive: true }).filter((name) => String(name).endsWith('.md')).length
        : 0;
      return { status: 'pass', detail: `A markdown folder at ${root}, holding ${count} Digest file${count === 1 ? '' : 's'}.` };
    },
  };
}

/** A Knowledge store whose folder can be changed while the core runs (setup's Knowledge store step). */
export interface MovableKnowledgeStore extends KnowledgeStore {
  /** From now on, Digests are written to and read from `root`. Digests already written stay where they are. */
  moveTo(root: string): void;
}

export function createMovableKnowledgeStore(options: { root: string; rollupAt?: number }): MovableKnowledgeStore {
  let store = createMarkdownKnowledgeStore(options);
  return {
    get root() {
      return store.root;
    },
    writeDigest: (item, input) => store.writeDigest(item, input),
    digests: (item) => store.digests(item),
    seed: (item) => store.seed(item),
    render: (digest) => store.render(digest),
    check: () => store.check(),
    moveTo(root) {
      store = createMarkdownKnowledgeStore({ ...options, root });
    },
  };
}
