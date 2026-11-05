// Add a model (local-first Ticket 06): what Settings → Models asks the core before it adds a variant.
//
// - inspect: reads a GGUF file's header (never the weights) and recommends settings from it, the
//   file's size and the GPU's VRAM as the GPU monitor Widget last reported it. With no GPU monitor
//   reading, the recommendation keeps every layer on the CPU and says so.
// - Hugging Face: lists a public repo's GGUF files through the public HTTP API (no token), and
//   downloads one the person confirmed into the models folder Setting. A download writes
//   `<file>.part` and renames it when complete; starting it again after a failure sends an HTTP
//   Range request for the rest.
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, stat, truncate } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type {
  GpuReadingUsed,
  HuggingFaceFile,
  HuggingFaceFiles,
  LocalServerSettings,
  ModelDownload,
  ModelInspection,
  PanelView,
  StartDownloadRequest,
} from '@kiln/widget-sdk';
import type { Clock } from '../clock.ts';
import { GgufError, KV_CACHE_BYTES_PER_ELEMENT, modelFacts, readGgufHeader, recommendSettings, type KvCacheType } from '../local-models/index.ts';
import { WorkError } from '../work/work.ts';
import { quantOf } from './llama-swap-config.ts';
import { slug } from './variants.ts';

/** The Widget whose panel says how much VRAM is free. */
export const GPU_MONITOR_WIDGET = 'gpu-monitor';
export const HUGGING_FACE_URL = 'https://huggingface.co';
const DEFAULT_KV_CACHE: KvCacheType = 'f16';
const GiB = 1024 ** 3;

export interface LocalModels {
  inspect(input: unknown): Promise<ModelInspection>;
  huggingFaceFiles(repo: unknown): Promise<HuggingFaceFiles>;
  startDownload(input: unknown): Promise<ModelDownload>;
  downloads(): ModelDownload[];
  download(id: string): ModelDownload;
}

export interface LocalModelsDeps {
  clock: Clock;
  /** The local server Setting (for the models folder). */
  settings(): LocalServerSettings;
  /** Every Widget panel now (the GPU monitor's among them, when it is installed and running). */
  panels(): PanelView[];
  /** Hugging Face's base URL. Default https://huggingface.co; tests point it at a fake. */
  huggingFaceUrl?: string;
  /** Logical CPUs. Default: this machine's. */
  cpuThreads?: number;
}

const bad = (message: string) => new WorkError(400, message);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const gb = (bytes: number) => `${Number((bytes / GiB).toFixed(1))} GB`;
const k = (tokens: number) => `${Number((tokens / 1024).toFixed(1))}K`;
const sizeOf = (path: string) => stat(path).then((s) => (s.isFile() ? s.size : undefined), () => undefined);

/**
 * The GPU with the most free VRAM, from the GPU monitor's panel: a card `gpu-<n>` per GPU whose
 * `gpu-<n>-vram` stat reads "<used> / <total>" in GB to one decimal. That rounding (under 0.05 GB)
 * is well inside the 1.5 GB headroom the recommendation keeps.
 */
export function gpuFromPanels(panels: PanelView[]): GpuReadingUsed {
  const none: GpuReadingUsed = { source: null, memoryUsedMiB: null, memoryTotalMiB: null };
  const panel = panels.find((p) => p.widgetId === GPU_MONITOR_WIDGET && p.content);
  let best: GpuReadingUsed | undefined;
  for (const card of panel?.content?.blocks ?? []) {
    if (card.kind !== 'card' || !card.id || !/^gpu-\d+$/.test(card.id)) continue;
    const vram = card.blocks?.find((b) => b.kind === 'stat' && b.id === `${card.id}-vram`);
    const match = vram && vram.kind === 'stat' ? /^\s*([\d.]+)\s*\/\s*([\d.]+)\s*$/.exec(String(vram.value)) : null;
    if (!match) continue;
    const reading: GpuReadingUsed = {
      source: 'gpu-monitor',
      name: card.title,
      memoryUsedMiB: Math.round(Number(match[1]) * 1024),
      memoryTotalMiB: Math.round(Number(match[2]) * 1024),
    };
    const free = (r: GpuReadingUsed) => r.memoryTotalMiB! - r.memoryUsedMiB!;
    if (!best || free(reading) > free(best)) best = reading;
  }
  return best ?? none;
}

/** The `next` URL of a paginated Hugging Face answer (its Link header). */
const nextLink = (link: string | null) => (link ? /<([^>]+)>;\s*rel="next"/.exec(link)?.[1] : undefined);

const REPO = /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/;

export function createLocalModels({ clock, settings, panels, huggingFaceUrl = HUGGING_FACE_URL, cpuThreads }: LocalModelsDeps): LocalModels {
  const hf = huggingFaceUrl.replace(/\/+$/, '');
  const now = () => clock.now().toISOString();
  const threadsHere = cpuThreads ?? availableParallelism();

  // ---- inspect ----
  const inspect = async (input: unknown): Promise<ModelInspection> => {
    if (!isObject(input) || typeof input.path !== 'string' || !input.path.trim()) throw bad('"path" must name a GGUF file');
    const path = input.path.trim();
    if (!isAbsolute(path)) throw bad(`"path" must be a full path: ${path}`);
    const kvCacheType = (input.kvCacheType ?? DEFAULT_KV_CACHE) as KvCacheType;
    if (typeof kvCacheType !== 'string' || !(kvCacheType in KV_CACHE_BYTES_PER_ELEMENT)) {
      throw bad(`"kvCacheType" must be one of ${Object.keys(KV_CACHE_BYTES_PER_ELEMENT).join(', ')}`);
    }
    if ((await sizeOf(path)) === undefined) throw bad(`There is no file at ${path}`);
    let header;
    let facts;
    try {
      header = await readGgufHeader(path);
      facts = modelFacts(header);
    } catch (err) {
      if (err instanceof GgufError) throw bad(err.message.startsWith(path) ? err.message : `${path}: ${err.message}`);
      throw err;
    }
    const gpu = gpuFromPanels(panels());
    const rec = recommendSettings({
      fileBytes: header.fileBytes,
      facts,
      kvCacheType,
      gpu: { memoryUsedMiB: gpu.memoryUsedMiB, memoryTotalMiB: gpu.memoryTotalMiB },
      cpuThreads: threadsHere,
    });
    const allLayers = facts.layerCount + 1;
    const gpuLayersReason =
      gpu.source === null
        ? 'no VRAM figures (the GPU monitor Widget is not installed, or has no reading), so every layer stays on the CPU'
        : rec.offloaded
          ? `${rec.gpuLayers} of ${allLayers} layers fit on the GPU; the rest run on the CPU`
          : `${allLayers} puts all ${facts.layerCount} layers and the output layer on the GPU`;
    const perToken = rec.numbers.kvBytesPerToken;
    const kvReason =
      `${kvCacheType} takes ${Number((perToken / 1024).toFixed(1))} KB of cache a token, ${gb(rec.numbers.kvBytes)} at ${k(rec.contextSize)}` +
      (kvCacheType === 'f16' ? "; it is llama-server's default, and q8_0 would take about half" : '');
    const name = header.metadata['general.name'];
    const quant = quantOf(path);
    const fileBase = basename(path).replace(/\.gguf$/i, '');
    return {
      file: { path, sizeBytes: header.fileBytes, ...(quant ? { quant } : {}) },
      model: {
        architecture: facts.architecture,
        ...(typeof name === 'string' && name.trim() ? { name: name.trim() } : {}),
        layerCount: facts.layerCount,
        kvHeadCount: facts.kvHeadCount,
        keyLength: facts.keyLength,
        valueLength: facts.valueLength,
        trainingContext: facts.trainingContext,
      },
      gpu,
      recommended: {
        contextSize: rec.contextSize,
        gpuLayers: rec.gpuLayers,
        kvCacheType: rec.kvCacheType,
        threads: rec.threads,
        offloaded: rec.offloaded,
        reasons: {
          contextSize: rec.reason,
          gpuLayers: gpuLayersReason,
          kvCacheType: kvReason,
          threads: `half of this machine's ${threadsHere} logical CPUs`,
        },
        figures: rec.numbers,
      },
      suggestedName: typeof name === 'string' && name.trim() ? `${name.trim()}${quant ? ` ${quant}` : ''}` : fileBase,
      suggestedServerModelId: slug(basename(path)),
      kvCacheTypes: Object.keys(KV_CACHE_BYTES_PER_ELEMENT),
    };
  };

  // ---- Hugging Face ----
  const reach = async (url: string, init?: RequestInit) => {
    try {
      return await fetch(url, init);
    } catch (err) {
      const cause = (err as Error & { cause?: Error }).cause;
      throw new WorkError(502, `Couldn't reach Hugging Face at ${hf}: ${cause?.message ?? (err as Error).message}`);
    }
  };
  const checkRepo = (repo: unknown): string => {
    if (typeof repo !== 'string' || !REPO.test(repo.trim())) throw bad('"repo" must be a Hugging Face repo as owner/name');
    return repo.trim();
  };
  const fileUrl = (repo: string, file: string) => `${hf}/${repo}/resolve/main/${file.split('/').map(encodeURIComponent).join('/')}`;

  const huggingFaceFiles = async (repoIn: unknown): Promise<HuggingFaceFiles> => {
    const repo = checkRepo(repoIn);
    const files: HuggingFaceFile[] = [];
    let url: string | undefined = `${hf}/api/models/${repo}/tree/main?recursive=true`;
    while (url) {
      const res = await reach(url);
      if (res.status === 401 || res.status === 403) throw new WorkError(404, `${repo} is private or gated on Hugging Face; Kiln downloads public repos only`);
      if (res.status === 404) throw new WorkError(404, `Hugging Face has no public repo ${repo}`);
      if (!res.ok) throw new WorkError(502, `Hugging Face answered ${res.status} for ${repo}`);
      const list = (await res.json()) as { type?: string; path?: string; size?: number; lfs?: { size?: number } }[];
      for (const entry of Array.isArray(list) ? list : []) {
        if (entry.type !== 'file' || typeof entry.path !== 'string' || !/\.gguf$/i.test(entry.path)) continue;
        const sizeBytes = entry.lfs?.size ?? entry.size;
        if (typeof sizeBytes !== 'number') continue;
        const quant = quantOf(entry.path);
        files.push({ path: entry.path, sizeBytes, ...(quant ? { quant } : {}) });
      }
      const next = nextLink(res.headers.get('link'));
      url = next ? new URL(next, hf).toString() : undefined;
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    return { repo, files };
  };

  const downloads = new Map<string, ModelDownload>();
  const copy = (d: ModelDownload): ModelDownload => ({ ...d });

  const run = async (d: ModelDownload) => {
    const part = `${d.path}.part`;
    try {
      await mkdir(dirname(d.path), { recursive: true });
      let have = (await sizeOf(part)) ?? 0;
      if (have > d.totalBytes) {
        await truncate(part, 0);
        have = 0;
      }
      if (have < d.totalBytes) {
        const res = await reach(fileUrl(d.repo, d.file), have > 0 ? { headers: { range: `bytes=${have}-` } } : undefined);
        let append = false;
        if (res.status === 206 && have > 0) {
          const start = /^bytes (\d+)-/.exec(res.headers.get('content-range') ?? '')?.[1];
          if (Number(start) !== have) throw new Error(`Hugging Face resumed at byte ${start ?? '?'}, not ${have}`);
          append = true;
          d.resumedFromBytes = have;
        } else if (res.status !== 200) {
          throw new Error(`Hugging Face answered ${res.status}`);
        }
        if (!res.body) throw new Error('Hugging Face sent no file');
        d.receivedBytes = append ? have : 0;
        const count = new Transform({
          transform(chunk: Buffer, _encoding, done) {
            d.receivedBytes += chunk.length;
            done(null, chunk);
          },
        });
        await pipeline(Readable.fromWeb(res.body as WebReadableStream<Uint8Array>), count, createWriteStream(part, { flags: append ? 'a' : 'w' }));
      }
      const size = (await sizeOf(part)) ?? 0;
      d.receivedBytes = size;
      if (size !== d.totalBytes) throw new Error(`the file came to ${size} bytes, not ${d.totalBytes}`);
      await rename(part, d.path);
      d.state = 'done';
    } catch (err) {
      const e = err as Error & { cause?: Error };
      const why = e.cause?.message ?? e.message;
      d.receivedBytes = (await sizeOf(part)) ?? d.receivedBytes;
      d.state = 'failed';
      d.error = `The download stopped at ${gb(d.receivedBytes)} of ${gb(d.totalBytes)} (${why}). Start it again to resume from there.`;
    }
    d.finishedAt = now();
  };

  const startDownload = async (input: unknown): Promise<ModelDownload> => {
    if (!isObject(input)) throw bad('Send the repo and file to download');
    const body = input as Partial<StartDownloadRequest>;
    const repo = checkRepo(body.repo);
    if (typeof body.file !== 'string' || !body.file || body.file.split('/').some((part) => part === '..' || part === '')) {
      throw bad('"file" must be a file path in the repo');
    }
    const folder = settings().modelsFolder;
    if (!folder) throw new WorkError(409, 'Set the models folder first (PUT /api/local-server with "modelsFolder")');
    const listed = (await huggingFaceFiles(repo)).files.find((f) => f.path === body.file);
    if (!listed) throw new WorkError(404, `${repo} has no GGUF file ${body.file}`);
    const path = join(folder, basename(listed.path));
    const running = [...downloads.values()].find((d) => d.path === path && d.state === 'running');
    if (running) return copy(running);
    const d: ModelDownload = {
      id: randomUUID(),
      repo,
      file: listed.path,
      path,
      totalBytes: listed.sizeBytes,
      receivedBytes: 0,
      state: 'running',
      startedAt: now(),
    };
    downloads.set(d.id, d);
    if ((await sizeOf(path)) === listed.sizeBytes) {
      // Already downloaded: nothing to fetch.
      Object.assign(d, { state: 'done', receivedBytes: listed.sizeBytes, finishedAt: now() });
    } else {
      void run(d);
    }
    return copy(d);
  };

  return {
    inspect,
    huggingFaceFiles,
    startDownload,
    downloads: () => [...downloads.values()].map(copy),
    download: (id) => {
      const d = downloads.get(id);
      if (!d) throw new WorkError(404, `No download has the id ${id}`);
      return copy(d);
    },
  };
}
