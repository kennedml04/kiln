// Add a model (local-first Ticket 06): what Settings → Models asks the core before it adds a variant.
//
// - inspect: reads a GGUF file's header (never the weights) and recommends settings from it, the
//   file's size and the GPU's VRAM as the GPU monitor Widget last reported it (the numbers in its
//   panel's card data). With no GPU monitor reading, the recommendation keeps every layer on the
//   CPU and says so. For part 1 of a split GGUF, the size is every part's.
// - Hugging Face: lists a public repo's GGUF files through the public HTTP API (no token), a split
//   GGUF as one model, and downloads one the person confirmed (every part of a split) into the
//   models folder Setting. A download writes `<file>.part` and renames it when complete; one that
//   gets no bytes for the stall timeout fails as stalled; starting it again after a failure sends
//   an HTTP Range request for the rest.
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
import { modelBase, modelBytes, partName, splitOf } from './split-gguf.ts';
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
  /** How long a download may get no bytes before it fails as stalled. Default 60 seconds. */
  stallMs?: number;
}

export const DOWNLOAD_STALL_MS = 60_000;

/** Thrown into a download that got no bytes for the stall timeout. */
class Stalled extends Error {}

const bad = (message: string) => new WorkError(400, message);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const gb = (bytes: number) => `${Number((bytes / GiB).toFixed(1))} GB`;
const k = (tokens: number) => `${Number((tokens / 1024).toFixed(1))}K`;
const sizeOf = (path: string) => stat(path).then((s) => (s.isFile() ? s.size : undefined), () => undefined);

/**
 * The GPU with the most free VRAM, from the GPU monitor's panel: a card `gpu-<n>` per GPU whose
 * `data` gives `memoryUsedMiB` and `memoryTotalMiB` as numbers. The card's display text is never
 * read, so its wording can change freely.
 */
export function gpuFromPanels(panels: PanelView[]): GpuReadingUsed {
  const none: GpuReadingUsed = { source: null, memoryUsedMiB: null, memoryTotalMiB: null };
  const panel = panels.find((p) => p.widgetId === GPU_MONITOR_WIDGET && p.content);
  const mib = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
  let best: GpuReadingUsed | undefined;
  for (const card of panel?.content?.blocks ?? []) {
    if (card.kind !== 'card' || !card.id || !/^gpu-\d+$/.test(card.id)) continue;
    const used = mib(card.data?.memoryUsedMiB);
    const total = mib(card.data?.memoryTotalMiB);
    if (used === undefined || !total) continue;
    const reading: GpuReadingUsed = { source: 'gpu-monitor', name: card.title, memoryUsedMiB: used, memoryTotalMiB: total };
    const free = (r: GpuReadingUsed) => r.memoryTotalMiB! - r.memoryUsedMiB!;
    if (!best || free(reading) > free(best)) best = reading;
  }
  return best ?? none;
}

/** The `next` URL of a paginated Hugging Face answer (its Link header). */
const nextLink = (link: string | null) => (link ? /<([^>]+)>;\s*rel="next"/.exec(link)?.[1] : undefined);

const REPO = /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/;

export function createLocalModels({
  clock,
  settings,
  panels,
  huggingFaceUrl = HUGGING_FACE_URL,
  cpuThreads,
  stallMs = DOWNLOAD_STALL_MS,
}: LocalModelsDeps): LocalModels {
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
    const fileBytes = (await modelBytes(path)) ?? header.fileBytes;
    const rec = recommendSettings({
      fileBytes,
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
    const fileBase = modelBase(path);
    return {
      file: { path, sizeBytes: fileBytes, ...(quant ? { quant } : {}) },
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
      suggestedServerModelId: slug(fileBase),
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

  /** Every GGUF file in the repo as the tree lists it, by path, with its size. */
  const repoFiles = async (repo: string): Promise<Map<string, number>> => {
    const sizes = new Map<string, number>();
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
        sizes.set(entry.path, sizeBytes);
      }
      const next = nextLink(res.headers.get('link'));
      url = next ? new URL(next, hf).toString() : undefined;
    }
    return sizes;
  };

  /** The repo's models: each plain GGUF file, and each complete split GGUF as one entry on part 1. */
  const modelsIn = (sizes: Map<string, number>): HuggingFaceFile[] => {
    const files: HuggingFaceFile[] = [];
    for (const [path, sizeBytes] of sizes) {
      const quant = quantOf(path);
      const split = splitOf(path);
      if (!split) {
        files.push({ path, sizeBytes, ...(quant ? { quant } : {}) });
        continue;
      }
      // A split is listed once, from part 1, and only when every part is there to download.
      if (split.index !== 1) continue;
      const parts = Array.from({ length: split.count }, (_, i) => partName(split, i + 1));
      if (!parts.every((p) => sizes.has(p))) continue;
      const total = parts.reduce((n, p) => n + sizes.get(p)!, 0);
      files.push({ path, sizeBytes: total, ...(quant ? { quant } : {}), ...(split.count > 1 ? { parts } : {}) });
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
  };

  const huggingFaceFiles = async (repoIn: unknown): Promise<HuggingFaceFiles> => {
    const repo = checkRepo(repoIn);
    return { repo, files: modelsIn(await repoFiles(repo)) };
  };

  const downloads = new Map<string, ModelDownload>();
  const copy = (d: ModelDownload): ModelDownload => ({ ...d });

  interface Part {
    /** Its path in the repo. */
    file: string;
    /** Where it goes. */
    path: string;
    sizeBytes: number;
  }

  /**
   * Fetches one part into `<path>.part`, resuming from what is there, and renames it when complete.
   * `before` is the bytes of the parts already done, so progress counts across all of them.
   */
  const fetchPart = async (d: ModelDownload, p: Part, before: number) => {
    const part = `${p.path}.part`;
    let have = (await sizeOf(part)) ?? 0;
    if (have > p.sizeBytes) {
      await truncate(part, 0);
      have = 0;
    }
    if (have < p.sizeBytes) {
      // No bytes for the stall timeout, from the request on: give up, keeping the part file.
      const abort = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => abort.abort(new Stalled()), stallMs);
      };
      arm();
      try {
        const res = await reach(fileUrl(d.repo, p.file), { signal: abort.signal, ...(have > 0 ? { headers: { range: `bytes=${have}-` } } : {}) });
        let append = false;
        if (res.status === 206 && have > 0) {
          const start = /^bytes (\d+)-/.exec(res.headers.get('content-range') ?? '')?.[1];
          if (Number(start) !== have) throw new Error(`Hugging Face resumed at byte ${start ?? '?'}, not ${have}`);
          append = true;
          d.resumedFromBytes = before + have;
        } else if (res.status !== 200) {
          throw new Error(`Hugging Face answered ${res.status}`);
        }
        if (!res.body) throw new Error('Hugging Face sent no file');
        d.receivedBytes = before + (append ? have : 0);
        const count = new Transform({
          transform(chunk: Buffer, _encoding, done) {
            arm();
            d.receivedBytes += chunk.length;
            done(null, chunk);
          },
        });
        await pipeline(Readable.fromWeb(res.body as WebReadableStream<Uint8Array>), count, createWriteStream(part, { flags: append ? 'a' : 'w' }), {
          signal: abort.signal,
        });
      } catch (err) {
        throw abort.signal.aborted ? abort.signal.reason : err;
      } finally {
        clearTimeout(timer);
      }
    }
    const size = (await sizeOf(part)) ?? 0;
    if (size !== p.sizeBytes) throw new Error(`${basename(p.path)} came to ${size} bytes, not ${p.sizeBytes}`);
    await rename(part, p.path);
  };

  const run = async (d: ModelDownload, parts: Part[]) => {
    let before = 0;
    let current: Part | undefined;
    try {
      await mkdir(dirname(d.path), { recursive: true });
      for (const p of parts) {
        current = p;
        // A part a try before finished is not fetched again.
        if ((await sizeOf(p.path)) !== p.sizeBytes) await fetchPart(d, p, before);
        before += p.sizeBytes;
        d.receivedBytes = before;
      }
      d.state = 'done';
    } catch (err) {
      const e = err as Error & { cause?: Error };
      d.receivedBytes = before + ((current && (await sizeOf(`${current.path}.part`))) ?? 0);
      const at = `${gb(d.receivedBytes)} of ${gb(d.totalBytes)}`;
      d.state = 'failed';
      d.error =
        err instanceof Stalled
          ? `The download stalled: no data for ${Number((stallMs / 1000).toFixed(1))} seconds, at ${at}. Start it again to resume from there.`
          : `The download stopped at ${at} (${e.cause?.message ?? e.message}). Start it again to resume from there.`;
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
    const sizes = await repoFiles(repo);
    const listed = modelsIn(sizes).find((f) => f.path === body.file);
    if (!listed) throw new WorkError(404, `${repo} has no GGUF file ${body.file}`);
    const path = join(folder, basename(listed.path));
    const running = [...downloads.values()].find((d) => d.path === path && d.state === 'running');
    if (running) return copy(running);
    // Every part goes in the models folder under its base name, beside part 1.
    const parts: Part[] = (listed.parts ?? [listed.path]).map((file) => ({ file, path: join(folder, basename(file)), sizeBytes: sizes.get(file)! }));
    const d: ModelDownload = {
      id: randomUUID(),
      repo,
      file: listed.path,
      path,
      ...(listed.parts ? { parts: listed.parts } : {}),
      totalBytes: listed.sizeBytes,
      receivedBytes: 0,
      state: 'running',
      startedAt: now(),
    };
    downloads.set(d.id, d);
    const have = await Promise.all(parts.map((p) => sizeOf(p.path)));
    if (parts.every((p, i) => have[i] === p.sizeBytes)) {
      // Already downloaded: nothing to fetch.
      Object.assign(d, { state: 'done', receivedBytes: listed.sizeBytes, finishedAt: now() });
    } else {
      void run(d, parts);
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
