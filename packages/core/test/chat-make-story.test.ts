import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Item, KilnEvent, OpenChatResult, Project, ScratchChat, ThreadEntry } from '@kiln/widget-sdk';
import { startTestKiln, tempDir, type EventStream, type TestKiln } from '@kiln/testing';
import { seedScratch, readRepoFile } from '@kiln/testing/scratch';

type ProgressEvent = KilnEvent<'session.progress', { sessionId: string; itemId: string; text?: string }>;

async function progress(events: EventStream, match: RegExp, timeoutMs = 15_000): Promise<ProgressEvent> {
  for (;;) {
    const event = await events.next<ProgressEvent>('session.progress', { timeoutMs });
    if (event.payload.text && match.test(event.payload.text)) return event;
  }
}

/** A chat whose Session drafts a Story when asked, and a Project with an Epic to put it under. */
async function setup(t: Parameters<typeof startTestKiln>[0]) {
  const kiln = await startTestKiln(t, { env: { KILN_KNOWLEDGE_DIR: tempDir(t, 'kiln-knowledge') } });
  seedScratch(kiln.repo);
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const agent = await kiln.installFakeAgent({
    script: {
      chat: [
        { do: 'wait_for_message' },
        { do: 'wait_for_message' },
        { do: 'kiln_tool', name: 'draft_story', input: { title: 'Heatset sizes', description: 'Use M3 heatsets, 4mm long.' } },
        { do: 'wait_for_message' },
        { do: 'finish', reason: 'error' },
      ],
      '*': [{ do: 'report_seed' }, { do: 'wait_for_message' }, { do: 'finish', reason: 'error' }],
    },
  });
  const events = await kiln.events();
  const chat = await kiln.api<OpenChatResult>('POST', '/api/chats', { text: 'What heatset size for M3 do we use?' });
  await progress(events, /^heard: What heatset/);
  const epic = (await kiln.api<Item[]>('GET', `/api/items?project=${encodeURIComponent(project.id)}`)).find((i) => i.kind === 'epic')!;
  return { kiln, project, agent, events, chat: chat.chat, epic };
}

const draftPath = (chat: ScratchChat, rest = 'story-draft') => `/api/chats/${chat.id}/${rest}`;

test('Make it a Story: the chat drafts, the person edits and accepts, a grill-stage Story appears under the Epic and both sides link', async (t) => {
  const { kiln, project, events, chat, epic } = await setup(t);

  await kiln.api('POST', draftPath(chat), { projectId: project.id, parentId: epic.id });
  const ready = await events.next<KilnEvent<'chat.story_draft', { chatId: string; state: string; draft: { title?: string } }>>('chat.story_draft', { timeoutMs: 15_000 });
  assert.equal(ready.payload.state, 'pending');
  const filled = await events.next<KilnEvent<'chat.story_draft', { state: string; draft: { title?: string; description?: string } }>>('chat.story_draft', { timeoutMs: 15_000 });
  assert.equal(filled.payload.state, 'ready');
  assert.equal(filled.payload.draft.title, 'Heatset sizes');
  const pending = await kiln.api<{ title?: string }>('GET', draftPath(chat));
  assert.equal(pending.title, 'Heatset sizes');

  const before = kiln.repo.git('rev-list', '--count', 'main').trim();
  const story = await kiln.api<Item>('POST', draftPath(chat, 'story'), {
    projectId: project.id,
    parentId: epic.id,
    title: 'Heatset sizes (edited)',
    description: 'Edited: M3 heatsets, 4mm long.',
  });

  assert.equal(story.kind, 'story');
  assert.equal(story.stage, 'grill');
  assert.equal(story.title, 'Heatset sizes (edited)');
  assert.equal(story.parentId, epic.id);
  assert.equal(Number(kiln.repo.git('rev-list', '--count', 'main').trim()), Number(before) + 1, 'one Kiln-authored commit on the default branch');
  const file = readRepoFile(kiln.repo, `.scratch/${story.key.split("/").pop()}/story.md`);
  assert.match(file, /Edited: M3 heatsets/);
  assert.doesNotMatch(file, new RegExp(chat.id), 'the Story carries no chat reference');

  const storyThread = await kiln.api<ThreadEntry[]>('GET', `/api/items/${encodeURIComponent(story.id)}/thread`);
  assert.deepEqual(storyThread.filter((e) => e.type === 'item.from_chat').map((e) => e.payload.chatId), [chat.id]);
  const chatThread = await kiln.api<ThreadEntry[]>('GET', `/api/chats/${chat.id}/thread`);
  assert.deepEqual(chatThread.filter((e) => e.type === 'chat.story_made').map((e) => e.payload.storyId), [story.id]);
  assert.deepEqual((await kiln.api<ScratchChat>('GET', `/api/chats/${chat.id}`)).stories, [story.id]);
  await assert.rejects(kiln.api('GET', draftPath(chat)), /404/, 'accepting closes the draft');

  // The Story's first grill Session is seeded from story.md and never sees the chat.
  await kiln.api('POST', `/api/items/${encodeURIComponent(story.id)}/start`);
  const seen = await progress(events, /^seed: /);
  assert.match(seen.payload.text!, /Edited: M3 heatsets/);
  assert.doesNotMatch(seen.payload.text!, /What heatset size|Make this chat a Story/);
  assert.doesNotMatch(seen.payload.text!, new RegExp(chat.id));
});

test('Cancel creates nothing, and so does accepting with no draft pending', async (t) => {
  const { kiln, project, chat } = await setup(t);
  const before = kiln.repo.git('rev-list', '--count', 'main').trim();
  const items = (await kiln.api<Item[]>('GET', `/api/items?project=${encodeURIComponent(project.id)}`)).length;

  await kiln.api('POST', draftPath(chat), { projectId: project.id });
  assert.deepEqual(await kiln.api('DELETE', draftPath(chat)), { cancelled: true });
  await assert.rejects(
    kiln.api('POST', draftPath(chat, 'story'), { projectId: project.id, title: 'x', description: 'y' }),
    /409/,
  );

  assert.equal(kiln.repo.git('rev-list', '--count', 'main').trim(), before);
  assert.equal((await kiln.api<Item[]>('GET', `/api/items?project=${encodeURIComponent(project.id)}`)).length, items);
  assert.deepEqual((await kiln.api<ScratchChat>('GET', `/api/chats/${chat.id}`)).stories, []);
});

test('a draft left pending for 30 minutes is dropped; a bad Project or Epic is refused', async (t) => {
  const { kiln, project, chat } = await setup(t);
  await assert.rejects(kiln.api('POST', draftPath(chat), { projectId: 'nope' }), /404/);
  await assert.rejects(kiln.api('POST', draftPath(chat), { projectId: project.id, parentId: 'nope/x' }), /400/);

  await kiln.api('POST', draftPath(chat), { projectId: project.id });
  await kiln.api('POST', '/api/test/clock', { advanceMs: 31 * 60 * 1000 });
  await assert.rejects(kiln.api('GET', draftPath(chat)), /404/);
  await assert.rejects(
    kiln.api('POST', draftPath(chat, 'story'), { projectId: project.id, title: 'x', description: 'y' }),
    /409/,
  );
});
