// Make it a Story drafts (ticket scratch-chat/08): at most one pending draft per chat, held in
// memory only. A draft is opened with a Project (and optionally an Epic), filled by the chat's
// `draft_story` tool, then accepted (creating the Story) or cancelled. One left pending for 30
// minutes is dropped. Nothing here creates an Item.
import type { ChatStoryDraft } from '@kiln/widget-sdk';
import type { EventBus } from '../events.ts';
import { chatThreadId } from '@kiln/widget-sdk';

export const DRAFT_TTL_MS = 30 * 60 * 1000;

export interface StoryDrafts {
  /** Opens (replacing any earlier) a draft for the chat. */
  open(chatId: string, target: { projectId: string; parentId?: string }, now: Date): ChatStoryDraft;
  /** The chat's pending draft, or undefined when none is pending or it expired. */
  get(chatId: string, now: Date): ChatStoryDraft | undefined;
  /** Fills the pending draft with the chat's title and description; throws when none is pending. */
  fill(chatId: string, text: { title: string; description: string }, now: Date): ChatStoryDraft;
  /** Drops the draft (cancelled, accepted or expired). Returns whether one was pending. */
  close(chatId: string, reason: 'cancelled' | 'accepted' | 'expired'): boolean;
  /** Drops every draft pending longer than 30 minutes. */
  expire(now: Date): void;
}

export function createStoryDrafts({ bus }: { bus: EventBus }): StoryDrafts {
  const drafts = new Map<string, ChatStoryDraft>();
  const announce = (chatId: string, state: string, draft?: ChatStoryDraft) =>
    bus.publish('chat.story_draft', { chatId, itemId: chatThreadId(chatId), state, ...(draft ? { draft } : {}) });
  const expired = (draft: ChatStoryDraft, now: Date) => now.getTime() - Date.parse(draft.openedAt) > DRAFT_TTL_MS;

  const self: StoryDrafts = {
    open(chatId, target, now) {
      const draft: ChatStoryDraft = { projectId: target.projectId, ...(target.parentId ? { parentId: target.parentId } : {}), openedAt: now.toISOString() };
      drafts.set(chatId, draft);
      announce(chatId, 'pending', draft);
      return draft;
    },
    get(chatId, now) {
      const draft = drafts.get(chatId);
      if (!draft) return undefined;
      if (expired(draft, now)) {
        self.close(chatId, 'expired');
        return undefined;
      }
      return draft;
    },
    fill(chatId, text, now) {
      const draft = self.get(chatId, now);
      if (!draft) throw new Error('No Make it a Story draft is pending for this chat');
      const filled = { ...draft, title: text.title, description: text.description };
      drafts.set(chatId, filled);
      announce(chatId, 'ready', filled);
      return filled;
    },
    close(chatId, reason) {
      if (!drafts.delete(chatId)) return false;
      announce(chatId, reason);
      return true;
    },
    expire(now) {
      for (const [chatId, draft] of [...drafts]) if (expired(draft, now)) self.close(chatId, 'expired');
    },
  };
  return self;
}
