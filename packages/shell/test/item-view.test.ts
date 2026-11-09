import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Item, Project, SessionInfo } from '@kiln/widget-sdk';
import { startTestKiln, tempDir, type FakeAgentStep } from '@kiln/testing';
import { openShell } from '@kiln/testing/browser';
import { seedScratch, writeRepoFile } from '@kiln/testing/scratch';

test('the Item view streams the Session Thread live and shows the Exit status and the branch', async (t) => {
  const kiln = await startTestKiln(t);
  await kiln.installFakeAgent({
    script: [
      { do: 'progress', text: 'reading the Ticket' },
      { do: 'tool', name: 'think', times: 5, intervalMs: 150 },
      { do: 'write', path: 'answer.txt', content: '42\n' },
      { do: 'commit', message: 'Answer' },
      { do: 'progress', text: 'committed the answer' },
    ],
  });
  seedScratch(kiln.repo);
  writeRepoFile(kiln.repo, '.kiln/settings.json', JSON.stringify({ testCommand: 'node -e "process.exit(0)"' }));
  kiln.repo.git('add', '.');
  kiln.repo.git('commit', '-q', '-m', 'Add a test command');
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const page = await openShell(t, kiln, `/projects/${project.id}`);

  await page
    .getByRole('region', { name: 'Ticket Implementing', exact: true })
    .getByRole('link', { name: 'Draw the columns' })
    .click();
  await page.getByRole('heading', { name: 'Draw the columns' }).waitFor();
  await page.evaluate(() => ((window as unknown as { notReloaded: boolean }).notReloaded = true));
  await page.getByRole('button', { name: 'Start Session' }).click();

  const thread = page.getByRole('log', { name: 'Thread' });
  await thread.getByRole('button', { name: /Steps/ }).waitFor();
  const exit = page.getByRole('region', { name: 'Exit' });
  await exit.getByText('Exit met').waitFor();
  for (const check of ['Branch has commits', 'Working tree clean', 'Tests pass']) {
    await exit.getByRole('listitem').filter({ hasText: check }).filter({ hasText: 'met' }).waitFor();
  }
  const details = page.getByRole('region', { name: 'Details' });
  await details.getByText('Review', { exact: true }).waitFor();

  const [session] = await kiln.api<SessionInfo[]>('GET', '/api/sessions');
  await details.getByText(session!.branch!, { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => (window as unknown as { notReloaded?: boolean }).notReloaded), true);
});

/** Opens a registered Ticket's Item view, with a fake Agent running `script`. */
async function openTicket(t: Parameters<typeof startTestKiln>[0], script: FakeAgentStep[]) {
  const kiln = await startTestKiln(t, { env: { KILN_KNOWLEDGE_DIR: tempDir(t, 'kiln-knowledge') } });
  await kiln.installFakeAgent({ script });
  seedScratch(kiln.repo);
  await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const ticket = (await kiln.api<Item[]>('GET', '/api/items')).find((i) => i.title === 'Draw the columns')!;
  const page = await openShell(t, kiln, `/items/${encodeURIComponent(ticket.id)}`);
  await page.getByRole('heading', { name: 'Draw the columns' }).waitFor();
  return { kiln, page, thread: page.getByRole('log', { name: 'Thread' }) };
}

test('a person sends a Thread message from the Item view; it starts a Session that hears it, and its Digest shows in the Thread', async (t) => {
  const { page, thread } = await openTicket(t, [
    { do: 'wait_for_message' },
    { do: 'kiln_tool', name: 'write_digest', input: { decided: ['Three columns'], changed: [], open: ['Colours'] } },
    { do: 'finish', reason: 'error' },
  ]);

  await page.getByRole('textbox', { name: 'Message' }).fill('Use three columns');
  await page.getByRole('button', { name: 'Send' }).click();

  await thread.getByText('Person: Use three columns').waitFor();
  await thread.getByText(/Digest: decided Three columns/).waitFor();
  const closed = thread.getByRole('button', { name: /Steps/, expanded: false });
  while ((await closed.count()) > 0) await closed.first().click();
  await thread.getByText('heard: Use three columns').waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Message' }).inputValue(), '', 'the box is cleared once sent');
});

test('streaming into the Thread keeps the text a person selected and where they scrolled to', async (t) => {
  const { page, thread } = await openTicket(t, [
    { do: 'tool', name: 'think', times: 'forever', intervalMs: 40 },
  ]);
  await page.getByRole('button', { name: 'Start Session' }).click();
  await thread.getByText('Session started').waitFor();
  await thread.getByRole('button', { name: /Steps/ }).click();
  // Let the Thread overflow its box, then scroll up away from the bottom and select a line.
  await page.waitForFunction(() => {
    const log = document.querySelector('[role="log"][aria-label="Thread"]')!;
    return log.scrollHeight > log.clientHeight + 200;
  });
  const before = await page.evaluate(() => {
    const log = document.querySelector('[role="log"][aria-label="Thread"]')!;
    log.scrollTop = 40;
    const line = [...log.querySelectorAll('li')].find((li) => li.textContent === 'Session started')!;
    const range = document.createRange();
    range.selectNodeContents(line);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    return { scrollTop: log.scrollTop, count: log.querySelectorAll('li').length };
  });

  await page.waitForFunction((count) => document.querySelectorAll('[role="log"][aria-label="Thread"] li').length > count + 5, before.count);

  const after = await page.evaluate(() => ({
    scrollTop: document.querySelector('[role="log"][aria-label="Thread"]')!.scrollTop,
    selected: getSelection()!.toString(),
  }));
  assert.equal(after.selected, 'Session started');
  assert.equal(after.scrollTop, before.scrollTop);
});

test('the Thread follows new lines while the person is at its bottom', async (t) => {
  const { page, thread } = await openTicket(t, [{ do: 'tool', name: 'think', times: 'forever', intervalMs: 40 }]);
  await page.getByRole('button', { name: 'Start Session' }).click();
  await thread.getByText('Session started').waitFor();
  await thread.getByRole('button', { name: /Steps/ }).click();
  await page.waitForFunction(() => {
    const log = document.querySelector('[role="log"][aria-label="Thread"]')!;
    return log.scrollHeight > log.clientHeight + 200 && log.scrollHeight - log.scrollTop - log.clientHeight < 2;
  });
});
