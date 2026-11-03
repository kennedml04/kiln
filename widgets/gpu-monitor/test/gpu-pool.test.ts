// The "gpu: 1" pool the GPU monitor's Manifest declares, as the scheduler enforces it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Item, Project, SchedulerState, SessionStartedEvent, StartResult, Workflow } from '@kiln/widget-sdk';
import { createTempRepo, startTestKiln, type Cleanup, type TestKiln } from '@kiln/testing';
import { seedScratch, writeRepoFile } from '@kiln/testing/scratch';

const WIDGET_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// No GPU reading is needed here: a tool that doesn't exist just shows "No GPU reading".
const CONFIG = { nvidiaSmi: ['kiln-no-such-nvidia-smi'], intervalMs: 60_000 };

function publicRepo(t: Cleanup): string {
  const repo = createTempRepo(t);
  cpSync(WIDGET_DIR, join(repo.path, 'widgets', 'gpu-monitor'), { recursive: true, filter: (src) => !src.includes('node_modules') });
  repo.git('add', '.');
  repo.git('commit', '-q', '-m', 'GPU monitor');
  return repo.path;
}

async function installGpuMonitor(t: Cleanup, kiln: TestKiln) {
  const events = await kiln.events();
  await kiln.api('POST', '/api/widgets', { source: publicRepo(t), path: 'widgets/gpu-monitor', config: CONFIG });
  await kiln.api('POST', '/api/widgets/gpu-monitor/approve');
  await events.next('widget.ready', { timeoutMs: 15_000 });
  events.close();
}

/** A Project whose Implementing Stage runs in the gpu pool, with these Tickets in it. */
async function gpuBoundTickets(kiln: TestKiln, titles: string[]): Promise<Item[]> {
  // The Project's own Workflow file, whose Ticket Implementing Stage runs in the gpu pool.
  const workflow: Workflow = {
    name: 'gpu-bound',
    kinds: [
      { id: 'story', name: 'Story', stages: [{ id: 'tickets', name: 'Tickets' }, { id: 'shipped', name: 'Shipped' }] },
      {
        id: 'ticket',
        name: 'Ticket',
        parentKind: 'story',
        stages: [
          { id: 'implementing', name: 'Implementing', role: 'implementer', agent: 'fake', model: 'fake-model', worktree: true, exit: ['branch_has_commits'], pool: 'gpu' },
          { id: 'shipped', name: 'Shipped' },
        ],
      },
    ],
  };
  writeRepoFile(kiln.repo, '.kiln/workflow.json', JSON.stringify(workflow, null, 2));
  seedScratch(kiln.repo);
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  assert.equal(project.workflowSource, 'file');
  const story = (await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`)).find((i) => i.title === 'Home board')!;
  const tickets: Item[] = [];
  for (const title of titles) {
    tickets.push(await kiln.api<Item>('POST', `/api/projects/${project.id}/items`, { kind: 'ticket', title, parentId: story.id }));
  }
  return tickets;
}

const start = (kiln: TestKiln, item: Item) => kiln.api<StartResult>('POST', `/api/items/${encodeURIComponent(item.id)}/start`);

test('approving the GPU monitor adds its "gpu: 1" pool to the scheduler, beside the default pool', async (t) => {
  const kiln = await startTestKiln(t);
  assert.deepEqual((await kiln.api<SchedulerState>('GET', '/api/scheduler')).pools.map((p) => p.name), ['agents']);

  await installGpuMonitor(t, kiln);

  const { pools } = await kiln.api<SchedulerState>('GET', '/api/scheduler');
  assert.deepEqual(pools, [
    { name: 'agents', size: 3, active: 0 },
    { name: 'gpu', size: 1, active: 0 },
  ]);
});

test('GPU-bound Sessions never run two at a time: the second waits in Up next until the first ends', async (t) => {
  const kiln = await startTestKiln(t);
  const agent = await kiln.installFakeAgent({ script: [{ do: 'wait_for_message' }] });
  await installGpuMonitor(t, kiln);
  const [one, two] = await gpuBoundTickets(kiln, ['Render one', 'Render two']);
  const events = await kiln.events();

  const first = await start(kiln, one!);
  const second = await start(kiln, two!);

  assert.equal(first.queued, false);
  assert.equal(second.queued, true);
  const state = await kiln.api<SchedulerState>('GET', '/api/scheduler');
  assert.deepEqual(state.pools.find((p) => p.name === 'gpu'), { name: 'gpu', size: 1, active: 1 });
  assert.deepEqual(state.queue.map((q) => [q.itemId, q.pool]), [[two!.id, 'gpu']]);

  await events.next('session.started', { timeoutMs: 15_000 });
  await agent.stopSession(first.session!.id);
  const next = await events.next<SessionStartedEvent>('session.started', { timeoutMs: 15_000 });
  assert.equal(next.payload.itemId, two!.id);
});

test('an Admin can resize the gpu pool, and the size sticks over the Manifest default', async (t) => {
  const kiln = await startTestKiln(t);
  await installGpuMonitor(t, kiln);

  await kiln.api('PUT', '/api/scheduler/pools/gpu', { size: 2 });

  const { pools } = await kiln.api<SchedulerState>('GET', '/api/scheduler');
  assert.deepEqual(pools.find((p) => p.name === 'gpu'), { name: 'gpu', size: 2, active: 0 });
});
