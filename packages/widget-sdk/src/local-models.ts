// Add a model (local-first Ticket 06): reading a GGUF file for its facts and recommended settings,
// listing a Hugging Face repo's GGUF files, and downloading one into the models folder.
import type { GgufFile } from './variants.ts';

/** POST /api/local-models/inspect (Admin): a GGUF file on the core's machine. */
export interface InspectModelRequest {
  /** The file's full path. */
  path: string;
  /** The KV cache type to size the context for. Default `f16` (llama-server's own default). */
  kvCacheType?: string;
}

/** The model's shape, from its GGUF metadata. */
export interface ModelShape {
  architecture: string;
  /** `general.name`, when the file has one. */
  name?: string;
  layerCount: number;
  kvHeadCount: number;
  keyLength: number;
  valueLength: number;
  trainingContext: number;
}

/** The figures a recommendation came from, in bytes. VRAM figures are null when unknown. */
export interface RecommendationFigures {
  weightsBytes: number;
  kvBytesPerToken: number;
  kvBytes: number;
  neededBytes: number;
  onGpuBytes: number;
  usedByOthersBytes: number | null;
  totalBytes: number | null;
  freeBytes: number | null;
  headroomBytes: number;
  layerCount: number;
  trainingContext: number;
}

/** The settings Kiln recommends, each with the one line that says why. */
export interface RecommendedSettings {
  contextSize: number;
  gpuLayers: number;
  kvCacheType: string;
  threads: number;
  /** True when some layers stay on the CPU. */
  offloaded: boolean;
  reasons: { contextSize: string; gpuLayers: string; kvCacheType: string; threads: string };
  figures: RecommendationFigures;
}

/** The GPU the recommendation was sized for. `source: null`: no GPU monitor reading, so no VRAM figures. */
export interface GpuReadingUsed {
  source: 'gpu-monitor' | null;
  /** e.g. "GPU 0: NVIDIA GeForce RTX 4090". */
  name?: string;
  memoryUsedMiB: number | null;
  memoryTotalMiB: number | null;
}

export interface ModelInspection {
  file: GgufFile & { sizeBytes: number };
  model: ModelShape;
  gpu: GpuReadingUsed;
  recommended: RecommendedSettings;
  /** A display name and server model id made from the file, for the form to start from. */
  suggestedName: string;
  suggestedServerModelId: string;
  /** The KV cache types llama-server takes. */
  kvCacheTypes: string[];
}

/** One GGUF file in a Hugging Face repo. */
export interface HuggingFaceFile {
  /** Its path in the repo, e.g. `Qwen3-8B-Q4_K_M.gguf` or `Q8_0/model-Q8_0.gguf`. */
  path: string;
  /** For a split GGUF, every part's size added up. */
  sizeBytes: number;
  quant?: string;
  /**
   * A split GGUF (`<name>-00001-of-0000N.gguf`): every part's path in the repo, in order. `path` is
   * part 1, which is what a download and a variant name; llama-server loads the rest beside it.
   */
  parts?: string[];
}

/** GET /api/local-models/huggingface?repo=owner/name (Admin): the repo's GGUF files on its main branch. */
export interface HuggingFaceFiles {
  repo: string;
  files: HuggingFaceFile[];
}

/** POST /api/local-models/downloads (Admin): download one file the person confirmed. */
export interface StartDownloadRequest {
  repo: string;
  /** The file's path in the repo, as `HuggingFaceFiles` lists it. */
  file: string;
}

/**
 * A download into the models folder. It writes `<file>.part` and renames it when complete; starting
 * the same file again after a failure resumes from the part file (an HTTP Range request). A
 * download that gets no bytes for a minute fails as stalled, and resumes the same way.
 */
export interface ModelDownload {
  id: string;
  repo: string;
  file: string;
  /** Where the finished file goes (part 1, for a split GGUF; the other parts go beside it). */
  path: string;
  /** A split GGUF: every part's path in the repo, in order. Bytes count across all of them. */
  parts?: string[];
  totalBytes: number;
  receivedBytes: number;
  state: 'running' | 'done' | 'failed';
  /** The byte it resumed from, when it picked up a part file. */
  resumedFromBytes?: number;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}
