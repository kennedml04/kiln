// The setup wizard (ticket 25): the steps an Admin walks on first run, and again from Settings.
// Each step saves as it goes (PUT /api/setup, the Budget and Widget routes); Finish asks the core
// to mark setup done, which it refuses while a Budget or a role's model is missing.
import { useEffect, useState, type ReactNode } from 'react';
import type { BudgetDraft, BudgetInfo, CoreStatus, ImportResult, InstallKind, LoginMode, RoleModel, SetupState, TailscaleServe, WidgetInfo } from '@kiln/widget-sdk';
import { suggestRoles } from './role-defaults.ts';
import { navigate } from './router.ts';
import { api, useStore } from './store.ts';

export const SETUP_PATH = '/setup';

const LIVE_STEPS = ['Login', 'Knowledge store', 'Install', 'Agents', 'Models', 'Workflow roles', 'Import'] as const;
type StepName = (typeof LIVE_STEPS)[number];
/** A dev instance never imports the old board's real Projects, so its wizard has no Import step. */
const DEV_STEPS: readonly StepName[] = LIVE_STEPS.filter((s) => s !== 'Import');

/** The limits each Budget kind offers to change in setup, as paths into its settings. */
const LIMIT_FIELDS: Record<BudgetDraft['kind'], { label: string; path: string[] }[]> = {
  metered: [
    { label: 'Credits per month', path: ['monthly'] },
    { label: 'Credits per Project per day', path: ['perProjectPerDay'] },
    { label: 'Credits per Session', path: ['perSession', 'cost'] },
  ],
  subscription: [
    { label: 'Share of the week per Session (%)', path: ['perSession', 'share'] },
    { label: 'Reserve kept for you (%)', path: ['reserve'] },
  ],
  local: [
    { label: 'Turns per Session', path: ['perSession', 'turns'] },
    { label: 'Minutes per Session', path: ['perSession', 'minutes'] },
  ],
};

const getPath = (value: Record<string, unknown>, path: string[]): unknown =>
  path.reduce<unknown>((v, key) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined), value);

const setPath = (value: Record<string, unknown>, path: string[], next: unknown): Record<string, unknown> => {
  const [key, ...rest] = path;
  if (!key) return value;
  const inner = (value[key] && typeof value[key] === 'object' ? value[key] : {}) as Record<string, unknown>;
  return { ...value, [key]: rest.length ? setPath(inner, rest, next) : next };
};

const withoutId = ({ id: _id, ...rest }: BudgetDraft) => rest;

/** A model the Models step lists: its exact id, a name for people, and where Kiln heard of it. */
interface ModelRow {
  id: string;
  name?: string;
  from: string;
  local?: boolean;
}

const ADDED_BY_YOU = 'Added by you';

/** Every model setup knows of: each Agent's, the local model server's, each Budget's, and those added by hand. */
function modelRows(widgets: WidgetInfo[], setup: SetupState, entries: BudgetDraft[], existing: BudgetInfo[], added: string[]): ModelRow[] {
  const rows = new Map<string, ModelRow>();
  const add = (raw: string, from: string, name?: string, local?: boolean) => {
    const id = raw.trim();
    if (!id) return;
    const row = rows.get(id);
    if (!row) rows.set(id, { id, from, ...(name ? { name } : {}), ...(local ? { local } : {}) });
    else if (name && !row.name) row.name = name;
  };
  for (const w of widgets) {
    for (const agent of w.agents) {
      for (const m of agent.models ?? []) add(m.id, agent.name, m.name, m.local);
      if (agent.model) add(agent.model, agent.name);
    }
  }
  for (const m of setup.localModelServer.models) add(m, 'Local model server', undefined, true);
  for (const e of entries) for (const m of e.models) add(m, existing.some((b) => b.id === e.id) ? `Set up in ${e.name ?? e.id}` : 'Suggested');
  for (const m of added) add(m, ADDED_BY_YOU);
  return [...rows.values()];
}

/**
 * The Budget a model draws from: the one picked for it here, else the Budget that lists it, else a
 * local Budget for a local model and the first other Budget for the rest. '' is none.
 */
function budgetFor(row: ModelRow, entries: BudgetDraft[], picked: Record<string, string>): string {
  if (row.id in picked) return picked[row.id]!;
  const listed = entries.find((e) => e.models.includes(row.id));
  if (listed) return listed.id;
  const fallback = entries.find((e) => (e.kind === 'local') === Boolean(row.local));
  return fallback?.id ?? '';
}

/** A Budget the wizard offers: what is set up already wins over the install's defaults. */
const draftFor = (draft: BudgetDraft, existing: BudgetInfo[]): BudgetDraft => {
  const found = existing.find((b) => b.id === draft.id);
  return found ? { ...draft, ...found.config, id: found.id, kind: found.kind, name: found.name, models: found.models } : draft;
};

function Step({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="setup-step">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

/** A radio or checkbox drawn as a card: the title and detail are its label. */
function Choice(props: {
  type: 'radio' | 'checkbox';
  name?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  title: ReactNode;
  detail?: ReactNode;
  path?: string;
  side?: ReactNode;
}) {
  const { type, name, checked, disabled, onChange, title, detail, path, side } = props;
  return (
    <div className="choice-row">
      {/* The checked look comes from React: :has(:checked) misses a radio its group unchecked. */}
      <label className={`choice${checked ? ' is-checked' : ''}${disabled ? ' is-disabled' : ''}`}>
        <input type={type} name={name} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span className="choice-text">
          <span className="choice-title">{title}</span>
          {detail ? <span className="choice-detail">{detail}</span> : null}
          {path ? <span className="choice-path">{path}</span> : null}
        </span>
        {side ? <span className="choice-side">{side}</span> : null}
      </label>
    </div>
  );
}

/** What `tailscale serve` does with Kiln now, when that needs saying. */
function ServeStatus({ serve, login }: { serve: TailscaleServe | undefined; login: LoginMode }) {
  if (!serve) return null;
  if (serve.kind === 'tcp') {
    return (
      <p role="alert" className="setup-warning">
        tailscale serve forwards raw TCP to Kiln ({serve.target}), so every remote caller would be the local Admin. Turn it off, or serve Kiln
        over HTTPS, before you go on.
      </p>
    );
  }
  if (login === 'local') {
    return (
      <p className="setup-hint">
        tailscale serve forwards to Kiln ({serve.target}). In Local mode its callers get no access: pick Tailscale to let them in.
      </p>
    );
  }
  if (serve.funnel) {
    return <p className="setup-hint">Funnel is on for Kiln's tailscale serve entry. Callers from the internet get no access.</p>;
  }
  return null;
}

function LoginStep({ setup, login, setLogin }: { setup: SetupState; login: LoginMode; setLogin: (l: LoginMode) => void }) {
  return (
    <Step title="Login">
      <p>Who can reach this Kiln.</p>
      <div className="choices">
        <Choice
          type="radio"
          name="login"
          checked={login === 'local'}
          onChange={() => setLogin('local')}
          title="Local"
          detail="Only this PC, and the person at it is Admin."
        />
        <Choice
          type="radio"
          name="login"
          checked={login === 'tailscale'}
          onChange={() => setLogin('tailscale')}
          title="Tailscale"
          detail="This PC and your tailnet, each person with their own role."
        />
      </div>
      {login === 'tailscale' ? (
        <p role="note" className="setup-hint">
          {setup.tailscale.note}
        </p>
      ) : null}
      <ServeStatus serve={setup.tailscale.servesKiln} login={login} />
      {login !== setup.running.login ? <p className="setup-hint">Kiln switches to this login mode when it next restarts.</p> : null}
    </Step>
  );
}

function KnowledgeStep({ setup, folder, setFolder }: { setup: SetupState; folder: string; setFolder: (f: string) => void }) {
  return (
    <Step title="Knowledge store">
      <p>The markdown folder Kiln keeps Digests in. Pick a new folder, or your Obsidian vault.</p>
      <label>
        Knowledge store folder
        <input value={folder} onChange={(e) => setFolder(e.target.value)} spellCheck={false} placeholder="C:\path\to\folder" />
      </label>
      {setup.obsidian.installed ? (
        <p>
          Obsidian is installed{setup.obsidian.vault ? ', and this folder is already a vault' : '. Open this folder in it as a vault'}.
        </p>
      ) : (
        <p>{setup.obsidian.suggestion}</p>
      )}
    </Step>
  );
}

function BudgetFields({ draft, onChange }: { draft: BudgetDraft; onChange: (d: BudgetDraft) => void }) {
  return (
    <fieldset aria-label={draft.name ?? draft.id}>
      <legend>
        {draft.name ?? draft.id} ({draft.kind})
      </legend>
      {LIMIT_FIELDS[draft.kind].map((field) => (
        <label key={field.label}>
          {field.label}{' '}
          <input
            type="number"
            min={0}
            value={String(getPath(draft, field.path) ?? '')}
            onChange={(e) => onChange(setPath(draft, field.path, Number(e.target.value)) as BudgetDraft)}
          />
        </label>
      ))}
    </fieldset>
  );
}

function InstallStep(props: {
  install: InstallKind | undefined;
  setInstall: (k: InstallKind) => void;
  drafts: BudgetDraft[];
  setDrafts: (d: BudgetDraft[]) => void;
  setup: SetupState;
}) {
  const { install, setInstall, drafts, setDrafts, setup } = props;
  return (
    <Step title="Install">
      <p>What pays for the Agents' work.</p>
      <div className="choices">
        <Choice type="radio" name="install" checked={install === 'work'} onChange={() => setInstall('work')} title="Work" detail="Metered credits." />
        <Choice
          type="radio"
          name="install"
          checked={install === 'home'}
          onChange={() => setInstall('home')}
          title="Home"
          detail={`A Claude Max subscription${setup.localModelServer.found ? ', and the local model server found at ' + setup.localModelServer.url : ''}.`}
        />
      </div>
      {install ? <p>These Budgets are offered. Change any limit now, or later on the Budget's page. Their models come next.</p> : null}
      {drafts.map((draft, i) => (
        <BudgetFields key={draft.id} draft={draft} onChange={(d) => setDrafts(drafts.map((x, j) => (j === i ? d : x)))} />
      ))}
    </Step>
  );
}

function AgentsStep(props: {
  setup: SetupState;
  install: InstallKind | undefined;
  repo: string;
  setRepo: (r: string) => void;
  onInstalled: () => Promise<void>;
}) {
  const { setup, install, repo, setRepo, onInstalled } = props;
  const [chosen, setChosen] = useState<Set<string>>(
    () => new Set(setup.agents.filter((a) => !a.installed && install && a.suggested.includes(install)).map((a) => a.id)),
  );
  const [states, setStates] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const installAgents = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api('PUT', '/api/setup', { widgetRepo: repo });
      for (const agent of setup.agents.filter((a) => chosen.has(a.id) && !a.installed)) {
        setStates((s) => ({ ...s, [agent.id]: 'installing' }));
        const widget = await api<WidgetInfo>('POST', '/api/widgets', { source: repo, path: agent.path });
        await api('POST', `/api/widgets/${encodeURIComponent(widget.id)}/approve`);
        let info = widget;
        for (let tries = 0; tries < 100 && info.state !== 'ready' && info.state !== 'incompatible' && info.state !== 'unhealthy'; tries++) {
          await new Promise((r) => setTimeout(r, 150));
          info = (await api<WidgetInfo[]>('GET', '/api/widgets')).find((w) => w.id === widget.id) ?? info;
        }
        setStates((s) => ({ ...s, [agent.id]: info.state }));
      }
      await onInstalled();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Step title="Agents">
      <p>The first-party Agent Widgets, installed from the Widget repo.</p>
      <label>
        Widget repo
        <input value={repo} onChange={(e) => setRepo(e.target.value)} spellCheck={false} placeholder="a git URL or folder" />
      </label>
      {!setup.widgetRepo && !repo ? <p className="setup-hint">Kiln has no public Widget repo set yet: enter its git URL (or a local copy).</p> : null}
      <div className="choices">
        {setup.agents.map((agent) => {
          const state = states[agent.id] ?? (agent.installed ? 'installed' : undefined);
          return (
            <div key={agent.id} className="agent-choice">
              <Choice
                type="checkbox"
                checked={agent.installed || chosen.has(agent.id)}
                disabled={agent.installed}
                onChange={(checked) => {
                  const next = new Set(chosen);
                  if (checked) next.add(agent.id);
                  else next.delete(agent.id);
                  setChosen(next);
                }}
                title={agent.name}
                detail={agent.about}
              />
              {state ? (
                <span role="status" className={`pill pill-${state}`}>
                  <span className="visually-hidden">{agent.name}: </span>
                  {state}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
      <button type="button" className="primary setup-action" onClick={() => void installAgents()} disabled={busy || !repo || chosen.size === 0}>
        {busy ? 'Installing…' : 'Install Agents'}
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </Step>
  );
}

function ModelsStep(props: {
  rows: ModelRow[];
  entries: BudgetDraft[];
  budgetOf: (row: ModelRow) => string;
  pick: (model: string, budget: string) => void;
  add: (model: string) => void;
}) {
  const { rows, entries, budgetOf, pick, add } = props;
  const [draft, setDraft] = useState('');
  return (
    <Step title="Models">
      <p>
        A Budget is what pays for a model: a Claude plan, work credits, or this PC's own GPU. Kiln counts each model's
        usage against its Budget and holds work back before the Budget runs out.
      </p>
      <p className="setup-hint">Pick the Budget each model draws from. A model draws from one Budget; a Budget with no models isn't set up.</p>
      {rows.length ? (
        <div className="setup-roles" role="list" aria-label="Models">
          <div className="setup-role-head" aria-hidden="true">
            <span>Model</span>
            <span>From</span>
            <span>Budget</span>
          </div>
          {rows.map((row) => (
            <div className="setup-role" role="listitem" key={row.id} aria-label={row.name ?? row.id}>
              <span className="setup-role-name">
                <span>{row.name ?? row.id}</span>
                {row.name ? <small className="setup-model-id">{row.id}</small> : null}
              </span>
              <span className="setup-role-name">
                <span>{row.from}</span>
                {row.from === ADDED_BY_YOU ? <small>Check it is the exact ID the Agent reports.</small> : null}
              </span>
              <select aria-label={`Budget for ${row.id}`} value={budgetOf(row)} onChange={(e) => pick(row.id, e.target.value)}>
                <option value="">None</option>
                {entries.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name ?? b.id}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      ) : (
        <p>No Agent has reported its models yet. Add one below.</p>
      )}
      <form
        className="setup-add-model"
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.trim()) return;
          add(draft.trim());
          setDraft('');
        }}
      >
        <label>
          Add a model
          <input value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} placeholder="provider/model-id" />
        </label>
        <button type="submit" disabled={!draft.trim()}>
          Add
        </button>
      </form>
      <p className="setup-hint">
        Type the ID exactly as the Agent reports it. Kiln matches usage to a Budget by that ID, so a typo means the model's
        usage counts against no Budget.
      </p>
    </Step>
  );
}

/**
 * Each role with the Agent that offers its model: the one running that model, else one running a
 * model of the same Budget. A role whose model no installed Agent offers names none.
 */
function withAgents(roles: Record<string, RoleModel>, budgets: BudgetInfo[], widgets: WidgetInfo[]): Record<string, RoleModel> {
  const agents = widgets.flatMap((w) => w.agents);
  const budgetOf = (model: string | undefined) => (model ? budgets.find((b) => b.models.includes(model))?.id : undefined);
  return Object.fromEntries(
    Object.entries(roles).map(([role, { agent: _previous, ...choice }]) => {
      const budget = budgetOf(choice.model);
      const agent = agents.find((a) => a.model === choice.model) ?? agents.find((a) => budget && budgetOf(a.model) === budget);
      return [role, agent ? { ...choice, agent: agent.id } : choice];
    }),
  );
}

function RolesStep(props: {
  setup: SetupState;
  budgets: BudgetInfo[];
  roles: Record<string, RoleModel>;
  setRoles: (r: Record<string, RoleModel>) => void;
  /** True when the wizard filled in some roles itself. */
  suggested: boolean;
}) {
  const { setup, budgets, roles, setRoles, suggested } = props;
  const options = budgets.flatMap((b) => b.models.map((m) => ({ model: m, budget: b.name })));
  const choose = (role: string, change: Partial<RoleModel>) => setRoles({ ...roles, [role]: { ...(roles[role] ?? { model: '' }), ...change } });
  return (
    <Step title="Workflow roles">
      <p>Choose the model each role of the default Workflow runs on, and a fallback for when its Budget runs low.</p>
      {suggested ? (
        <p className="setup-hint">
          Suggested from your Budgets: the strongest model for planning and review, a faster one for implementing, and a fallback from another
          Budget where there is one. Change any of them.
        </p>
      ) : null}
      <div className="setup-roles">
        <div className="setup-role-head" aria-hidden="true">
          <span>Role</span>
          <span>Model</span>
          <span>Fallback</span>
        </div>
        {setup.roles.map(({ role, stages }) => (
          <div key={role} className="setup-role">
            <span className="setup-role-name">
              <strong>{role}</strong>
              <small>{stages.join(', ')}</small>
            </span>
            <label>
              <span className="visually-hidden">{role} model</span>
              <select aria-label={`${role} model`} value={roles[role]?.model ?? ''} onChange={(e) => choose(role, { model: e.target.value })}>
                <option value="">Choose a model</option>
                {options.map((o) => (
                  <option key={o.model} value={o.model}>
                    {o.model} ({o.budget})
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="visually-hidden">{role} fallback</span>
              <select
                aria-label={`${role} fallback`}
                value={roles[role]?.fallbackModel ?? ''}
                onChange={(e) => choose(role, { fallbackModel: e.target.value || undefined })}
              >
                <option value="">No fallback</option>
                {options.map((o) => (
                  <option key={o.model} value={o.model}>
                    {o.model} ({o.budget})
                  </option>
                ))}
              </select>
            </label>
          </div>
        ))}
      </div>
    </Step>
  );
}

function ImportStep({ setup, onImported }: { setup: SetupState; onImported: () => Promise<void> }) {
  const importable = setup.oldBoard.projects.filter((p) => !p.skip && !p.registered);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(importable.map((p) => p.path)));
  const [result, setResult] = useState<ImportResult>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setResult(await api<ImportResult>('POST', '/api/setup/import', { paths: [...chosen] }));
      await onImported();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Step title="Import">
      <p>Bring the old board's Projects into Kiln, once. The old board is only read: nothing in its folder changes.</p>
      {!setup.oldBoard.found ? <p>No old board found at {setup.oldBoard.registry}. Nothing to import.</p> : null}
      {setup.oldBoard.error ? <p role="alert">{setup.oldBoard.error}</p> : null}
      <div className="choices">
        {setup.oldBoard.projects.map((p) => (
          <Choice
            key={p.path}
            type="checkbox"
            disabled={Boolean(p.skip) || p.registered}
            checked={chosen.has(p.path)}
            onChange={(checked) => {
              const next = new Set(chosen);
              if (checked) next.add(p.path);
              else next.delete(p.path);
              setChosen(next);
            }}
            title={p.name}
            detail={p.skip ? `Not imported: ${p.skip}` : p.registered ? 'Already in Kiln' : undefined}
            path={p.path}
          />
        ))}
      </div>
      {importable.length ? (
        <button type="button" className="primary setup-action" onClick={() => void run()} disabled={busy || chosen.size === 0}>
          Import Projects
        </button>
      ) : null}
      {result ? (
        <p role="status">
          {result.imported.length ? `Imported ${result.imported.map((p) => p.name).join(', ')}` : 'Nothing imported'}
          {result.skipped.length ? `. Skipped ${result.skipped.map((s) => `${s.name} (${s.reason})`).join(', ')}` : ''}
        </p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </Step>
  );
}

export function SetupWizard() {
  const liveBudgets = useStore((s) => s.budgets);
  const [setup, setSetup] = useState<SetupState>();
  const [budgets, setBudgets] = useState<BudgetInfo[]>([]);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [login, setLogin] = useState<LoginMode>('local');
  const [folder, setFolder] = useState('');
  const [install, setInstallKind] = useState<InstallKind>();
  const [drafts, setDrafts] = useState<BudgetDraft[]>([]);
  const [repo, setRepo] = useState('');
  // The Models step: the Budget picked for a model ('' for none), and the models added by hand.
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [added, setAdded] = useState<string[]>([]);
  const [widgets, setWidgets] = useState<WidgetInfo[]>([]);
  const [roles, setRoles] = useState<Record<string, RoleModel>>({});
  const [suggested, setSuggested] = useState(false);
  // The steps depend on the instance (GET /api/status): a dev instance has no Import step.
  const [steps, setSteps] = useState<readonly StepName[]>();

  const refresh = async () => {
    const [state, list] = await Promise.all([api<SetupState>('GET', '/api/setup'), api<BudgetInfo[]>('GET', '/api/budgets')]);
    setSetup(state);
    setBudgets(list);
    return { state, list };
  };
  useEffect(() => {
    api<CoreStatus>('GET', '/api/status').then(
      (status) => setSteps(status.instance === 'dev' ? DEV_STEPS : LIVE_STEPS),
      (err: Error) => setError(err.message),
    );
    refresh().then(
      ({ state, list }) => {
        setLogin(state.settings.login ?? state.running.login);
        setFolder(state.settings.knowledgeDir ?? state.running.knowledgeDir);
        setRepo(state.widgetRepo);
        setRoles(state.settings.roles ?? {});
        if (state.settings.install) {
          setInstallKind(state.settings.install);
          setDrafts(state.defaults[state.settings.install].map((d) => draftFor(d, list)));
        }
      },
      (err: Error) => setError(err.message),
    );
  }, []);
  useEffect(() => {
    if (liveBudgets.length) setBudgets(liveBudgets);
  }, [liveBudgets]);
  // An Agent reports its models when its Widget registers, which can be just after it's installed.
  useEffect(() => {
    if (steps?.[step] !== 'Models') return;
    let live = true;
    const load = () => api<WidgetInfo[]>('GET', '/api/widgets').then((w) => live && setWidgets(w), () => undefined);
    void load();
    const timer = setInterval(load, 3000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [step, steps]);

  // The roles step opens with a model suggested for every role that has none yet.
  useEffect(() => {
    if (steps?.[step] !== 'Workflow roles' || !setup) return;
    const filled = suggestRoles(
      setup.roles.map((r) => r.role),
      budgets,
      roles,
    );
    if (filled !== roles) {
      setRoles(filled);
      setSuggested(true);
    }
  }, [step, budgets, setup]);

  if (!setup || !steps) return <section aria-label="Set up Kiln">{error ? <p role="alert">{error}</p> : <p>Loading setup.</p>}</section>;

  const setInstall = (kind: InstallKind) => {
    setInstallKind(kind);
    setDrafts(setup.defaults[kind].map((d) => draftFor(d, budgets)));
  };

  const rolesChosen = setup.roles.every(({ role }) => roles[role]?.model);
  // The Budgets the Models step offers: this install's, then any others already set up.
  const entries: BudgetDraft[] = [
    ...drafts,
    ...budgets.filter((b) => !drafts.some((d) => d.id === b.id)).map((b) => ({ ...b.config, id: b.id, kind: b.kind, name: b.name, models: b.models })),
  ];
  const rows = modelRows(widgets, setup, entries, budgets, added);
  const budgetOf = (row: ModelRow) => budgetFor(row, entries, picked);
  const needed: Partial<Record<StepName, boolean>> = { 'Knowledge store': folder.trim() !== '', Install: Boolean(install), 'Workflow roles': rolesChosen };
  const canGoOn = needed[steps[step]!] ?? true;

  /** Saves what this step chose; returns false to stay on it. */
  const save = async () => {
    const name = steps[step];
    if (name === 'Login') await api('PUT', '/api/setup', { login });
    if (name === 'Knowledge store') await api('PUT', '/api/setup', { knowledgeDir: folder.trim() });
    if (name === 'Install') {
      await api('PUT', '/api/setup', { install });
      setPicked({});
    }
    if (name === 'Models') {
      const wanted = new Map(entries.map((e) => [e.id, [] as string[]]));
      for (const row of rows) wanted.get(budgetOf(row))?.push(row.id);
      for (const entry of entries) {
        if (budgets.some((b) => b.id === entry.id) && !wanted.get(entry.id)!.length) {
          throw new Error(`${entry.name ?? entry.id} needs at least one model. Give it one, or remove it on its Budget's page.`);
        }
      }
      // Budgets that give a model up save first, so no model is in two Budgets on the way.
      const drops = (e: BudgetDraft) => e.models.some((m) => !wanted.get(e.id)!.includes(m));
      for (const entry of [...entries].sort((a, b) => Number(drops(b)) - Number(drops(a)))) {
        const models = wanted.get(entry.id)!;
        if (models.length === 0) continue;
        await api('PUT', `/api/budgets/${encodeURIComponent(entry.id)}`, { ...withoutId(entry), models });
      }
      const { list } = await refresh();
      if (list.length === 0) throw new Error('Give at least one Budget its models.');
      return;
    }
    if (name === 'Workflow roles') {
      const widgets = await api<WidgetInfo[]>('GET', '/api/widgets');
      await api('PUT', '/api/setup', { roles: withAgents(roles, budgets, widgets) });
    }
    await refresh();
  };

  const go = async (to: number) => {
    setBusy(true);
    setError(undefined);
    try {
      if (to > step) await save();
      setStep(to);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api('POST', '/api/setup/complete');
      navigate('/');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const name = steps[step];
  return (
    <section aria-label="Set up Kiln" className="setup">
      <div className="setup-head">
        <h2>Set up Kiln</h2>
        <p>
          Step {step + 1} of {steps.length}
          {setup.completed ? '. Kiln is set up already: change anything you like.' : ''}
        </p>
        <div className="setup-progress" aria-hidden="true">
          <span style={{ width: `${((step + 1) / steps.length) * 100}%` }} />
        </div>
      </div>
      <div className="setup-layout">
        {/* Steps already passed can be revisited; later ones open only through Next, which saves. */}
        <ol className="setup-steps" aria-label="Setup steps">
          {steps.map((title, i) => (
            <li key={title} className={i < step ? 'done' : undefined} aria-current={i === step ? 'step' : undefined}>
              {i < step ? (
                <button type="button" onClick={() => void go(i)} disabled={busy} aria-label={`Revisit ${title}`}>
                  <span className="setup-step-dot" aria-hidden="true" />
                  <span className="setup-step-name">{title}</span>
                </button>
              ) : (
                <span className="setup-step-label">
                  <span className="setup-step-dot" aria-hidden="true" />
                  <span className="setup-step-name">{title}</span>
                </span>
              )}
            </li>
          ))}
        </ol>
        <div className="setup-card">
      {name === 'Login' ? <LoginStep setup={setup} login={login} setLogin={setLogin} /> : null}
      {name === 'Knowledge store' ? <KnowledgeStep setup={setup} folder={folder} setFolder={setFolder} /> : null}
      {name === 'Install' ? <InstallStep setup={setup} install={install} setInstall={setInstall} drafts={drafts} setDrafts={setDrafts} /> : null}
      {name === 'Agents' ? <AgentsStep setup={setup} install={install} repo={repo} setRepo={setRepo} onInstalled={async () => void (await refresh())} /> : null}
      {name === 'Models' ? (
        <ModelsStep
          rows={rows}
          entries={entries}
          budgetOf={budgetOf}
          pick={(model, budget) => setPicked({ ...picked, [model]: budget })}
          add={(model) => setAdded(added.includes(model) ? added : [...added, model])}
        />
      ) : null}
      {name === 'Workflow roles' ? <RolesStep setup={setup} budgets={budgets} roles={roles} setRoles={setRoles} suggested={suggested} /> : null}
      {name === 'Import' ? <ImportStep setup={setup} onImported={async () => void (await refresh())} /> : null}
          {error ? <p role="alert">{error}</p> : null}
          <div className="setup-buttons">
            {step > 0 ? (
              <button type="button" className="ghost" onClick={() => void go(step - 1)} disabled={busy}>
                Back
              </button>
            ) : null}
            <span className="spacer" />
            {step < steps.length - 1 ? (
              <button type="button" className="primary" onClick={() => void go(step + 1)} disabled={busy || !canGoOn}>
                Next
              </button>
            ) : (
              <button type="button" className="primary" onClick={() => void finish()} disabled={busy}>
                Finish
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
