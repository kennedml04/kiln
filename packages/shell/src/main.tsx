import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import type { SetupState } from '@kiln/widget-sdk';
import { api, fetchMe } from './api.ts';
import { SETUP_PATH } from './SetupWizard.tsx';
import { connect, setMe } from './store.ts';
import { applyStoredTheme } from './theme.ts';
import './styles.css';

applyStoredTheme();

// Who we are first: someone with no role gets the no-access page and no event stream.
void fetchMe().then(async (me) => {
  setMe(me);
  // A Kiln that has not been set up opens the setup wizard for an Admin.
  if (me.role === 'admin' && window.location.pathname !== SETUP_PATH) {
    const setup = await api<SetupState>('GET', '/api/setup').catch(() => undefined);
    if (setup && !setup.completed) window.history.replaceState(null, '', SETUP_PATH);
  }
  if (me.role !== null) connect();
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}).catch(() => {
  document.getElementById('root')!.textContent = 'Kiln is not answering. Reload the page to try again.';
});
