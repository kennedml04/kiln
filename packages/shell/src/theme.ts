// The Shell's colour theme: dark unless the person picked light, remembered in this browser.
import { useSyncExternalStore } from 'react';

export type Theme = 'dark' | 'light';
const KEY = 'kiln-theme';
const listeners = new Set<() => void>();

const stored = (): Theme => {
  try {
    return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
};

/** Sets <html data-theme> from what this browser remembers. Call before the first render. */
export function applyStoredTheme() {
  document.documentElement.dataset.theme = stored();
}

export function setTheme(theme: Theme) {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Storage can be off; the theme still changes for this page.
  }
  document.documentElement.dataset.theme = theme;
  for (const listener of listeners) listener();
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'),
  );
}
