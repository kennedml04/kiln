// The markdown Tracker against the shared Tracker contract. Records are read back from the files in
// the repo, the way a person reads them.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Project } from '@kiln/widget-sdk';
import type { TempRepo } from '@kiln/testing';
import { seedScratch, writeRepoFile } from '@kiln/testing/scratch';
import { CONTRACT_TREE, trackerContract, waitForItems, type RecordedItem } from '@kiln/testing/tracker-contract';

const frontmatter = (text: string): Record<string, string> => {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
  return Object.fromEntries(
    block
      .split(/\r?\n/)
      .map((line) => /^(\w[\w-]*):\s*(.*)$/.exec(line))
      .filter((m) => m !== null)
      .map((m) => [m[1]!, m[2]!.replace(/^"(.*)"$/, '$1')]),
  );
};
const field = (text: string, name: string) => new RegExp(`^\\*\\*${name}:\\*\\*\\s*(.+)$`, 'm').exec(text)?.[1]?.trim();
const files = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);

/** Every record in `.scratch`, read straight from the files. */
function readScratch(repo: TempRepo): (RecordedItem & { file: string })[] {
  const scratch = join(repo.path, '.scratch');
  const epics = files(join(scratch, 'epics')).map((name) => {
    const file = join(scratch, 'epics', name);
    const front = frontmatter(readFileSync(file, 'utf8'));
    return { slug: name.replace(/\.md$/, ''), file, title: front.title!, kind: 'epic', stage: front.stage ?? 'roadmap' };
  });
  const records: (RecordedItem & { file: string })[] = epics.map(({ slug: _slug, ...epic }) => epic);
  for (const story of files(scratch).filter((name) => name !== 'epics' && existsSync(join(scratch, name, 'story.md')))) {
    const file = join(scratch, story, 'story.md');
    const text = readFileSync(file, 'utf8');
    const front = frontmatter(text);
    const parent = epics.find((e) => e.slug === front.epic)?.title;
    const description = text.replace(/^---[\s\S]*?---/, '').trim();
    records.push({ file, title: front.title!, kind: 'story', stage: front.stage!, ...(description ? { description } : {}), ...(parent ? { parent } : {}) });
    for (const name of files(join(scratch, story, 'issues'))) {
      const ticketFile = join(scratch, story, 'issues', name);
      const body = readFileSync(ticketFile, 'utf8');
      const status = field(body, 'Status');
      const description = field(body, 'What to build');
      records.push({
        file: ticketFile,
        title: /^# \d+: (.+)$/m.exec(body)![1]!.trim(),
        kind: 'ticket',
        stage: field(body, 'Stage') ?? (status === 'done' ? 'shipped' : 'implementing'),
        ...(status ? { status } : {}),
        ...(description ? { description } : {}),
        parent: front.title!,
      });
    }
  }
  return records;
}

let repo: TempRepo | undefined;

trackerContract({
  name: 'the markdown Tracker',
  async setUp(_t, kiln) {
    repo = kiln.repo;
    seedScratch(kiln.repo);
    writeRepoFile(kiln.repo, '.kiln/settings.json', JSON.stringify({ testCommand: 'node --version' }));
    kiln.repo.git('add', '.');
    kiln.repo.git('commit', '-q', '-m', 'Add the tests');
    const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
    await waitForItems(kiln, project.id, Object.values(CONTRACT_TREE));
    return project;
  },
  async recorded(title) {
    const found = readScratch(repo!).find((r) => r.title === title);
    if (!found) return undefined;
    const { file: _file, ...record } = found;
    return record;
  },
  async renameOutside(title, to) {
    const found = readScratch(repo!).find((r) => r.title === title);
    if (!found) throw new Error(`No record titled "${title}"`);
    writeFileSync(found.file, readFileSync(found.file, 'utf8').replace(title, to));
  },
});
