// Items carry `blockedBy` (from a Ticket's `Blocked by` line) and `maintenance` (from a Story file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Item, Project } from '@kiln/widget-sdk';
import { startTestKiln, type TestKiln } from '@kiln/testing';
import { writeRepoFile } from '@kiln/testing/scratch';

const ticket = (n: string, title: string, blockedBy?: string) =>
  `# ${n}: ${title}\n\n**What to build:** ${title}.\n\n${blockedBy === undefined ? '' : `**Blocked by:** ${blockedBy}\n\n`}**Status:** needs-triage\n`;

function seed(kiln: TestKiln) {
  const story = (slug: string, extra = '') =>
    writeRepoFile(kiln.repo, `.scratch/${slug}/story.md`, `---\ntitle: ${slug}\nstage: tickets\n${extra}---\n\nWhy ${slug}.\n`);
  story('alpha');
  story('beta');
  story('upkeep', 'maintenance: true\n');
  const a = (name: string, body: string) => writeRepoFile(kiln.repo, `.scratch/alpha/issues/${name}.md`, body);
  a('01-one', ticket('01', 'One', 'None'));
  a('02-two', ticket('02', 'Two', '01'));
  a('03-three', ticket('03', 'Three', '#1, 2'));
  a('04-four', ticket('04', 'Four', '03-three'));
  a('05-five', ticket('05', 'Five', 'beta/01 (other story)'));
  a('06-six', ticket('06', 'Six', 'None (can start immediately).'));
  a('07-seven', ticket('07', 'Seven'));
  a('08-eight', ticket('08', 'Eight', '01 99 nope'));
  writeRepoFile(kiln.repo, '.scratch/beta/issues/01-b.md', ticket('01', 'B one', ''));
  kiln.repo.git('add', '.');
  kiln.repo.git('commit', '-q', '-m', 'Seed');
}

test('Blocked by resolves to Item ids; None, empty and missing give none; bad numbers are Project errors', async (t) => {
  const kiln = await startTestKiln(t);
  seed(kiln);
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const items = await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`);
  const blocked = (title: string) => items.find((i) => i.title === title)!.blockedBy;
  const id = (key: string) => `${project.id}/${key}`;

  assert.equal(blocked('One'), undefined);
  assert.deepEqual(blocked('Two'), [id('ticket/alpha/01')]);
  assert.deepEqual(blocked('Three'), [id('ticket/alpha/01'), id('ticket/alpha/02')]);
  assert.deepEqual(blocked('Four'), [id('ticket/alpha/03')]);
  assert.deepEqual(blocked('Five'), [id('ticket/beta/01')]);
  assert.equal(blocked('Six'), undefined);
  assert.equal(blocked('Seven'), undefined);
  assert.equal(blocked('B one'), undefined);
  assert.deepEqual(blocked('Eight'), [id('ticket/alpha/01')]);

  const { errors } = (await kiln.api<Project[]>('GET', '/api/projects')).find((p) => p.id === project.id)!;
  const messages = errors.map((e) => `${e.file}: ${e.message}`).sort();
  assert.deepEqual(messages, [
    '.scratch/alpha/issues/08-eight.md: Blocked by "99" matches no Ticket',
    '.scratch/alpha/issues/08-eight.md: Blocked by "nope" matches no Ticket',
  ]);
});

test('a Story file with maintenance: true sets item.maintenance', async (t) => {
  const kiln = await startTestKiln(t);
  seed(kiln);
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const items = await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`);
  assert.equal(items.find((i) => i.title === 'upkeep')!.maintenance, true);
  assert.equal(items.find((i) => i.title === 'alpha')!.maintenance, undefined);
});
