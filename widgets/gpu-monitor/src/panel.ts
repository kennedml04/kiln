// What the GPU monitor shows: one card per GPU with its use, its VRAM and the processes holding it.
// Display only: the panel never has buttons, because this Widget takes no actions on the GPU.
import type { CardBlock, PanelContent } from '@kiln/widget-sdk';
import type { Gpu, GpuReading } from './nvidia-smi.ts';

const gb = (mib: number | null) => (mib === null ? 'n/a' : (mib / 1024).toFixed(1));

function gpuCard(gpu: Gpu): CardBlock {
  const id = `gpu-${gpu.index}`;
  return {
    kind: 'card',
    id,
    title: `GPU ${gpu.index}: ${gpu.name}`,
    // The VRAM reading as numbers, for Add a model's recommendation: the VRAM stat is display text only.
    data: { memoryUsedMiB: gpu.memoryUsedMiB, memoryTotalMiB: gpu.memoryTotalMiB },
    blocks: [
      gpu.utilizationPercent === null
        ? { kind: 'stat', id: `${id}-use`, label: 'Use', value: 'n/a' }
        : { kind: 'stat', id: `${id}-use`, label: 'Use', value: gpu.utilizationPercent, unit: '%' },
      { kind: 'stat', id: `${id}-vram`, label: 'VRAM', value: `${gb(gpu.memoryUsedMiB)} / ${gb(gpu.memoryTotalMiB)}`, unit: 'GB' },
      {
        kind: 'table',
        id: `${id}-processes`,
        title: 'Holding it',
        columns: ['PID', 'Process', 'VRAM'],
        rows: gpu.processes.map((p) => [p.pid, p.name, p.memoryUsedMiB === null ? 'n/a' : `${gb(p.memoryUsedMiB)} GB`]),
      },
    ],
  };
}

export function gpuPanel(reading: GpuReading): PanelContent {
  return { blocks: reading.gpus.map(gpuCard) };
}

/** Shown instead of the GPUs when there is no reading, saying why. */
export function unavailablePanel(why: string): PanelContent {
  return { blocks: [{ kind: 'card', id: 'unavailable', title: 'No GPU reading', text: why }] };
}
