// Reads the GPUs through NVIDIA's vendor tool, nvidia-smi. Only `--query-*` calls are made: this
// Widget never changes GPU state (no unloading, no clocks, no killing processes).
import { execFile } from 'node:child_process';

export interface GpuProcess {
  pid: number;
  name: string;
  /** null when the driver doesn't report it (common on Windows under WDDM). */
  memoryUsedMiB: number | null;
}

export interface Gpu {
  index: number;
  name: string;
  utilizationPercent: number | null;
  memoryUsedMiB: number | null;
  memoryTotalMiB: number | null;
  processes: GpuProcess[];
}

export interface GpuReading {
  gpus: Gpu[];
}

/** Runs the vendor tool with these arguments and resolves with its stdout. The seam tests fake. */
export type RunTool = (args: string[]) => Promise<string>;

/** The tool gave no reading; the message says why, in words for the panel. */
export class ToolFailed extends Error {}

/**
 * The real tool: `command` (default `nvidia-smi`, a first element of "node" meaning this Node)
 * with the query arguments appended. Rejects with ToolFailed when it is missing or fails.
 */
export function nvidiaSmi(command: string[] = ['nvidia-smi']): RunTool {
  const [tool = 'nvidia-smi', ...toolArgs] = command;
  return (args) =>
    new Promise((done, fail) => {
      execFile(
        tool === 'node' ? process.execPath : tool,
        [...toolArgs, ...args],
        { timeout: 10_000, windowsHide: true, encoding: 'utf8' },
        (err, stdout, stderr) => {
          if (!err) return done(stdout);
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return fail(new ToolFailed('nvidia-smi was not found, so there is no NVIDIA GPU to show.'));
          }
          // nvidia-smi prints its own reason (no driver, no device) on stdout.
          const said = `${stdout}\n${stderr}`.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? err.message;
          fail(new ToolFailed(`nvidia-smi failed: ${said}`));
        },
      );
    });
}

const GPU_QUERY = ['--query-gpu=index,uuid,name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'];
const APPS_QUERY = ['--query-compute-apps=gpu_uuid,pid,process_name,used_memory', '--format=csv,noheader,nounits'];

const rows = (csv: string) =>
  csv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(',').map((cell) => cell.trim()));

/** A number, or null for nvidia-smi's "[N/A]", "[Not Supported]" and the like. */
const num = (cell: string | undefined): number | null => {
  if (cell === undefined || cell === '' || cell.startsWith('[')) return null;
  const value = Number(cell);
  return Number.isFinite(value) ? value : null;
};

export async function readNvidiaSmi(run: RunTool): Promise<GpuReading> {
  const gpuRows = rows(await run(GPU_QUERY));
  const appRows = rows(await run(APPS_QUERY));
  const gpus: Gpu[] = [];
  for (const [index, uuid, name, use, used, total] of gpuRows) {
    // A process name can hold commas, so it is everything between the pid and the last cell.
    const processes = appRows
      .filter((cells) => cells[0] === uuid)
      .map((cells): GpuProcess => ({
        pid: Number(cells[1]),
        name: cells.slice(2, -1).join(','),
        memoryUsedMiB: num(cells.at(-1)),
      }));
    gpus.push({
      index: Number(index),
      name: name ?? '',
      utilizationPercent: num(use),
      memoryUsedMiB: num(used),
      memoryTotalMiB: num(total),
      processes,
    });
  }
  return { gpus };
}
