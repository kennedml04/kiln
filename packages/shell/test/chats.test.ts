import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ScratchChat } from '@kiln/widget-sdk';
import { startTestKiln, tempDir } from '@kiln/testing';
import { openShell } from '@kiln/testing/browser';

const PHONE = { width: 390, height: 844 };

const startKiln = (t: Parameters<typeof startTestKiln>[0], options: Parameters<typeof startTestKiln>[1] = {}) =>
  startTestKiln(t, { ...options, env: { KILN_KNOWLEDGE_DIR: tempDir(t, 'kiln-knowledge') } });

const ECHO = [{ do: 'wait_for_message' }, { do: 'wait_for_message' }, { do: 'wait_for_message' }] as const;

test('New chat from the header: the chat is made on the first message, then renamed, pinned and archived', async (t) => {
  const kiln = await startKiln(t);
  await kiln.installFakeAgent({ script: [...ECHO] });
  const page = await openShell(t, kiln);

  await page.getByRole('link', { name: 'New chat' }).click();
  await page.getByRole('heading', { name: 'New chat' }).waitFor();
  // Opening the view makes no chat.
  assert.deepEqual(await kiln.api<ScratchChat[]>('GET', '/api/chats'), []);

  await page.getByRole('textbox', { name: 'Message' }).fill('How does the Tracker pick a key?');
  await page.getByRole('button', { name: 'Send' }).click();
  const log = page.getByRole('log', { name: 'Thread' });
  await log.getByText('heard: How does the Tracker pick a key?').waitFor();
  await page.getByRole('button', { name: 'How does the Tracker pick a key?' }).waitFor();
  assert.equal((await kiln.api<ScratchChat[]>('GET', '/api/chats')).length, 1);

  await page.getByRole('textbox', { name: 'Message' }).fill('And a second thing');
  await page.getByRole('button', { name: 'Send' }).click();
  await log.getByText('heard: And a second thing').waitFor();

  await page.getByRole('button', { name: 'How does the Tracker pick a key?' }).click();
  await page.getByLabel('Chat title').fill('Tracker keys');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: 'Tracker keys' }).waitFor();
  await page.getByRole('button', { name: 'Pin' }).click();
  await page.getByRole('button', { name: 'Unpin' }).waitFor();
  const [chat] = await kiln.api<ScratchChat[]>('GET', '/api/chats');
  assert.equal(chat!.title, 'Tracker keys');
  assert.equal(chat!.pinned, true);

  await page.getByRole('button', { name: 'Archive' }).click();
  await page.getByText('Archived. Sending a message brings it back.').waitFor();
  assert.equal((await kiln.api<ScratchChat[]>('GET', '/api/chats')).length, 0);
  assert.equal((await kiln.api<ScratchChat[]>('GET', '/api/chats?archived=1')).length, 1);
});

test('the Chats page lists pinned chats first and has an Archived tab', async (t) => {
  const kiln = await startKiln(t);
  await kiln.installFakeAgent({ script: [{ do: 'wait_for_message' }] });
  const a = await kiln.api<{ chat: ScratchChat }>('POST', '/api/chats', { text: 'older question' });
  const b = await kiln.api<{ chat: ScratchChat }>('POST', '/api/chats', { text: 'newer question' });
  const c = await kiln.api<{ chat: ScratchChat }>('POST', '/api/chats', { text: 'old archived question' });
  await kiln.api('PATCH', `/api/chats/${a.chat.id}`, { pinned: true });
  await kiln.api('PATCH', `/api/chats/${c.chat.id}`, { archived: true });
  assert.ok(b.chat.id);
  const page = await openShell(t, kiln, '/chats');

  const items = page.getByRole('list').locator('li');
  await items.first().waitFor();
  assert.deepEqual(
    await items.locator('a').allInnerTexts(),
    ['older question', 'newer question'],
  );
  await page.getByRole('img', { name: 'Pinned' }).waitFor();

  await page.getByRole('tab', { name: 'Archived' }).click();
  await items.filter({ hasText: 'old archived question' }).waitFor();
  assert.equal(await items.count(), 1);
  await items.getByRole('link', { name: 'old archived question' }).click();
  await page.getByRole('button', { name: 'Unarchive' }).waitFor();
});

test('a chat Ask appears in Needs you labelled with the chat title', async (t) => {
  const kiln = await startKiln(t);
  await kiln.installFakeAgent({
    script: [
      { do: 'wait_for_message' },
      {
        do: 'ask',
        ask: { type: 'question', question: 'Which key style?', why: 'Two exist.', recommendation: 'short', blocking: false },
      },
      { do: 'wait_for_message' },
    ],
  });
  const page = await openShell(t, kiln);
  await page.getByRole('link', { name: 'New chat' }).click();
  await page.getByRole('textbox', { name: 'Message' }).fill('Key styles');
  await page.getByRole('button', { name: 'Send' }).click();

  await page.getByRole('link', { name: 'Needs you, 1 open' }).click();
  const ask = page.getByRole('article', { name: 'Which key style?' });
  await ask.getByRole('link', { name: 'Chat: Key styles' }).click();
  await page.getByRole('button', { name: 'Key styles' }).waitFor();
});

test('New chat works at phone width as an icon button, and the page does not scroll sideways', async (t) => {
  const kiln = await startKiln(t);
  await kiln.installFakeAgent({ script: [...ECHO] });
  const page = await openShell(t, kiln, '/', { viewport: PHONE });

  const button = page.getByRole('link', { name: 'New chat' });
  const box = (await button.boundingBox())!;
  assert.ok(box.width <= 48, `the New chat button is an icon (${box.width}px wide)`);
  await button.click();
  await page.getByRole('textbox', { name: 'Message' }).fill('A phone question');
  await page.getByRole('button', { name: 'Send' }).click();
  await page.getByRole('log', { name: 'Thread' }).getByText('heard: A phone question').waitFor();
  await page.goto(new URL('/chats', page.url()).href);
  await page.getByRole('link', { name: 'A phone question' }).waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `scrolls sideways by ${overflow}px`);
});

test('Viewers do not see New chat, and an Admin can show everyone\'s chats', async (t) => {
  const kiln = await startKiln(t, { login: 'tailscale' });
  await kiln.installFakeAgent({ script: [{ do: 'wait_for_message' }] });
  await kiln.api('PUT', '/api/users/vic', { role: 'viewer' });
  await kiln.api('PUT', '/api/users/mia', { role: 'member' });
  await kiln.as('mia').request('POST', '/api/chats', { text: "Mia's question" });

  const viewer = await openShell(t, kiln, '/', { as: 'vic' });
  await viewer.getByRole('link', { name: /^Needs you/ }).waitFor();
  assert.equal(await viewer.getByRole('link', { name: 'New chat' }).count(), 0);

  const admin = await openShell(t, kiln, '/chats');
  await admin.getByText('No chats yet. Use New chat to ask a quick question.').waitFor();
  await admin.getByLabel("Everyone's chats").check();
  const row = admin.getByRole('list').locator('li').filter({ hasText: "Mia's question" });
  await row.waitFor();
  assert.match(await row.innerText(), /mia/);
});
