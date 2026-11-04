// The setup wizard (ticket 25): the steps an Admin walks on first run, and again from Settings.
// Each step saves as it goes (PUT /api/setup, the Budget and Widget routes); Finish asks the core
// to mark setup done, which it refuses while a Budget or a role's model is missing.
import { useEffect, useState, type ReactNode } from 'react';
import type { BudgetDraft, BudgetInfo, ImportResult, InstallKind, LoginMode, RoleModel, SetupState, TailscaleServe, WidgetInfo } from '@kiln/widget-sdk';
import { navigate } from './router.ts';
import { api, useStore } from './store.ts';

export const SETUP_PATH = '/setup';

const STEPS = ['Login', 'Knowledge store', 'Install', 'Agents', 'Models', 'Workflow roles', 'Import'] as const;

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
const splitModels = (text: string) => [...new Set(text.split(',').map((m) => m.trim()).filter(Boolean))];

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

function ModelsStep({ entries, models, setModels }: { entries: BudgetDraft[]; models: Record<string, string>; setModels: (m: Record<string, string>) => void }) {
  const [widgets, setWidgets] = useState<WidgetInfo[]>([]);
  useEffect(() => {
    void api<WidgetInfo[]>('GET', '/api/widgets').then(setWidgets, () => undefined);
  }, []);
  const agentModels = [...new Set(widgets.flatMap((w) => w.agents.map((a) => a.model)).filter((m): m is string => Boolean(m)))];
  return (
    <Step title="Models">
      <p>
        Each model draws from one Budget. List each Budget's models, separated by commas. A Budget with no models is not set up.
      </p>
      {agentModels.length ? <p className="setup-hint">Your Agents run: {agentModels.join(', ')}</p> : null}
      {entries.map((budget) => (
        <fieldset key={budget.id} aria-label={budget.name ?? budget.id}>
          <legend>{budget.name ?? budget.id}</legend>
          <label>
            Models
            <input
              value={models[budget.id] ?? ''}
              onChange={(e) => setModels({ ...models, [budget.id]: e.target.value })}
              spellCheck={false}
              placeholder="model-a, model-b"
            />
          </label>
        </fieldset>
      ))}
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

function RolesStep({ setup, budgets, roles, setRoles }: { setup: SetupState; budgets: BudgetInfo[]; roles: Record<string, RoleModel>; setRoles: (r: Record<string, RoleModel>) => void }) {
  const options = budgets.flatMap((b) => b.models.map((m) => ({ model: m, budget: b.name })));
  const choose = (role: string, change: Partial<RoleModel>) => setRoles({ ...roles, [role]: { ...(roles[role] ?? { model: '' }), ...change } });
  return (
    <Step title="Workflow roles">
      <p>Choose the model each role of the default Workflow runs on, and a fallback for when its Budget runs low.</p>
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
  const [models, setModels] = useState<Record<string, string>>({});
  const [roles, setRoles] = useState<Record<string, RoleModel>>({});

  const refresh = async () => {
    const [state, list] = await Promise.all([api<SetupState>('GET', '/api/setup'), api<BudgetInfo[]>('GET', '/api/budgets')]);
    setSetup(state);
    setBudgets(list);
    return { state, list };
  };
  useEffect(() => {
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

  if (!setup) return <section aria-label="Set up Kiln">{error ? <p role="alert">{error}</p> : <p>Loading setup.</p>}</section>;

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
  const canGoOn = [true, folder.trim() !== '', Boolean(install), true, true, rolesChosen, true][step];

  /** Saves what this step chose; returns false to stay on it. */
  const save = async () => {
    const name = STEPS[step];
    if (name === 'Login') await api('PUT', '/api/setup', { login });
    if (name === 'Knowledge store') await api('PUT', '/api/setup', { knowledgeDir: folder.trim() });
    if (name === 'Install') {
      await api('PUT', '/api/setup', { install });
      setModels(Object.fromEntries(entries.map((b) => [b.id, b.models.join(', ')])));
    }
    if (name === 'Models') {
      for (const entry of entries) {
        const wanted = splitModels(models[entry.id] ?? '');
        if (wanted.length === 0) continue;
        await api('PUT', `/api/budgets/${encodeURIComponent(entry.id)}`, { ...withoutId(entry), models: wanted });
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

  const name = STEPS[step];
  return (
    <section aria-label="Set up Kiln" className="setup">
      <div className="setup-head">
        <h2>Set up Kiln</h2>
        <p>
          Step {step + 1} of {STEPS.length}
          {setup.completed ? '. Kiln is set up already: change anything you like.' : ''}
        </p>
        <div className="setup-progress" aria-hidden="true">
          <span style={{ width: `${((step + 1) / STEPS.length) * 100}%` }} />
        </div>
      </div>
      <div className="setup-layout">
        {/* Steps already passed can be revisited; later ones open only through Next, which saves. */}
        <ol className="setup-steps" aria-label="Setup steps">
          {STEPS.map((title, i) => (
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
      {name === 'Models' ? <ModelsStep entries={entries} models={models} setModels={setModels} /> : null}
      {name === 'Workflow roles' ? <RolesStep setup={setup} budgets={budgets} roles={roles} setRoles={setRoles} /> : null}
      {name === 'Import' ? <ImportStep setup={setup} onImported={async () => void (await refresh())} /> : null}
          {error ? <p role="alert">{error}</p> : null}
          <div className="setup-buttons">
            {step > 0 ? (
              <button type="button" className="ghost" onClick={() => void go(step - 1)} disabled={busy}>
                Back
              </button>
            ) : null}
            <span className="spacer" />
            {step < STEPS.length - 1 ? (
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
