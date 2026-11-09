// Makes the README's screenshots: a test core as a dev instance plays the demo Story in Replay
// on the fake Agent, beside two seeded Projects, and a headless browser photographs the Shell
// along the way. Not part of `npm test` (it lives outside the test globs). Run it by hand:
//   node --test scripts/readme-media.test.ts
// Frames land in docs/readme/shots/ (numbered, dark theme) with the page's text beside each one;
// scripts/readme-media.py turns them into the README's images.
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Page } from 'playwright';
import type { Ask, AskRaisedEvent, DemoState, Item, Project, StartResult, WidgetInfo } from '@kiln/widget-sdk';
import { startTestKiln, tempDir, type Cleanup, type TestKiln } from '@kiln/testing';
import { openShell } from '@kiln/testing/browser';

const OUT = join(process.cwd(), 'docs', 'readme', 'shots');
const STORY = 'Add `slugify(title)`';
// Tall enough for the Project view's three rows; frames are clipped to what the README needs.
const VIEWPORT = { width: 1440, height: 1300 };
const FRAME = { x: 0, y: 0, width: 1440, height: 900 };

type Events = Awaited<ReturnType<TestKiln['events']>>;

async function eventually<T>(what: string, check: () => Promise<T | undefined>, timeoutMs = 120_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== undefined) return value;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const nextAsk = async (events: Events, accept: (ask: Ask) => boolean): Promise<Ask> => {
  for (;;) {
    const { ask } = (await events.next<AskRaisedEvent>('ask.raised', { timeoutMs: 180_000 })).payload;
    if (accept(ask)) return ask;
  }
};

const answer = (kiln: TestKiln, ask: Ask, text: string) => kiln.api('POST', `/api/asks/${encodeURIComponent(ask.id)}/answer`, { answer: text });

/** A small git repo with `.scratch` Items, registered as a Project, so the board has company. */
async function seedProject(t: Cleanup, kiln: TestKiln, name: string, files: Record<string, string>): Promise<Project> {
  const path = join(tempDir(t, 'kiln-readme'), name);
  mkdirSync(path, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Kiln', '-c', 'user.email=kiln@example.com', ...args], { cwd: path, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  for (const [relative, content] of Object.entries({ 'README.md': `# ${name}\n`, ...files })) {
    mkdirSync(dirname(join(path, relative)), { recursive: true });
    writeFileSync(join(path, relative), content);
  }
  git('add', '.');
  git('commit', '-q', '-m', 'Seed');
  return kiln.api<Project>('POST', '/api/projects', { path });
}

const epic = (title: string, order: number) => `---\ntitle: ${title}\norder: ${order}\n---\n\n${title}.\n`;
const story = (title: string, epicId: string, stage: string, body: string) => `---\ntitle: ${title}\nepic: ${epicId}\nstage: ${stage}\nblocked-by: []\n---\n\n${body}\n`;
const ticket = (n: string, title: string, what: string, blockedBy: string, status: string) =>
  `# ${n}: ${title}\n\n**What to build:** ${what}\n\n**Blocked by:** ${blockedBy}\n\n**Status:** ${status}\n\n- [ ] Done\n`;

let shot = 0;
type Clip = 'frame' | 'boards';
async function snap(page: Page, path: string, name: string, clip: Clip = 'frame', settleMs = 1200) {
  // Always a fresh load, so every frame shows the core's state and never a stale view.
  await page.goto(`${new URL(page.url()).origin}${path}`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(settleMs);
  let box = FRAME;
  if (clip === 'boards') {
    // The Project view from "Up next" down to the Ticket row: the boards, without the folder path above them.
    const top = await page.getByRole('region', { name: 'Up next', exact: true }).boundingBox();
    const bottom = await page.getByRole('region', { name: 'Ticket Items', exact: true }).boundingBox();
    if (!top || !bottom) throw new Error(`${path}: the boards are not on the page`);
    box = { x: 233, y: Math.round(top.y) - 24, width: 1440 - 233, height: Math.round(bottom.y + bottom.height) - Math.round(top.y) + 48 };
  }
  // The frames are published: the throwaway folders under this PC's temp and the checkout's own
  // path read as plain example paths.
  await page.evaluate(() => {
    const swaps: [RegExp, string][] = [
      [/[A-Za-z]:\\Users\\[^\\\s]+\\AppData\\Local\\Temp\\kiln-data-[^\\\s]+/g, 'C:\\Kiln'],
      [/[A-Za-z]:\\Users\\[^\\\s]+\\AppData\\Local\\Temp\\kiln-readme-[^\\\s]+/g, 'C:\\Projects'],
      [/[A-Za-z]:\\Users\\[^\\\s]+\\projects\\Kiln/g, 'C:\\Projects\\kiln'],
    ];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      let text = node.nodeValue ?? '';
      for (const [from, to] of swaps) text = text.replace(from, to);
      if (text !== node.nodeValue) node.nodeValue = text;
    }
  });
  shot += 1;
  const file = join(OUT, `${String(shot).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file, clip: box });
  // The page's text beside the frame, so the frame can be checked without opening it.
  const text = (await page.locator('body').innerText()).replace(/[ \t]+/g, ' ');
  writeFileSync(`${file}.txt`, text);
  console.log(`shot ${file} ${box.width}x${box.height}`);
}

test('README media: the demo Story from Grill to Shipped, photographed', { timeout: 600_000 }, async (t) => {
  mkdirSync(OUT, { recursive: true });
  const kiln = await startTestKiln(t, { devInstance: true });
  const events = await kiln.events();

  await seedProject(t, kiln, 'notes-api', {
    '.scratch/epics/sync.md': epic('Sync', 1),
    '.scratch/offline-sync/story.md': story('Offline sync', 'sync', 'spec', 'Edits made offline merge when the device is back.'),
    '.scratch/offline-sync/spec.md': '# Spec: Offline sync\n\nStatus: ready-for-agent\n',
    '.scratch/offline-sync/issues/01-change-log.md': ticket('01', 'Change log', 'Record every edit with a clock.', 'None', 'ready-for-agent'),
    '.scratch/offline-sync/issues/02-merge-on-reconnect.md': ticket('02', 'Merge on reconnect', 'Replay the log against the server.', '01', 'ready-for-agent'),
    '.scratch/markdown-export/story.md': story('Export to Markdown', 'sync', 'shipped', 'One file per note.'),
  });
  await seedProject(t, kiln, 'site', {
    '.scratch/epics/launch.md': epic('Launch', 1),
    '.scratch/dark-mode/story.md': story('Dark mode', 'launch', 'tickets', 'Follow the system theme, with a switch.'),
    '.scratch/dark-mode/spec.md': '# Spec: Dark mode\n\nStatus: ready-for-agent\n',
    '.scratch/dark-mode/issues/01-theme-tokens.md': ticket('01', 'Theme tokens', 'Colours as CSS variables.', 'None', 'ready-for-agent'),
    '.scratch/pricing-page/story.md': story('Pricing page', 'launch', 'grill', 'Three tiers, yearly and monthly.'),
  });

  const started = await kiln.api<DemoState>('POST', '/api/demo/start', { mode: 'replay' });
  const project = (await kiln.api<Project[]>('GET', '/api/projects')).find((p) => p.id === started.projectId)!;
  await eventually('the fake Agent to be ready', async () =>
    (await kiln.api<WidgetInfo[]>('GET', '/api/widgets')).find((w) => w.id === 'fake-agent')?.state === 'ready' ? true : undefined,
  );

  const page = await openShell(t, kiln, '/', { viewport: VIEWPORT });
  const projectPath = `/projects/${encodeURIComponent(project.id)}`;
  await page.getByRole('article', { name: STORY, exact: true }).first().waitFor();
  await snap(page, '/', 'home-grill');
  await snap(page, projectPath, 'project-grill', 'boards');

  // The person starts the Story; the griller asks two questions.
  const item = (await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`)).find((i) => i.title === STORY)!;
  await kiln.api<StartResult>('POST', `/api/items/${encodeURIComponent(item.id)}/start`);
  const ask1 = await nextAsk(events, (a) => a.itemId === item.id && a.type !== 'review');
  await page.goto(`${kiln.url}/needs-you`);
  await page.getByRole('heading', { name: ask1.question }).waitFor();
  await snap(page, '/needs-you', 'needs-you-grill-ask');
  await snap(page, '/', 'home-grilling');
  await snap(page, `/items/${encodeURIComponent(item.id)}`, 'story-thread-grill');
  await answer(kiln, ask1, ask1.recommendation);
  const ask2 = await nextAsk(events, (a) => a.itemId === item.id && a.type !== 'review');
  await answer(kiln, ask2, ask2.recommendation);

  // The Spec Gate, then the Tickets Gate.
  const specGate = await nextAsk(events, (a) => a.itemId === item.id && a.type === 'review');
  await page.goto(`${kiln.url}/needs-you`);
  await page.getByRole('heading', { name: specGate.question }).waitFor();
  await snap(page, '/needs-you', 'needs-you-spec-gate');
  await snap(page, projectPath, 'project-spec', 'boards');
  await answer(kiln, specGate, 'Approve');
  const ticketsGate = await nextAsk(events, (a) => a.itemId === item.id && a.type === 'review');
  await snap(page, projectPath, 'project-tickets', 'boards');
  await answer(kiln, ticketsGate, 'Approve');

  // Ticket 01 is implemented and reviewed; its Review Gate waits in Needs you.
  const ticketIds = [`${project.id}/ticket/slugify/01`, `${project.id}/ticket/slugify/02`];
  const review1 = await nextAsk(events, (a) => a.type === 'review' && a.itemId === ticketIds[0]);
  await snap(page, projectPath, 'project-review', 'boards');
  await snap(page, `/items/${encodeURIComponent(ticketIds[0]!)}`, 'ticket-thread');
  await page.goto(`${kiln.url}/needs-you`);
  await page.getByRole('heading', { name: review1.question }).waitFor();
  await snap(page, '/needs-you', 'needs-you-review-gate');
  await snap(page, '/', 'home-review');
  await answer(kiln, review1, 'Approve');

  const shipped = (id: string) =>
    eventually(`${id} to ship`, async () => {
      const now = (await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`)).find((i) => i.id === id);
      return now?.stage === 'shipped' ? now : undefined;
    });
  await shipped(ticketIds[0]!);
  await snap(page, projectPath, 'project-implementing-02', 'boards');
  await snap(page, '/', 'home-implementing-02');
  const review2 = await nextAsk(events, (a) => a.type === 'review' && a.itemId === ticketIds[1]);
  await answer(kiln, review2, 'Approve');
  await shipped(ticketIds[1]!);
  await shipped(item.id);
  await snap(page, projectPath, 'project-shipped', 'boards', 2500);
  await snap(page, '/', 'home-shipped', 'frame', 2500);
  await snap(page, `/items/${encodeURIComponent(item.id)}`, 'story-shipped');

  // The rest of the Shell.
  await snap(page, '/widgets', 'widgets');
  await snap(page, '/settings', 'settings');
  await snap(page, '/shipped', 'shipped-history');
});
