import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Item, Project } from '@kiln/widget-sdk';
import { startTestKiln } from '@kiln/testing';
import { readRepoFile, seedScratch, writeRepoFile } from '@kiln/testing/scratch';

const register = async (kiln: Awaited<ReturnType<typeof startTestKiln>>) => {
  seedScratch(kiln.repo);
  return kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
};
const maintenanceOf = (items: Item[]) => items.filter((i) => i.maintenance);

test('a Ticket filed without a Story goes under the Project Maintenance Story', async (t) => {
  const kiln = await startTestKiln(t);
  const project = await register(kiln);
  assert.equal(maintenanceOf(await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`)).length, 0);

  const ticket = await kiln.api<Item>('POST', `/api/projects/${project.id}/items`, { kind: 'ticket', title: 'Fix the lint' });
  const items = await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`);
  const [story] = maintenanceOf(items);
  assert.ok(story);
  assert.equal(story.title, 'Maintenance');
  assert.equal(story.kind, 'story');
  assert.equal(story.stage, 'tickets');
  assert.equal(ticket.parentId, story.id);
  assert.deepEqual(items.find((i) => i.id === story.id)!.childIds, [ticket.id]);
  assert.match(readRepoFile(kiln.repo, '.scratch/maintenance/story.md'), /maintenance: true/);

  // A second Ticket reuses the same Story.
  const second = await kiln.api<Item>('POST', `/api/projects/${project.id}/items`, { kind: 'ticket', title: 'Bump deps' });
  assert.equal(second.parentId, story.id);
  assert.equal(maintenanceOf(await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`)).length, 1);
});

test('a Ticket record without a parent gets the Maintenance Story, which never ships or runs a Session', async (t) => {
  const kiln = await startTestKiln(t);
  seedScratch(kiln.repo);
  writeRepoFile(kiln.repo, '.scratch/items/ticket/odd-job.md', '---\ntitle: Odd job\nstage: shipped\n---\n');
  kiln.repo.git('add', '.');
  kiln.repo.git('commit', '-q', '-m', 'Story-less ticket');
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const items = await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`);
  const story = maintenanceOf(items)[0];
  assert.ok(story, 'the Maintenance Story is made when the first Story-less Ticket appears');
  const job = items.find((i) => i.title === 'Odd job')!;
  assert.equal(job.parentId, story.id);
  assert.equal(job.runState, 'shipped');

  // Every Ticket shipped, and still it stays open.
  const after = (await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`)).find((i) => i.id === story.id)!;
  assert.equal(after.stage, 'tickets');
  assert.notEqual(after.runState, 'shipped');

  const res = await kiln.request('POST', `/api/items/${encodeURIComponent(story.id)}/start`);
  assert.equal(res.status, 409);
});
