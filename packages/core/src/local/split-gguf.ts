// Split GGUF files: a model too big for one file comes as `<name>-00001-of-0000N.gguf` and its
// siblings. Part 1 holds the header; llama-server, given part 1, loads the other parts from beside it.
import { stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const SPLIT = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i;

export interface SplitName {
  /** The name without the part number, e.g. `Qwen3-Q4_K_M` (with any folder before it). */
  stem: string;
  /** 1-based. */
  index: number;
  count: number;
}

/** The part a file name is, or undefined when it is not one of a split GGUF's parts. */
export function splitOf(name: string): SplitName | undefined {
  const match = SPLIT.exec(name);
  if (!match) return undefined;
  const index = Number(match[2]);
  const count = Number(match[3]);
  return index >= 1 && index <= count ? { stem: match[1]!, index, count } : undefined;
}

/** Part `index` of the split that `name` belongs to (same folder, same digit widths). */
export const partName = (split: SplitName, index: number) => `${split.stem}-${String(index).padStart(5, '0')}-of-${String(split.count).padStart(5, '0')}.gguf`;

/** A file name without its `.gguf` and, for a split's part, without the part number. */
export const modelBase = (path: string) => {
  const name = basename(path);
  return (splitOf(name)?.stem ?? name.replace(/\.gguf$/i, ''));
};

/**
 * The size of the model a file on disk starts: for part 1 of a split GGUF, every part added up when
 * all are beside it; otherwise the file's own size. Undefined when there is no such file.
 */
export async function modelBytes(path: string): Promise<number | undefined> {
  const size = (p: string) => stat(p).then((s) => (s.isFile() ? s.size : undefined), () => undefined);
  const own = await size(path);
  const split = splitOf(basename(path));
  if (own === undefined || !split || split.index !== 1) return own;
  let total = own;
  for (let i = 2; i <= split.count; i++) {
    const part = await size(join(dirname(path), partName(split, i)));
    if (part === undefined) return own;
    total += part;
  }
  return total;
}
