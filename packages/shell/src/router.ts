// A tiny path router: the core serves the Shell's index.html for every non-file path.
import { useSyncExternalStore, type MouseEvent } from 'react';

const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};
window.addEventListener('popstate', notify);

export function usePath(): string {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => window.location.pathname,
  );
}

export function navigate(path: string) {
  if (path === window.location.pathname) return;
  window.history.pushState(null, '', path);
  notify();
}

/** An onClick for `<a href>` that navigates in place (no page load) unless a modifier key is held. */
export function followLink(event: MouseEvent<HTMLAnchorElement>) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(event.currentTarget.getAttribute('href') ?? '/');
}

export const projectPath = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`;
export const itemPath = (itemId: string) => `/items/${encodeURIComponent(itemId)}`;
export const projectThreadPath = (projectId: string) => `${projectPath(projectId)}/thread`;
export const CHATS_PATH = '/chats';
export const NEW_CHAT_PATH = '/chats/new';
export const chatPath = (chatId: string) => `${CHATS_PATH}/${encodeURIComponent(chatId)}`;
