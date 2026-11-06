// Scratch chats (ticket scratch-chat/01): the `chats` table and each chat's scratch folder.
// Chats are runtime data: they are in no Tracker and not in the Knowledge store.
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { BudgetInfo, RoleModel, ScratchChat } from '@kiln/widget-sdk';
import type { EventBus } from '../events.ts';

export interface Chats {
  /** Opens a chat for its owner, titled from its first message. Makes its (empty) scratch folder. */
  open(ownerId: string, firstMessage: string, now?: Date): ScratchChat;
  get(id: string): ScratchChat | undefined;
  /** Chats of `ownerId` (every chat when unset), pinned first, then by last message. */
  list(filter?: { ownerId?: string; archived?: boolean }): ScratchChat[];
  /** Records a message: the chat's last message time moves on and it is no longer archived. */
  touch(id: string, now?: Date): void;
  /** `<dataDir>/chats/<id>/`: where the chat's Session runs and its Digests live. */
  folder(id: string): string;
  /** Renames, pins or unpins, archives or un-archives. Pinning an archived chat un-archives it. */
  update(id: string, change: { title?: string; pinned?: boolean; archived?: boolean }, now?: Date): ScratchChat | undefined;
  /** Archives unpinned chats idle 7 days and deletes chats archived 30+ days. */
  sweep(now: Date): Promise<{ archived: string[]; deleted: string[] }>;
  /** Records a Story made from the chat. */
  addStory(id: string, itemId: string): ScratchChat | undefined;
  /** Removes the chat's row and its folder. */
  remove(id: string): void;
}

interface ChatRow {
  id: string;
  title: string;
  owner_id: string;
  created_at: string;
  last_message_at: string;
  pinned: number;
  archived_at: string | null;
  stories: string;
}

const TITLE_MAX = 60;
const DAY_MS = 24 * 60 * 60 * 1000;
export const ARCHIVE_AFTER_MS = 7 * DAY_MS;
export const DELETE_AFTER_MS = 30 * DAY_MS;

/**
 * The chat role's model until setup can choose one (ticket 05): the install's own `chat` role when
 * set, else an Opus-tier model from a Budget (never Fable), with a Sonnet-tier one as its fallback.
 * Undefined when no Budget has either: opening a chat is then refused, as before.
 */
export function chatRoleModel(chosen: RoleModel | undefined, budgets: Pick<BudgetInfo, 'kind' | 'models'>[]): RoleModel | undefined {
  if (chosen?.model) return chosen;
  const models = budgets.filter((b) => b.kind !== 'local').flatMap((b) => b.models).filter((m) => !/fable/i.test(m));
  const model = models.find((m) => /opus/i.test(m)) ?? models.find((m) => /sonnet/i.test(m));
  if (!model) return undefined;
  const fallbackModel = models.find((m) => m !== model && /sonnet/i.test(m));
  return { model, ...(fallbackModel ? { fallbackModel } : {}) };
}

const titleOf = (message: string) => {
  const line = message.trim().split('\n')[0]!.trim();
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1).trimEnd()}…` : line || 'New chat';
};

export function createChats({
  db,
  bus,
  dataDir,
  isRunning = () => false,
  endSessions = async () => {},
}: {
  db: DatabaseSync;
  bus: EventBus;
  dataDir: string;
  /** Whether a Session of the chat is alive (from the Session manager). */
  isRunning?: (id: string) => boolean;
  /** Ends the chat's live Sessions (before it is archived or deleted); `forget` also drops their rows. */
  endSessions?: (id: string, forget: boolean) => Promise<void>;
}): Chats {
  const folder = (id: string) => join(dataDir, 'chats', id);
  const fromRow = (row: ChatRow): ScratchChat => ({
    id: row.id,
    title: row.title,
    ownerId: row.owner_id,
    createdAt: row.created_at,
    lastMessageAt: row.last_message_at,
    pinned: row.pinned === 1,
    ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
    stories: JSON.parse(row.stories) as string[],
    running: isRunning(row.id),
  });
  const select = db.prepare('SELECT * FROM chats WHERE id = ?');
  const selectAll = db.prepare('SELECT * FROM chats ORDER BY pinned DESC, last_message_at DESC, id');
  const insert = db.prepare(
    'INSERT INTO chats (id, title, owner_id, created_at, last_message_at, pinned, archived_at, stories) VALUES (?, ?, ?, ?, ?, 0, NULL, ?)',
  );
  const touchRow = db.prepare('UPDATE chats SET last_message_at = ?, archived_at = NULL WHERE id = ?');
  const setTitle = db.prepare('UPDATE chats SET title = ? WHERE id = ?');
  const setPinned = db.prepare('UPDATE chats SET pinned = ? WHERE id = ?');
  const setArchived = db.prepare('UPDATE chats SET archived_at = ? WHERE id = ?');
  const setStories = db.prepare('UPDATE chats SET stories = ? WHERE id = ?');
  const deleteRow = db.prepare('DELETE FROM chats WHERE id = ?');

  const get = (id: string) => {
    const row = select.get(id) as unknown as ChatRow | undefined;
    return row && fromRow(row);
  };

  const remove = (id: string) => {
    const subject = `chat:${id}`;
    // Thread entries, Asks and the chat's row go. Usage records and the audit log stay.
    bus.deleteWithPayload('itemId', subject);
    bus.deleteWithPayload('chatId', id);
    db.prepare('DELETE FROM asks WHERE item_id = ?').run(subject);
    db.prepare('DELETE FROM sessions WHERE item_id = ?').run(subject);
    deleteRow.run(id);
    rmSync(folder(id), { recursive: true, force: true });
  };

  let sweeping: Promise<void> = Promise.resolve();
  const sweepOnce = async (now: Date) => {
    const archived: string[] = [];
    const deleted: string[] = [];
    for (const row of (selectAll.all() as unknown as ChatRow[]).map(fromRow)) {
      const stale = (c: ScratchChat) => (c.archivedAt ? now.getTime() - Date.parse(c.archivedAt) > DELETE_AFTER_MS : !c.pinned && now.getTime() - Date.parse(c.lastMessageAt) > ARCHIVE_AFTER_MS);
      if (!stale(row)) continue;
      // The Session wrote its Digest when it went idle; ending it only lets go of the Agent.
      await endSessions(row.id, !!row.archivedAt);
      // A message may have come in while the Session ended: look again before acting.
      const chat = get(row.id);
      if (!chat || !stale(chat)) continue;
      if (chat.archivedAt) {
        remove(chat.id);
        deleted.push(chat.id);
      } else {
        setArchived.run(now.toISOString(), chat.id);
        bus.publish('chat.updated', { chatId: chat.id, itemId: `chat:${chat.id}`, chat: get(chat.id)! });
        archived.push(chat.id);
      }
    }
    return { archived, deleted };
  };

  return {
    open(ownerId, firstMessage, now = new Date()) {
      const id = randomBytes(9).toString('base64url');
      const at = now.toISOString();
      insert.run(id, titleOf(firstMessage), ownerId, at, at, '[]');
      mkdirSync(folder(id), { recursive: true });
      const chat = get(id)!;
      bus.publish('chat.opened', { chatId: id, itemId: `chat:${id}`, chat });
      return chat;
    },
    get,
    list({ ownerId, archived = false } = {}) {
      return (selectAll.all() as unknown as ChatRow[])
        .map(fromRow)
        .filter((c) => (ownerId === undefined || c.ownerId === ownerId) && (c.archivedAt !== undefined) === archived);
    },
    touch(id, now = new Date()) {
      touchRow.run(now.toISOString(), id);
      const chat = get(id);
      if (chat) bus.publish('chat.updated', { chatId: id, itemId: `chat:${id}`, chat });
    },
    update(id, change, now = new Date()) {
      const before = get(id);
      if (!before) return undefined;
      if (change.title !== undefined && change.title.trim()) setTitle.run(change.title.trim(), id);
      if (change.pinned !== undefined) {
        setPinned.run(change.pinned ? 1 : 0, id);
        if (change.pinned) setArchived.run(null, id);
      }
      if (change.archived === false) setArchived.run(null, id);
      // Archiving by hand also unpins: the person asked for it to go.
      if (change.archived === true && !before.archivedAt) {
        setPinned.run(0, id);
        setArchived.run(now.toISOString(), id);
      }
      const chat = get(id)!;
      bus.publish('chat.updated', { chatId: id, itemId: `chat:${id}`, chat });
      return chat;
    },
    addStory(id, itemId) {
      const before = get(id);
      if (!before) return undefined;
      setStories.run(JSON.stringify([...before.stories, itemId]), id);
      const chat = get(id)!;
      bus.publish('chat.updated', { chatId: id, itemId: `chat:${id}`, chat });
      return chat;
    },
    sweep(now) {
      // One sweep at a time: a later call waits for the one running.
      const run = sweeping.then(() => sweepOnce(now));
      sweeping = run.then(() => undefined, () => undefined);
      return run;
    },
    folder,
    remove,
  };
}
