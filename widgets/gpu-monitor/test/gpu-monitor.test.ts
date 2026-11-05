// The GPU monitor Widget, driven from outside: installed from a copy of the public repo through the
// normal install and approval flow, with nvidia-smi faked by fake-nvidia-smi.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelInspection, PanelContent, PanelView, WidgetInfo } from '@kiln/widget-sdk';
import { createTempRepo, startTestKiln, tempDir, type Cleanup, type TestKiln } from '@kiln/testing';
import { testGguf } from '@kiln/testing/test-gguf';

const HERE = dirname(fileURLToPath(import.meta.url));
const WIDGET_DIR = resolve(HERE, '..');
const FAKE_SMI = join(HERE, 'fake-nvidia-smi.mjs');

interface FakeGpuState {
  gpus: { index: number; uuid: string; name: string; use: number | null; used: number | null; total: number | null }[];
  apps: { uuid: string; pid: number; name: string; used: number | null }[];
  fail?: string;
}

const ONE_BUSY_GPU: FakeGpuState = {
  gpus: [{ index: 0, uuid: 'GPU-aaaa', name: 'NVIDIA GeForce RTX 4090', use: 37, used: 12288, total: 24576 }],
  apps: [{ uuid: 'GPU-aaaa', pid: 4242, name: 'python.exe', used: 10240 }],
};

/** A throwaway copy of the public repo holding the Widget at `widgets/gpu-monitor`. */
function publicRepo(t: Cleanup): string {
  const repo = createTempRepo(t);
  cpSync(WIDGET_DIR, join(repo.path, 'widgets', 'gpu-monitor'), { recursive: true, filter: (src) => !src.includes('node_modules') });
  repo.git('add', '.');
  repo.git('commit', '-q', '-m', 'GPU monitor');
  return repo.path;
}

/** The fake GPUs: `set` rewrites what nvidia-smi reports next. */
function fakeGpus(t: Cleanup, initial: FakeGpuState) {
  const file = join(tempDir(t, 'kiln-fake-gpu'), 'state.json');
  const set = (state: FakeGpuState) => writeFileSync(file, JSON.stringify(state));
  set(initial);
  return { file, set, config: { nvidiaSmi: ['node', FAKE_SMI, file], intervalMs: 100 } };
}

type PanelUpdated = { type: string; id: number; at: string; payload: { panel: PanelView } };

/** Installs and approves the GPU monitor; resolves with its first published panel and the event stream. */
async function startGpuMonitor(t: Cleanup, kiln: TestKiln, config: unknown) {
  const events = await kiln.events();
  await kiln.api('POST', '/api/widgets', { source: publicRepo(t), path: 'widgets/gpu-monitor', config });
  await kiln.api('POST', '/api/widgets/gpu-monitor/approve');
  const first = await events.next<PanelUpdated>('widget.panel_updated', { timeoutMs: 15_000 });
  return { events, first: first.payload.panel };
}

/** Every stat in a panel, by id. */
const stats = (content: PanelContent | null) => {
  const found: Record<string, unknown> = {};
  const walk = (blocks: PanelContent['blocks']) => {
    for (const b of blocks) {
      if (b.kind === 'stat' && b.id) found[b.id] = b.value;
      if (b.kind === 'card') walk(b.blocks ?? []);
    }
  };
  walk(content?.blocks ?? []);
  return found;
};

const panelOf = async (kiln: TestKiln) => (await kiln.api<PanelView[]>('GET', '/api/panels')).find((p) => p.widgetId === 'gpu-monitor');

test('installed from the public repo, the GPU monitor waits for approval, then shows each GPU and what holds it', async (t) => {
  const kiln = await startTestKiln(t);
  const gpus = fakeGpus(t, ONE_BUSY_GPU);
  const events = await kiln.events();

  const installed = await kiln.api<WidgetInfo>('POST', '/api/widgets', { source: publicRepo(t), path: 'widgets/gpu-monitor', config: gpus.config });

  assert.equal(installed.state, 'awaiting-approval');
  assert.deepEqual(installed.manifest.provides?.pools, { gpu: 1 });
  assert.equal(await panelOf(kiln), undefined);

  await kiln.api('POST', '/api/widgets/gpu-monitor/approve');
  const updated = await events.next<{ type: string; id: number; at: string; payload: { panel: PanelView } }>('widget.panel_updated', { timeoutMs: 15_000 });

  const expected: PanelContent = {
    blocks: [
      {
        kind: 'card',
        id: 'gpu-0',
        title: 'GPU 0: NVIDIA GeForce RTX 4090',
        data: { memoryUsedMiB: 12288, memoryTotalMiB: 24576 },
        blocks: [
          { kind: 'stat', id: 'gpu-0-use', label: 'Use', value: 37, unit: '%' },
          { kind: 'stat', id: 'gpu-0-vram', label: 'VRAM', value: '12.0 / 24.0', unit: 'GB' },
          { kind: 'table', id: 'gpu-0-processes', title: 'Holding it', columns: ['PID', 'Process', 'VRAM'], rows: [[4242, 'python.exe', '10.0 GB']] },
        ],
      },
    ],
  };
  assert.deepEqual(updated.payload.panel.content, expected);
  assert.equal(updated.payload.panel.title, 'GPUs');
  assert.equal(updated.payload.panel.placement, 'home');
});

test('the panel updates live as the GPU is used and released', async (t) => {
  const kiln = await startTestKiln(t);
  const gpus = fakeGpus(t, ONE_BUSY_GPU);
  const { events } = await startGpuMonitor(t, kiln, gpus.config);

  gpus.set({
    gpus: [{ ...ONE_BUSY_GPU.gpus[0]!, use: 0, used: 512 }],
    apps: [],
  });
  const released = await events.next<PanelUpdated>('widget.panel_updated', { timeoutMs: 10_000 });

  assert.deepEqual(stats(released.payload.panel.content), { 'gpu-0-use': 0, 'gpu-0-vram': '0.5 / 24.0' });
  const card = released.payload.panel.content!.blocks[0]!;
  assert.deepEqual(card.kind === 'card' && card.blocks?.find((b) => b.kind === 'table'), {
    kind: 'table',
    id: 'gpu-0-processes',
    title: 'Holding it',
    columns: ['PID', 'Process', 'VRAM'],
    rows: [],
  });
  assert.deepEqual((await panelOf(kiln))?.content, released.payload.panel.content);
});

test('when nvidia-smi fails, the panel says so and the GPUs come back once it answers again', async (t) => {
  const kiln = await startTestKiln(t);
  const gpus = fakeGpus(t, { gpus: [], apps: [], fail: 'NVIDIA-SMI has failed because it could not communicate with the NVIDIA driver.' });
  const { events, first } = await startGpuMonitor(t, kiln, gpus.config);

  assert.deepEqual(first.content, {
    blocks: [
      {
        kind: 'card',
        id: 'unavailable',
        title: 'No GPU reading',
        text: 'nvidia-smi failed: NVIDIA-SMI has failed because it could not communicate with the NVIDIA driver.',
      },
    ],
  });

  gpus.set(ONE_BUSY_GPU);
  const back = await events.next<PanelUpdated>('widget.panel_updated', { timeoutMs: 10_000 });
  assert.equal(stats(back.payload.panel.content)['gpu-0-use'], 37);
});

test('the panel has no controls that change GPU state, and the Widget only ever queries the GPU', async (t) => {
  const kiln = await startTestKiln(t);
  const gpus = fakeGpus(t, ONE_BUSY_GPU);
  const { events, first } = await startGpuMonitor(t, kiln, gpus.config);
  gpus.set({ gpus: [{ ...ONE_BUSY_GPU.gpus[0]!, use: 90 }], apps: ONE_BUSY_GPU.apps });
  await events.next('widget.panel_updated', { timeoutMs: 10_000 });

  const kinds = (blocks: PanelContent['blocks']): string[] =>
    blocks.flatMap((b) => [b.kind, ...(b.kind === 'card' ? kinds(b.blocks ?? []) : [])]);
  assert.ok(!kinds(first.content!.blocks).includes('button'));
  assert.ok(!kinds((await panelOf(kiln))!.content!.blocks).includes('button'));
  const info = (await kiln.api<WidgetInfo[]>('GET', '/api/widgets')).find((w) => w.id === 'gpu-monitor')!;
  assert.deepEqual(info.manifest.provides?.actions ?? [], []);
  for (const action of ['unload', 'prepare', 'kill']) {
    assert.equal((await kiln.request('POST', `/api/widgets/gpu-monitor/actions/${action}`, { panelId: 'gpus' })).status, 404);
  }
  const calls = readFileSync(`${gpus.file}.calls`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]);
  assert.ok(calls.length >= 4);
  for (const args of calls) assert.ok(args.every((a) => /^--(query-[a-z-]+|format)=/.test(a)), `not a query: ${args.join(' ')}`);
});

test('crashing or stopping the GPU monitor leaves the core and other Widgets running', async (t) => {
  const kiln = await startTestKiln(t);
  await kiln.installFakeAgent({ script: [] });
  const gpus = fakeGpus(t, ONE_BUSY_GPU);
  const { events } = await startGpuMonitor(t, kiln, gpus.config);
  const widgets = () => kiln.api<WidgetInfo[]>('GET', '/api/widgets');
  const byId = async (id: string) => (await widgets()).find((w) => w.id === id)!;
  const agentBefore = await byId('fake-agent');

  process.kill((await byId('gpu-monitor')).pid!);
  await events.next('widget.restarting', { timeoutMs: 10_000 });
  const republished = await events.next<PanelUpdated>('widget.panel_updated', { timeoutMs: 15_000 });

  assert.equal(stats(republished.payload.panel.content)['gpu-0-use'], 37);
  await kiln.api('GET', '/api/status'); // the core still answers (throws otherwise)
  const agentAfter = await byId('fake-agent');
  assert.equal(agentAfter.state, 'ready');
  assert.equal(agentAfter.pid, agentBefore.pid);

  await kiln.api('POST', '/api/widgets/gpu-monitor/stop');
  await events.next('widget.stopped', { timeoutMs: 10_000 });
  assert.equal((await byId('gpu-monitor')).state, 'stopped');
  assert.equal((await panelOf(kiln))?.content ?? null, null);
  assert.equal((await byId('fake-agent')).state, 'ready');
  assert.equal((await byId('fake-agent')).pid, agentBefore.pid);
});

test('each GPU gets its own card, and a reading nvidia-smi has not got shows as n/a', async (t) => {
  const kiln = await startTestKiln(t);
  const gpus = fakeGpus(t, {
    gpus: [
      { index: 0, uuid: 'GPU-aaaa', name: 'NVIDIA GeForce RTX 4090', use: 37, used: 12288, total: 24576 },
      { index: 1, uuid: 'GPU-bbbb', name: 'NVIDIA GeForce RTX 3060', use: null, used: 0, total: 12288 },
    ],
    apps: [
      { uuid: 'GPU-aaaa', pid: 4242, name: 'C:\\Python\\python.exe', used: 10240 },
      { uuid: 'GPU-aaaa', pid: 777, name: 'llama-server.exe', used: null },
    ],
  });

  const { first } = await startGpuMonitor(t, kiln, gpus.config);

  assert.deepEqual(first.content, {
    blocks: [
      {
        kind: 'card',
        id: 'gpu-0',
        title: 'GPU 0: NVIDIA GeForce RTX 4090',
        data: { memoryUsedMiB: 12288, memoryTotalMiB: 24576 },
        blocks: [
          { kind: 'stat', id: 'gpu-0-use', label: 'Use', value: 37, unit: '%' },
          { kind: 'stat', id: 'gpu-0-vram', label: 'VRAM', value: '12.0 / 24.0', unit: 'GB' },
          {
            kind: 'table',
            id: 'gpu-0-processes',
            title: 'Holding it',
            columns: ['PID', 'Process', 'VRAM'],
            rows: [
              [4242, 'C:\\Python\\python.exe', '10.0 GB'],
              [777, 'llama-server.exe', 'n/a'],
            ],
          },
        ],
      },
      {
        kind: 'card',
        id: 'gpu-1',
        title: 'GPU 1: NVIDIA GeForce RTX 3060',
        data: { memoryUsedMiB: 0, memoryTotalMiB: 12288 },
        blocks: [
          { kind: 'stat', id: 'gpu-1-use', label: 'Use', value: 'n/a' },
          { kind: 'stat', id: 'gpu-1-vram', label: 'VRAM', value: '0.0 / 12.0', unit: 'GB' },
          { kind: 'table', id: 'gpu-1-processes', title: 'Holding it', columns: ['PID', 'Process', 'VRAM'], rows: [] },
        ],
      },
    ],
  } satisfies PanelContent);
});

test("Add a model sizes its recommendation to the GPU monitor's reading, using the GPU with the most free VRAM", async (t) => {
  const kiln = await startTestKiln(t);
  const gpus = fakeGpus(t, {
    gpus: [
      { index: 0, uuid: 'GPU-aaaa', name: 'NVIDIA GeForce RTX 4090', use: 37, used: 12288, total: 24576 },
      { index: 1, uuid: 'GPU-bbbb', name: 'NVIDIA GeForce RTX 3060', use: 0, used: 4096, total: 12288 },
    ],
    apps: [],
  });
  await startGpuMonitor(t, kiln, gpus.config);
  const path = join(tempDir(t, 'kiln-gguf'), 'Tiny-Test-Q4_K_M.gguf');
  writeFileSync(path, testGguf());

  const info = await kiln.api<ModelInspection>('POST', '/api/local-models/inspect', { path });
  assert.deepEqual(info.gpu, { source: 'gpu-monitor', name: 'GPU 0: NVIDIA GeForce RTX 4090', memoryUsedMiB: 12288, memoryTotalMiB: 24576 });
  // 128 KB of f16 cache a token: 64K (8 GB) fits the 10.5 GB left after 12 GB in use and the headroom; 128K doesn't.
  const r = info.recommended;
  assert.deepEqual([r.contextSize, r.gpuLayers, r.offloaded], [65536, 33, false]);
  assert.match(r.reasons.contextSize, /^fits 20 of 24 GB at 64K; 128K would take 28 GB/);
  assert.equal(r.reasons.gpuLayers, '33 puts all 32 layers and the output layer on the GPU');
  assert.equal(r.figures.freeBytes, 12 * 1024 ** 3);
});

// Opt-in, read-only: set KILN_REAL_GPU=1 to have the Widget read this machine's GPUs with the real
// nvidia-smi. It only runs the two `--query-*` calls; it never changes GPU state or touches any process.
test("the real nvidia-smi shows this machine's GPUs", { skip: process.env.KILN_REAL_GPU !== '1' && 'set KILN_REAL_GPU=1' }, async (t) => {
  const kiln = await startTestKiln(t);

  const { first } = await startGpuMonitor(t, kiln, { intervalMs: 1000 });

  const cards = first.content!.blocks.filter((b) => b.kind === 'card');
  assert.ok(cards.length > 0 && cards.every((c) => /^gpu-\d+$/.test(c.id ?? '')), JSON.stringify(first.content));
  for (const card of cards) assert.match(card.kind === 'card' ? (card.title ?? '') : '', /^GPU \d+: .+/);
});

test('a machine with no NVIDIA GPU gets a plain message, not an empty panel', async (t) => {
  const kiln = await startTestKiln(t);
  const gpus = fakeGpus(t, { gpus: [], apps: [] });
  const { first } = await startGpuMonitor(t, kiln, { ...gpus.config, nvidiaSmi: ['kiln-no-such-nvidia-smi'] });

  assert.deepEqual(first.content, {
    blocks: [{ kind: 'card', id: 'unavailable', title: 'No GPU reading', text: 'nvidia-smi was not found, so there is no NVIDIA GPU to show.' }],
  });
});
