// Settings → Models (local-first Ticket 06): where the local server is, the variants it runs, and
// Add a model. Adding one needs no AI and no hand-edited YAML: pick a GGUF file on the core's
// machine (or download one from Hugging Face), check the recommended settings, and Save writes the
// server's entry, reloads it and smoke-tests the model.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type {
  AddVariantRequest,
  HuggingFaceFile,
  HuggingFaceFiles,
  LocalServerSettings,
  ModelDownload,
  ModelInspection,
  SmokeTestResult,
  Variant,
  VariantList,
  VariantSettings,
} from '@kiln/widget-sdk';
import { followLink } from '../router.ts';
import { api, useStore } from '../store.ts';

export const MODELS_PATH = '/settings/models';

const KiB = 1024;
const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
/** Sizes as Kiln's recommendations write them (GB meaning 1024³ bytes). */
export const size = (bytes: number) =>
  bytes >= GiB ? `${(bytes / GiB).toFixed(1)} GB` : bytes >= MiB ? `${(bytes / MiB).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / KiB))} KB`;
const k = (tokens: number) => `${Number((tokens / 1024).toFixed(1))}K`;
const baseName = (path: string) => path.replace(/\\/g, '/').split('/').pop() ?? path;

/** The server model id Kiln would make from a file name (as the core does). */
const slug = (text: string) =>
  text.toLowerCase().replace(/\.gguf$/, '').replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'variant';
/** `base`, or `base-2`, `base-3` ... whichever is free. */
const unused = (base: string, taken: Set<string>, joiner = '-') => {
  let candidate = base;
  for (let n = 2; taken.has(candidate); n++) candidate = `${base}${joiner}${n}`;
  return candidate;
};

const describeSmokeTest = (test: SmokeTestResult | undefined) => {
  if (!test) return 'Not run yet';
  if (!test.passed) return `Failed: ${test.reason ?? 'no reason given'}`;
  const parts = [test.loadMs !== undefined ? `loaded in ${(test.loadMs / 1000).toFixed(1)} s` : undefined, test.tokensPerSecond !== undefined ? `${test.tokensPerSecond.toFixed(1)} tokens/s` : undefined];
  return `Passed: ${parts.filter(Boolean).join(', ')}${parts.some(Boolean) ? ', ' : ''}answered a Claude Code tool call`;
};

const describeSettings = (s: VariantSettings) =>
  [
    s.contextSize !== undefined ? `${k(s.contextSize)} context` : undefined,
    s.gpuLayers !== undefined ? `${s.gpuLayers} GPU layers` : undefined,
    s.kvCacheType ? `${s.kvCacheType} KV cache` : undefined,
    s.threads !== undefined ? `${s.threads} threads` : undefined,
    ...s.extraFlags,
  ]
    .filter(Boolean)
    .join(', ') || 'llama-server defaults';

// ---------- the local server Setting ----------

function LocalServerForm({ settings, onSaved }: { settings: LocalServerSettings; onSaved: (s: LocalServerSettings) => void }) {
  const [configPath, setConfigPath] = useState(settings.configPath ?? '');
  const [url, setUrl] = useState(settings.url ?? '');
  const [modelsFolder, setModelsFolder] = useState(settings.modelsFolder ?? '');
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setStatus(undefined);
    try {
      const orNull = (v: string) => (v.trim() ? v.trim() : null);
      onSaved(await api<LocalServerSettings>('PUT', '/api/local-server', { configPath: orNull(configPath), url: orNull(url), modelsFolder: orNull(modelsFolder) }));
      setStatus('Saved');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form aria-label="Local server" className="models-form" onSubmit={save}>
      <p className="setup-hint">
        Kiln runs local models through llama-swap. It writes one entry per variant in llama-swap's config and leaves the rest of
        the file as it is; llama-swap must run with <code>--watch-config</code>. Nothing here has a default.
      </p>
      <label>
        llama-swap config file
        <input value={configPath} onChange={(e) => setConfigPath(e.target.value)} placeholder="Full path of config.yaml" />
      </label>
      <label>
        llama-swap URL
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://127.0.0.1:<port>" />
      </label>
      <label>
        Models folder
        <input value={modelsFolder} onChange={(e) => setModelsFolder(e.target.value)} placeholder="Where Hugging Face downloads go" />
      </label>
      <div>
        <button type="submit" disabled={busy}>
          Save the local server
        </button>{' '}
        {status ? <span role="status">{status}</span> : null}
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </form>
  );
}

// ---------- the variant list ----------

function VariantRow({ variant, onChanged, onAnother }: { variant: Variant; onChanged: () => void; onAnother: (v: Variant) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const act = async (method: string, path: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await api<Variant>(method, path);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setConfirmRemove(false);
    }
  };
  const at = `/api/variants/${encodeURIComponent(variant.id)}`;
  const removed = variant.state === 'removed';
  const state =
    variant.state === 'enabled' ? 'Enabled' : removed ? 'Removed (its results stay on the scoreboard)' : `Disabled: ${variant.disabledReason ?? 'no reason given'}`;
  return (
    <tr aria-label={variant.name}>
      <td>
        <strong>{variant.name}</strong>
        <br />
        <small>
          {variant.serverModelId}
          {variant.file ? ` · ${baseName(variant.file.path)}` : ''}
          {variant.file?.sizeBytes !== undefined ? ` · ${size(variant.file.sizeBytes)}` : ''}
          {variant.origin === 'server' ? ' · written by hand in the server config' : ''}
        </small>
      </td>
      <td>{describeSettings(variant.settings)}</td>
      <td>{state}</td>
      <td>{describeSmokeTest(variant.lastSmokeTest)}</td>
      <td className="models-actions">
        {!removed && variant.state !== 'enabled' ? (
          <button type="button" disabled={busy} onClick={() => void act('POST', `${at}/enable`)}>
            Enable
          </button>
        ) : null}
        {variant.state === 'enabled' ? (
          <button type="button" disabled={busy} onClick={() => void act('POST', `${at}/disable`)}>
            Disable
          </button>
        ) : null}
        {!removed ? (
          <button type="button" disabled={busy} onClick={() => void act('POST', `${at}/smoke-test`)}>
            Smoke test
          </button>
        ) : null}
        {variant.file ? (
          <button type="button" disabled={busy} onClick={() => onAnother(variant)}>
            Add another variant
          </button>
        ) : null}
        {!removed && !confirmRemove ? (
          <button type="button" disabled={busy} onClick={() => setConfirmRemove(true)}>
            Remove
          </button>
        ) : null}
        {confirmRemove ? (
          <span role="group" aria-label={`Remove ${variant.name}?`}>
            Its entry leaves the server's config; its results stay.{' '}
            <button type="button" className="danger" disabled={busy} onClick={() => void act('DELETE', at)}>
              Remove it
            </button>{' '}
            <button type="button" onClick={() => setConfirmRemove(false)}>
              Keep it
            </button>
          </span>
        ) : null}
        {busy ? <span role="status">Working…</span> : null}
        {error ? <span role="alert">{error}</span> : null}
      </td>
    </tr>
  );
}

function VariantTable({ list, onChanged, onAnother }: { list: VariantList; onChanged: () => void; onAnother: (v: Variant) => void }) {
  return (
    <>
      {!list.server.configured ? <p className="setup-hint">Set the llama-swap config file and URL above to see and add variants.</p> : null}
      {list.server.error ? <p role="alert">{list.server.error}</p> : null}
      {list.variants.length === 0 ? (
        <p>No variants yet.</p>
      ) : (
        <table aria-label="Variants">
          <thead>
            <tr>
              <th>Variant</th>
              <th>Settings</th>
              <th>State</th>
              <th>Last smoke test</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {list.variants.map((v) => (
              <VariantRow key={v.id} variant={v} onChanged={onChanged} onAnother={onAnother} />
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

// ---------- Hugging Face ----------

function HuggingFacePicker({ modelsFolder, onDownloaded }: { modelsFolder?: string; onDownloaded: (path: string) => void }) {
  const [repo, setRepo] = useState('');
  const [files, setFiles] = useState<HuggingFaceFiles>();
  const [chosen, setChosen] = useState<HuggingFaceFile>();
  const [download, setDownload] = useState<ModelDownload>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const reported = useRef<string | undefined>(undefined);

  // Follow a running download until it finishes.
  useEffect(() => {
    if (download?.state !== 'running') return;
    const timer = setTimeout(() => {
      api<ModelDownload>('GET', `/api/local-models/downloads/${encodeURIComponent(download.id)}`).then(setDownload, (err: Error) => setError(err.message));
    }, 250);
    return () => clearTimeout(timer);
  }, [download]);
  useEffect(() => {
    if (download?.state === 'done' && reported.current !== download.id) {
      reported.current = download.id;
      onDownloaded(download.path);
    }
  }, [download, onDownloaded]);

  const list = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setFiles(undefined);
    setChosen(undefined);
    setDownload(undefined);
    try {
      setFiles(await api<HuggingFaceFiles>('GET', `/api/local-models/huggingface?repo=${encodeURIComponent(repo.trim())}`));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const start = async () => {
    if (!files || !chosen) return;
    setError(undefined);
    try {
      setDownload(await api<ModelDownload>('POST', '/api/local-models/downloads', { repo: files.repo, file: chosen.path }));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const running = download?.state === 'running';
  return (
    <div className="models-hf">
      <form aria-label="Hugging Face repo" onSubmit={list}>
        <label>
          Hugging Face repo
          <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/name" />
        </label>{' '}
        <button type="submit" disabled={busy || !repo.trim()}>
          List files
        </button>
      </form>
      {files && files.files.length === 0 ? <p>{files.repo} has no GGUF files.</p> : null}
      {files && files.files.length > 0 ? (
        <fieldset aria-label="Quant" disabled={running}>
          <legend>Pick a quant</legend>
          {files.files.map((f) => (
            <label key={f.path} className="models-radio">
              <input type="radio" name="hf-file" checked={chosen?.path === f.path} onChange={() => (setChosen(f), setDownload(undefined))} />
              {f.path} ({size(f.sizeBytes)}{f.parts ? ` in ${f.parts.length} parts` : ''})
            </label>
          ))}
        </fieldset>
      ) : null}
      {chosen && !download ? (
        <div role="group" aria-label="Confirm the download" className="models-confirm">
          {modelsFolder ? (
            <>
              <p>
                Download <strong>{baseName(chosen.path)}</strong> ({size(chosen.sizeBytes)}
                {chosen.parts ? `, all ${chosen.parts.length} parts` : ''}) from {files?.repo} to {modelsFolder}? Nothing downloads until you
                say so.
              </p>
              <button type="button" className="primary" onClick={() => void start()}>
                Download {size(chosen.sizeBytes)}
              </button>
            </>
          ) : (
            <p role="alert">Set the models folder above first: downloads go there.</p>
          )}
        </div>
      ) : null}
      {download ? (
        <div className="models-download">
          <progress aria-label="Download progress" value={download.receivedBytes} max={download.totalBytes} />{' '}
          <span role="status">
            {download.state === 'done'
              ? `Downloaded ${baseName(download.path)} (${size(download.totalBytes)}${download.parts ? ` in ${download.parts.length} parts` : ''}) to ${download.path}`
              : `${baseName(download.path)}: ${size(download.receivedBytes)} of ${size(download.totalBytes)} (${Math.floor((download.receivedBytes / download.totalBytes) * 100)}%)${download.resumedFromBytes ? `, resumed from ${size(download.resumedFromBytes)}` : ''}`}
          </span>
          {download.state === 'failed' ? (
            <>
              <p role="alert">{download.error}</p>
              <button type="button" onClick={() => void start()}>
                Resume the download
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}

// ---------- Add a model ----------

/** What "Add another variant" starts from: an existing variant's file and settings. */
export interface AddPrefill {
  from: Variant;
}

type Field = 'contextSize' | 'gpuLayers' | 'kvCacheType' | 'threads';

interface FormValues {
  name: string;
  serverModelId: string;
  contextSize: string;
  gpuLayers: string;
  kvCacheType: string;
  threads: string;
  extraFlags: string;
}

const JINJA_REASON = "--jinja makes llama-server use the model's own chat template, which Claude Code's tool calls need";

function AddModel({ prefill, variants, modelsFolder, onSaved }: { prefill?: AddPrefill; variants: Variant[]; modelsFolder?: string; onSaved: (v: Variant) => void }) {
  const [source, setSource] = useState<'disk' | 'hf'>('disk');
  const [path, setPath] = useState(prefill?.from.file?.path ?? '');
  const [info, setInfo] = useState<ModelInspection>();
  const [values, setValues] = useState<FormValues>();
  const [result, setResult] = useState<Variant>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const touched = useRef(new Set<Field>());

  const takenIds = new Set(variants.map((v) => v.serverModelId));
  const takenNames = new Set(variants.map((v) => v.name));

  /** Reads the file and fills the form: the recommendation, or (for another variant) the last settings. */
  const inspect = async (filePath: string, kvCacheType?: string, keep?: FormValues) => {
    setBusy('Reading the file…');
    setError(undefined);
    try {
      const read = await api<ModelInspection>('POST', '/api/local-models/inspect', { path: filePath, ...(kvCacheType ? { kvCacheType } : {}) });
      setInfo(read);
      const r = read.recommended;
      const fresh: FormValues = {
        name: unused(read.suggestedName, takenNames, ' '),
        serverModelId: unused(read.suggestedServerModelId, takenIds),
        contextSize: String(r.contextSize),
        gpuLayers: String(r.gpuLayers),
        kvCacheType: r.kvCacheType,
        threads: String(r.threads),
        extraFlags: '--jinja',
      };
      if (!keep) return setValues(fresh);
      // Fields the person (or the variant copied) set stay; the others follow the new recommendation.
      const next = { ...keep };
      for (const field of ['contextSize', 'gpuLayers', 'threads'] as const) if (!touched.current.has(field)) next[field] = fresh[field];
      setValues(next);
    } catch (err) {
      setError((err as Error).message);
      setInfo(undefined);
      setValues(undefined);
    } finally {
      setBusy(undefined);
    }
  };

  // "Add another variant": the model and its last settings, with a free name and server model id.
  useEffect(() => {
    const from = prefill?.from;
    if (!from?.file) return;
    const s = from.settings;
    touched.current = new Set<Field>(['kvCacheType', ...(['contextSize', 'gpuLayers', 'threads'] as const).filter((f) => s[f] !== undefined)]);
    const copied: FormValues = {
      name: unused(from.name, takenNames, ' '),
      serverModelId: unused(from.serverModelId, takenIds),
      contextSize: s.contextSize !== undefined ? String(s.contextSize) : '',
      gpuLayers: s.gpuLayers !== undefined ? String(s.gpuLayers) : '',
      kvCacheType: s.kvCacheType ?? 'f16',
      threads: s.threads !== undefined ? String(s.threads) : '',
      extraFlags: s.extraFlags.join(' '),
    };
    void inspect(from.file.path, copied.kvCacheType, copied);
    // Runs once per prefill: the parent remounts this form for each "Add another variant".
  }, []);

  const set = (field: keyof FormValues, value: string) => {
    if (field === 'contextSize' || field === 'gpuLayers' || field === 'threads' || field === 'kvCacheType') touched.current.add(field);
    setValues((v) => (v ? { ...v, [field]: value } : v));
  };
  const changeKv = (kvCacheType: string) => {
    if (!values || !info) return;
    const next = { ...values, kvCacheType };
    setValues(next);
    // The context and layers that fit depend on the cache type: ask again.
    void inspect(info.file.path, kvCacheType, next);
  };

  const read = (event: FormEvent) => {
    event.preventDefault();
    touched.current = new Set();
    setResult(undefined);
    void inspect(path.trim());
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!values || !info) return;
    setBusy('Writing the entry, reloading the server and running the smoke test…');
    setError(undefined);
    setResult(undefined);
    try {
      const whole = (v: string) => Number(v.trim());
      const body: AddVariantRequest = {
        name: values.name.trim(),
        ...(values.serverModelId.trim() ? { serverModelId: values.serverModelId.trim() } : {}),
        file: { path: info.file.path },
        settings: {
          contextSize: whole(values.contextSize),
          gpuLayers: whole(values.gpuLayers),
          kvCacheType: values.kvCacheType,
          ...(values.threads.trim() ? { threads: whole(values.threads) } : {}),
          extraFlags: values.extraFlags.split(/\s+/).filter(Boolean),
        },
      };
      const saved = await api<Variant>('POST', '/api/variants', body);
      setResult(saved);
      onSaved(saved);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const r = info?.recommended;
  const hint = (field: Field, shown: string) =>
    r ? (
      <small className="models-reason">
        Recommended {shown}: {r.reasons[field]}
      </small>
    ) : null;

  return (
    <div className="models-add">
      {prefill ? (
        <p role="note">
          Another variant of <strong>{prefill.from.name}</strong>: the file and its last settings are filled in. Change what this variant
          should do differently.
        </p>
      ) : (
        <div role="radiogroup" aria-label="Where the model is" className="models-source">
          <label className="models-radio">
            <input type="radio" name="model-source" checked={source === 'disk'} onChange={() => setSource('disk')} />A GGUF file on the
            Kiln machine
          </label>
          <label className="models-radio">
            <input type="radio" name="model-source" checked={source === 'hf'} onChange={() => setSource('hf')} />A Hugging Face repo
          </label>
        </div>
      )}
      {source === 'hf' && !prefill ? (
        <HuggingFacePicker
          modelsFolder={modelsFolder}
          onDownloaded={(downloaded) => {
            setPath(downloaded);
            touched.current = new Set();
            void inspect(downloaded);
          }}
        />
      ) : null}
      {source === 'disk' || prefill ? (
        <form aria-label="GGUF file" onSubmit={read}>
          <label>
            GGUF file
            <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="Full path of a .gguf file on the Kiln machine" />
          </label>{' '}
          <button type="submit" disabled={!!busy || !path.trim()}>
            Read the file
          </button>
        </form>
      ) : null}

      {info && values && r ? (
        <form aria-label="Variant settings" className="models-form" onSubmit={save}>
          <p className="setup-hint">
            {info.model.name ?? info.model.architecture}: {info.file.quant ?? 'unknown quant'}, {size(info.file.sizeBytes)}, {info.model.layerCount}{' '}
            layers, trained for {k(info.model.trainingContext)} tokens.{' '}
            {info.gpu.source
              ? `Sized for ${info.gpu.name}: ${size((info.gpu.memoryUsedMiB ?? 0) * MiB)} of ${size((info.gpu.memoryTotalMiB ?? 0) * MiB)} in use.`
              : 'No GPU reading: install the GPU monitor Widget to size it for the GPU.'}
          </p>
          <label>
            Name
            <input value={values.name} onChange={(e) => set('name', e.target.value)} required />
          </label>
          <label>
            Server model id
            <input value={values.serverModelId} onChange={(e) => set('serverModelId', e.target.value)} />
            <small className="models-reason">The name llama-swap serves it under, and the model a Session asks for.</small>
          </label>
          <label>
            Context size
            <input type="number" min={256} step={1} value={values.contextSize} onChange={(e) => set('contextSize', e.target.value)} required />
            {hint('contextSize', String(r.contextSize))}
          </label>
          <label>
            GPU layers
            <input type="number" min={0} step={1} value={values.gpuLayers} onChange={(e) => set('gpuLayers', e.target.value)} required />
            {hint('gpuLayers', String(r.gpuLayers))}
          </label>
          <label>
            KV cache type
            <select value={values.kvCacheType} onChange={(e) => changeKv(e.target.value)}>
              {info.kvCacheTypes.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            {hint('kvCacheType', r.kvCacheType)}
          </label>
          <label>
            Threads
            <input type="number" min={1} step={1} value={values.threads} onChange={(e) => set('threads', e.target.value)} />
            {hint('threads', String(r.threads))}
          </label>
          <label>
            Extra flags
            <input value={values.extraFlags} onChange={(e) => set('extraFlags', e.target.value)} />
            <small className="models-reason">{JINJA_REASON}.</small>
          </label>
          <div>
            <button type="submit" className="primary" disabled={!!busy || !values.name.trim()}>
              Save and smoke-test
            </button>
          </div>
        </form>
      ) : null}
      {busy ? <p role="status">{busy}</p> : null}
      {result ? (
        result.state === 'enabled' ? (
          <p role="status" className="models-result">
            {result.name} is enabled. Smoke test {describeSmokeTest(result.lastSmokeTest).replace(/^Passed/, 'passed')}.
          </p>
        ) : (
          <p role="alert" className="models-result">
            {result.name} stays disabled. {result.disabledReason}
          </p>
        )
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}

// ---------- the page ----------

export function ModelsPage() {
  const [settings, setSettings] = useState<LocalServerSettings>();
  const [list, setList] = useState<VariantList>();
  const [error, setError] = useState<string>();
  const [prefill, setPrefill] = useState<AddPrefill>();
  const [formKey, setFormKey] = useState(0);
  const lastEvent = useStore((s) => s.lastEvent);
  const addRef = useRef<HTMLHeadingElement>(null);

  const reload = () => {
    api<VariantList>('GET', '/api/variants').then(setList, (err: Error) => setError(err.message));
  };
  useEffect(() => {
    api<LocalServerSettings>('GET', '/api/local-server').then(setSettings, (err: Error) => setError(err.message));
    reload();
  }, []);
  useEffect(() => {
    if (lastEvent?.type === 'variant.updated') reload();
  }, [lastEvent]);

  const another = (from: Variant) => {
    setPrefill({ from });
    setFormKey((n) => n + 1);
    addRef.current?.scrollIntoView({ block: 'start' });
  };
  const fresh = () => {
    setPrefill(undefined);
    setFormKey((n) => n + 1);
  };

  return (
    <section aria-label="Models" className="models-page">
      <h2>Models</h2>
      <p>
        <a href="/settings" onClick={followLink}>
          Back to Settings
        </a>
      </p>
      <h3>Local server</h3>
      {settings ? (
        <LocalServerForm
          settings={settings}
          onSaved={(s) => {
            setSettings(s);
            reload();
          }}
        />
      ) : null}
      <h3>Variants</h3>
      <p className="setup-hint">Each model + quant + settings combination is a variant. A failed smoke test leaves one disabled, with the reason.</p>
      {list ? <VariantTable list={list} onChanged={reload} onAnother={another} /> : null}
      <h3 ref={addRef}>{prefill ? 'Add another variant' : 'Add a model'}</h3>
      {prefill ? (
        <p>
          <button type="button" onClick={fresh}>
            Add a different model instead
          </button>
        </p>
      ) : null}
      <AddModel key={formKey} prefill={prefill} variants={list?.variants ?? []} modelsFolder={settings?.modelsFolder} onSaved={reload} />
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
