import type { ReactNode } from 'react';
import type { Me } from '@kiln/widget-sdk';
import { AuditPage } from './AuditPage.tsx';
import { AuditIcon, BoardIcon, FlameIcon, MoonIcon, SettingsIcon, SunIcon, WidgetsIcon } from './Icons.tsx';
import { NEEDS_YOU_PATH, NeedsYouLink, NeedsYouPage } from './NeedsYou.tsx';
import { followLink, usePath } from './router.ts';
import { SETUP_PATH, SetupWizard } from './SetupWizard.tsx';
import { useStore, type ConnectionState } from './store.ts';
import { ToastArea } from './toast.tsx';
import { setTheme, useTheme } from './theme.ts';
import { WIDGET_ROUTE, WidgetPage, WidgetsNav, WidgetsPage } from './WidgetsPage.tsx';
import { ChatView, ChatsLink, NewChatButton, NewChatView } from './work/Chats.tsx';
import { ChatsPage } from './work/ChatsPage.tsx';
import { HomeBoard } from './work/HomeBoard.tsx';
import { ItemView } from './work/ItemView.tsx';
import { MODELS_PATH, ModelsPage } from './work/ModelsPage.tsx';
import { ProjectThreadView } from './work/ProjectThreadView.tsx';
import { ProjectView } from './work/ProjectView.tsx';
import { SettingsPage } from './work/SettingsPage.tsx';
import { StopAll } from './work/StopAll.tsx';
import { SHIPPED_PATH, ShippedHistory } from './work/ShippedHistory.tsx';
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

function NavLink({ to, icon, children }: { to: string; icon: ReactNode; children: string }) {
  const path = usePath();
  return (
    <a href={to} onClick={followLink} aria-current={path === to ? 'page' : undefined}>
      {icon}
      {children}
    </a>
  );
}

function ThemeToggle() {
  const theme = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button type="button" className="ghost theme-toggle" onClick={() => setTheme(next)} aria-label={`Switch to ${next} theme`}>
      {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

function Brand() {
  return (
    <h1 className="brand">
      <span className="brand-mark">
        <FlameIcon />
      </span>
      Kiln
    </h1>
  );
}

function NoAccess({ me }: { me: Me }) {
  const who = me.actor.kind === 'user' ? (me.actor.name ?? me.actor.id) : me.actor.kind;
  return (
    <main className="content">
      <section className="no-access">
        <h2>No access yet</h2>
        <p>
          You are signed in as <strong>{who}</strong>, but you have no role in this Kiln. Ask an Admin to give you one, then
          reload this page.
        </p>
      </section>
    </main>
  );
}

const PROJECT_ROUTE = /^\/projects\/([^/]+)\/?$/;
const PROJECT_THREAD_ROUTE = /^\/projects\/([^/]+)\/thread\/?$/;
const PROJECT_SHIPPED_ROUTE = /^\/projects\/([^/]+)\/shipped\/?$/;
const CHAT_ROUTE = /^\/chats\/([^/]+)\/?$/;
const ITEM_ROUTE = /^\/items\/([^/]+)\/?$/;

function Page({ isAdmin }: { isAdmin: boolean }) {
  const path = usePath();
  if (path === '/chats' || path === '/chats/') return <ChatsPage isAdmin={isAdmin} />;
  if (path === '/chats/new') return <NewChatView />;
  const chat = CHAT_ROUTE.exec(path);
  if (chat) return <ChatView chatId={decodeURIComponent(chat[1]!)} />;
  if (path === '/audit' && isAdmin) return <AuditPage />;
  if (path === NEEDS_YOU_PATH) return <NeedsYouPage />;
  if (path === '/settings' && isAdmin) return <SettingsPage />;
  if (path === MODELS_PATH && isAdmin) return <ModelsPage />;
  if (path === SETUP_PATH && isAdmin) return <SetupWizard />;
  if (path === '/widgets') return <WidgetsPage isAdmin={isAdmin} />;
  if (path === SHIPPED_PATH) return <ShippedHistory />;
  const projectShipped = PROJECT_SHIPPED_ROUTE.exec(path);
  if (projectShipped) return <ShippedHistory projectId={decodeURIComponent(projectShipped[1]!)} />;
  const widget = WIDGET_ROUTE.exec(path);
  if (widget) return <WidgetPage widgetId={decodeURIComponent(widget[1]!)} isAdmin={isAdmin} />;
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
        <header className="sidebar no-access-bar">
          <Brand />
        </header>
        <NoAccess me={me} />
      </>
    );
  }
  const isAdmin = me?.role === 'admin';
  return (
    <div className="app">
      <ToastArea />
      <header className="sidebar">
        <Brand />
        <nav className="nav" aria-label="Main">
          <NavLink to="/" icon={<BoardIcon />}>
            All Projects
          </NavLink>
          <NeedsYouLink />
          <ChatsLink />
          <NavLink to="/widgets" icon={<WidgetsIcon />}>
            Widgets
          </NavLink>
          <WidgetsNav />
          {isAdmin && (
            <NavLink to="/audit" icon={<AuditIcon />}>
              Audit log
            </NavLink>
          )}
          {isAdmin && (
            <NavLink to="/settings" icon={<SettingsIcon />}>
              Settings
            </NavLink>
          )}
        </nav>
        <BudgetSection />
        <div className="sidebar-footer">
          <NewChatButton canAct={me?.role === 'admin' || me?.role === 'member'} />
          <StopAll canAct={me?.role === 'admin' || me?.role === 'member'} />
          <div className="sidebar-status">
            <ConnectionBadge />
            <ThemeToggle />
          </div>
          <LastEvent />
        </div>
      </header>
      <main className="content">
        <Page isAdmin={isAdmin} />
      </main>
    </div>
  );
}

function BudgetSection() {
  const any = useStore((s) => s.budgets.length > 0);
  if (!any) return null;
  return (
    <div className="sidebar-section">
      <p className="sidebar-label">Budgets</p>
      <BudgetGauges />
    </div>
  );
}
