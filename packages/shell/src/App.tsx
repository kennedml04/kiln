import type { Me } from '@kiln/widget-sdk';
import { AuditPage } from './AuditPage.tsx';
import { NEEDS_YOU_PATH, NeedsYouLink, NeedsYouPage } from './NeedsYou.tsx';
import { followLink, usePath } from './router.ts';
import { SETUP_PATH, SetupWizard } from './SetupWizard.tsx';
import { useStore, type ConnectionState } from './store.ts';
import { WidgetsPage } from './WidgetsPage.tsx';
import { HomeBoard } from './work/HomeBoard.tsx';
import { ItemView } from './work/ItemView.tsx';
import { ProjectThreadView } from './work/ProjectThreadView.tsx';
import { ProjectView } from './work/ProjectView.tsx';
import { SettingsPage } from './work/SettingsPage.tsx';
import { StopAll } from './work/StopAll.tsx';
import { BUDGET_ROUTE, BudgetGauges, BudgetPage } from './work/Usage.tsx';

const LABELS: Record<ConnectionState, string> = {
  connecting: 'Connecting',
  connected: 'Connected',
  disconnected: 'Disconnected, reconnecting',
};

function ConnectionBadge() {
  const connection = useStore((s) => s.connection);
  return (
    <span role="status" className={`connection connection-${connection}`}>
      {LABELS[connection]}
    </span>
  );
}

function LastEvent() {
  const event = useStore((s) => s.lastEvent);
  return <p data-testid="last-event">{event ? `Last event: ${event.type}` : 'No events yet'}</p>;
}

function NavLink({ to, children }: { to: string; children: string }) {
  const path = usePath();
  return (
    <a href={to} onClick={followLink} aria-current={path === to ? 'page' : undefined}>
      {children}
    </a>
  );
}

function NoAccess({ me }: { me: Me }) {
  const who = me.actor.kind === 'user' ? (me.actor.name ?? me.actor.id) : me.actor.kind;
  return (
    <main>
      <h2>No access yet</h2>
      <p>
        You are signed in as <strong>{who}</strong>, but you have no role in this Kiln. Ask an Admin to give you one, then
        reload this page.
      </p>
    </main>
  );
}

const PROJECT_ROUTE = /^\/projects\/([^/]+)\/?$/;
const PROJECT_THREAD_ROUTE = /^\/projects\/([^/]+)\/thread\/?$/;
const ITEM_ROUTE = /^\/items\/([^/]+)\/?$/;

function Page({ isAdmin }: { isAdmin: boolean }) {
  const path = usePath();
  if (path === '/audit' && isAdmin) return <AuditPage />;
  if (path === NEEDS_YOU_PATH) return <NeedsYouPage />;
  if (path === '/settings' && isAdmin) return <SettingsPage />;
  if (path === SETUP_PATH && isAdmin) return <SetupWizard />;
  if (path === '/widgets') return <WidgetsPage isAdmin={isAdmin} />;
  const project = PROJECT_ROUTE.exec(path);
  if (project) return <ProjectView projectId={decodeURIComponent(project[1]!)} />;
  const projectThread = PROJECT_THREAD_ROUTE.exec(path);
  if (projectThread) return <ProjectThreadView projectId={decodeURIComponent(projectThread[1]!)} />;
  const item = ITEM_ROUTE.exec(path);
  if (item) return <ItemView itemId={decodeURIComponent(item[1]!)} />;
  const budget = BUDGET_ROUTE.exec(path);
  if (budget) return <BudgetPage budgetId={decodeURIComponent(budget[1]!)} />;
  return <HomeBoard />;
}

export function App() {
  const me = useStore((s) => s.me);
  if (me && me.role === null) {
    return (
      <>
        <header>
          <h1>Kiln</h1>
        </header>
        <NoAccess me={me} />
      </>
    );
  }
  const isAdmin = me?.role === 'admin';
  return (
    <>
      <header>
        <h1>Kiln</h1>
        <nav>
          <NavLink to="/">All Projects</NavLink>
          <NavLink to="/widgets">Widgets</NavLink>
          <NeedsYouLink />
          {isAdmin && <NavLink to="/audit">Audit log</NavLink>}
          {isAdmin && <NavLink to="/settings">Settings</NavLink>}
        </nav>
        <BudgetGauges />
        <StopAll canAct={me?.role === 'admin' || me?.role === 'member'} />
        <ConnectionBadge />
      </header>
      <main>
        <Page isAdmin={isAdmin} />
        <LastEvent />
      </main>
    </>
  );
}
