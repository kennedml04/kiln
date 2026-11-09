import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { Item, Project } from '@kiln/widget-sdk';
import { startTestKiln, tempDir, type FakeAgentStep } from '@kiln/testing';
import { openShell } from '@kiln/testing/browser';
import { seedScratch } from '@kiln/testing/scratch';

async function openTicket(t: TestContext, script: FakeAgentStep[], viewport?: { width: number; height: number }) {
  const kiln = await startTestKiln(t, { env: { KILN_KNOWLEDGE_DIR: tempDir(t, 'kiln-knowledge') } });
  await kiln.installFakeAgent({ script });
  seedScratch(kiln.repo);
  await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const ticket = (await kiln.api<Item[]>('GET', '/api/items')).find((i) => i.title === 'Draw the columns')!;
  const page = await openShell(t, kiln, `/items/${encodeURIComponent(ticket.id)}`);
  if (viewport) await page.setViewportSize(viewport);
  await page.getByRole('heading', { name: 'Draw the columns' }).waitFor();
  return { kiln, page, ticket, thread: page.getByRole('log', { name: 'Thread' }) };
}

const tool = (name: string, input: unknown): FakeAgentStep => ({ do: 'tool', name, input, times: 1 });

test('steps fold into one group whose opened lines read as verbs, and open again for their detail', async (t) => {
  const long = 'x'.repeat(5000);
  const { page, thread } = await openTicket(t, [
    tool('Read', { file_path: 'a/b.txt' }),
    tool('Bash', { command: `npm test\n${long}` }),
    tool('Edit', { file_path: 'a/b.txt', old_string: 'one\ntwo', new_string: 'three' }),
    tool('Write', { file_path: 'c.txt', content: 'secret contents\nline2\nline3' }),
    tool('Grep', { pattern: 'foo' }),
    tool('mcp__kiln__raise_ask', { question: 'Which colour?' }),
    tool('Odd', { thing: 'value' }),
    { do: 'progress', text: 'first line of a note\nsecond line' },
    { do: 'usage', inputTokens: 1, outputTokens: 1 },
    { do: 'progress', text: 'one-line note' },
  ]);
  await page.getByRole('button', { name: 'Start Session' }).click();
  const toggle = thread.getByRole('button', { name: /^Steps \(9\)/ });
  await toggle.waitFor();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await thread.getByText('Read a/b.txt').count(), 0, 'folded by default');
  await toggle.click();
  for (const line of [
    'Read a/b.txt',
    'Ran npm test',
    'Edited a/b.txt (-2/+1)',
    'Wrote c.txt (+3 lines)',
    'Searched "foo"',
    'kiln: raise_ask "Which colour?"',
    'Odd "value"',
    'first line of a note',
  ]) {
    await thread.getByRole('button', { name: line }).waitFor();
  }
  assert.equal(await thread.locator('.steps-list').getByText('one-line note').count(), 1);
  assert.equal(await thread.locator('.steps-list').getByRole('button', { name: /one-line note/ }).count(), 0, 'no toggle for a one-line note');
  assert.equal(await thread.getByText(/Turn 1: 1 in/).count(), 1, 'usage rides inside the group');

  await thread.getByRole('button', { name: 'Ran npm test' }).click();
  await thread.getByText('show all').waitFor();
  assert.equal(await thread.locator('pre').first().innerText().then((s) => s.length), 2000);
  await thread.getByText('show all').click();
  assert.ok((await thread.locator('pre').first().innerText()).length > 4000);

  await thread.getByRole('button', { name: 'Wrote c.txt (+3 lines)' }).click();
  assert.equal(await thread.getByText('secret contents').count(), 0, 'Write contents never show');
  await thread.getByText('+3 lines', { exact: true }).waitFor();
});

test('a group still filling shows its latest step; open state survives new steps; finished groups stay folded after a reload', async (t) => {
  const { page, kiln, thread } = await openTicket(t, [
    tool('Read', { file_path: 'first.txt' }),
    { do: 'wait_for_message' },
    tool('Bash', { command: 'npm run later' }),
    { do: 'wait_for_message' },
  ]);
  await page.getByRole('button', { name: 'Start Session' }).click();
  const toggle = thread.getByRole('button', { name: /Steps/ });
  await toggle.getByText(/Read first\.txt/).waitFor();
  assert.equal(await toggle.getAttribute('aria-live'), null);
  assert.equal(await toggle.locator('[aria-live="off"]').count(), 1);
  await toggle.click();
  await thread.getByRole('button', { name: 'Read first.txt', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message' }).fill('go');
  await page.getByRole('button', { name: 'Send' }).click();
  await thread.getByText('Person: go').waitFor();
  const groups = thread.getByRole('button', { name: /Steps/ });
  await groups.nth(1).getByText(/Ran npm run later/).waitFor();
  assert.equal(await groups.nth(0).getAttribute('aria-expanded'), 'true', 'open group stays open');
  assert.equal(await thread.getByRole('button', { name: 'Read first.txt', exact: true }).getAttribute('aria-expanded'), 'true');
  assert.equal(await groups.nth(0).getByText(/Read first/).count(), 0, 'an ended group shows no latest step');

  const items = await kiln.api<Item[]>('GET', '/api/items');
  assert.ok(items.length > 0);
  await page.reload();
  const again = page.getByRole('log', { name: 'Thread' }).getByRole('button', { name: /Steps/ });
  await again.first().waitFor();
  assert.equal(await again.first().getAttribute('aria-expanded'), 'false', 'folded after reload');
});

test('new steps keep the view at the bottom, and leave it alone when scrolled up', async (t) => {
  const { page, thread } = await openTicket(t, [{ do: 'tool', name: 'think', times: 'forever', intervalMs: 40 }]);
  await page.getByRole('button', { name: 'Start Session' }).click();
  await thread.getByRole('button', { name: /Steps/ }).click();
  const state = () =>
    page.evaluate(() => {
      const log = document.querySelector('[role="log"][aria-label="Thread"]')!;
      return { over: log.scrollHeight - log.clientHeight, gap: log.scrollHeight - log.scrollTop - log.clientHeight, top: log.scrollTop };
    });
  await page.waitForFunction(() => {
    const log = document.querySelector('[role="log"][aria-label="Thread"]')!;
    return log.scrollHeight > log.clientHeight + 200 && log.scrollHeight - log.scrollTop - log.clientHeight < 2;
  });
  await page.evaluate(() => (document.querySelector('[role="log"][aria-label="Thread"]')!.scrollTop = 30));
  const before = await state();
  await page.waitForFunction((over) => {
    const log = document.querySelector('[role="log"][aria-label="Thread"]')!;
    return log.scrollHeight - log.clientHeight > over + 100;
  }, before.over);
  assert.equal((await state()).top, 30);
});

test('on a phone, folded lines are one line with an ellipsis and the toggles are 44px tall', async (t) => {
  const { page, thread } = await openTicket(
    t,
    [tool('Bash', { command: 'echo ' + 'long '.repeat(80) }), { do: 'progress', text: 'tail' }],
    { width: 390, height: 800 },
  );
  await page.getByRole('button', { name: 'Start Session' }).click();
  const toggle = thread.getByRole('button', { name: /Steps/ });
  await toggle.waitFor();
  await toggle.click();
  const line = thread.getByRole('button', { name: /Ran echo/ });
  await line.waitFor();
  const info = await line.evaluate((el) => {
    const style = getComputedStyle(el);
    return { height: el.getBoundingClientRect().height, wrap: style.whiteSpace, ellipsis: style.textOverflow };
  });
  assert.ok(info.height >= 44 && info.height < 60, `height ${info.height}`);
  assert.equal(info.wrap, 'nowrap');
  assert.equal(info.ellipsis, 'ellipsis');
  assert.ok((await toggle.boundingBox())!.height >= 44);
});

test('the Project Thread groups steps the same way', async (t) => {
  const kiln = await startTestKiln(t);
  seedScratch(kiln.repo);
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  await kiln.installFakeAgent({ script: [{ do: 'wait_for_message' }, tool('Read', { file_path: 'x.txt' }), { do: 'wait_for_message' }] });
  const page = await openShell(t, kiln, `/projects/${project.id}`);
  await page.getByRole('link', { name: 'Project Thread' }).click();
  await page.getByRole('textbox', { name: 'Message' }).fill('hello');
  await page.getByRole('button', { name: 'Send' }).click();
  const toggle = page.getByRole('log', { name: 'Thread' }).getByRole('button', { name: /^Steps \(2\)/ });
  await toggle.waitFor();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
});
