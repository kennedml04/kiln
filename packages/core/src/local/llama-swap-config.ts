// Reading and editing llama-swap's YAML config without disturbing what a person wrote there.
//
// An edit is a splice of the source text: only the lines of the one entry Kiln writes (or removes)
// change, so every other entry, comment, blank line and quoting style stays byte for byte. The
// `yaml` library is used to find where things are (node ranges), and to check the result: after
// every splice the file is parsed again and every other entry must read exactly as before. When a
// file's shape defeats the splice (a flow-style `models: {...}`), the edit goes through yaml's
// Document API instead, which keeps comments but may respace the file; that result is checked too.
import { isMap, isScalar, isSeq, parseDocument, Scalar, type Document, type Pair, type YAMLMap, type YAMLSeq } from 'yaml';
import { isDeepStrictEqual } from 'node:util';
import type { VariantSettings } from '@kiln/widget-sdk';

export class ConfigError extends Error {}

/** One `models:` entry as written: its key and its `cmd`, when it has one. */
export interface ConfigEntry {
  modelId: string;
  cmd?: string;
}

type Range = [number, number, number];

const parse = (text: string): Document => {
  const doc = parseDocument(text);
  if (doc.errors.length) throw new ConfigError(`The llama-swap config isn't valid YAML: ${doc.errors[0]!.message}`);
  return doc;
};

const modelsPair = (doc: Document): Pair | undefined => {
  const root = doc.contents;
  if (!isMap(root)) return undefined;
  return root.items.find((p) => isScalar(p.key) && p.key.value === 'models') as Pair | undefined;
};

const keyOf = (pair: Pair): string | undefined => (isScalar(pair.key) ? String(pair.key.value) : undefined);

/** Every entry under `models:`, in file order. */
export function readEntries(text: string): ConfigEntry[] {
  const doc = parse(text);
  const models = modelsPair(doc)?.value;
  if (!isMap(models)) return [];
  return models.items.flatMap((pair) => {
    const modelId = keyOf(pair as Pair);
    if (modelId === undefined) return [];
    const entry = (pair as Pair).value;
    const cmd = isMap(entry) ? entry.get('cmd') : undefined;
    return [{ modelId, ...(typeof cmd === 'string' ? { cmd: cmd.trim() } : {}) }];
  });
}

const lineStart = (text: string, at: number) => text.lastIndexOf('\n', at - 1) + 1;
/** The start of the line after the one `at` is on (or `at` itself, when it already starts a line). */
const nextLine = (text: string, at: number) => {
  if (at > 0 && text[at - 1] === '\n') return at;
  const n = text.indexOf('\n', at);
  return n === -1 ? text.length : n + 1;
};
/** Moves `end` back over blank lines, so the blank lines between entries are never part of one. */
const trimBlankLines = (text: string, start: number, end: number) => {
  let e = end;
  for (;;) {
    const prev = text.lastIndexOf('\n', e - 2);
    if (prev < start - 1 || e <= start) return e;
    if (text.slice(prev + 1, e).trim() !== '') return e;
    e = prev + 1;
  }
};
const splice = (text: string, start: number, end: number, insert: string, eol: string) => {
  const before = text.slice(0, start);
  const lead = start > 0 && !before.endsWith('\n') ? eol : '';
  return before + lead + insert + text.slice(end);
};

/** A key as llama-swap reads it: bare when that's unambiguous, JSON-quoted otherwise. */
const keyText = (id: string) => (/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(id) ? id : JSON.stringify(id));

const cmdLines = (indent: number, step: number, cmd: string, eol: string) =>
  `${' '.repeat(indent)}cmd: |${eol}${' '.repeat(indent + step)}${cmd}${eol}`;

const entryLines = (indent: number, step: number, id: string, cmd: string, eol: string) =>
  `${' '.repeat(indent)}${keyText(id)}:${eol}${cmdLines(indent + step, step, cmd, eol)}`;

const column = (text: string, at: number) => at - lineStart(text, at);

/** The config as plain data, with one model entry left out (or with its `cmd` left out). */
const without = (text: string, modelId: string, part: 'entry' | 'cmd') => {
  const data = (parse(text).toJS() ?? {}) as Record<string, unknown>;
  const models = { ...((data.models ?? {}) as Record<string, unknown>) };
  if (part === 'entry' || typeof models[modelId] !== 'object' || models[modelId] === null) delete models[modelId];
  else {
    const { cmd: _cmd, ...rest } = models[modelId] as Record<string, unknown>;
    models[modelId] = rest;
  }
  return { ...data, models };
};

/** Throws unless `after` is `before` with only `modelId`'s cmd set to `cmd` (or its entry gone, for null). */
function check(before: string, after: string, modelId: string, cmd: string | null, kept: 'entry' | 'cmd') {
  const entry = readEntries(after).find((e) => e.modelId === modelId);
  if (cmd === null ? entry !== undefined : entry?.cmd !== cmd.trim()) return false;
  return isDeepStrictEqual(without(before, modelId, kept), without(after, modelId, kept));
}

/** Writes `cmd` as the `cmd` of the entry `modelId`, adding the entry when there is none. Other keys of the entry stay. */
export function setEntryCmd(text: string, modelId: string, cmd: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const doc = parse(text);
  const pair = modelsPair(doc);
  const models = pair?.value;
  const existing = isMap(models) ? (models.items.find((p) => keyOf(p as Pair) === modelId) as Pair | undefined) : undefined;
  const kept = existing && isMap(existing.value) ? 'cmd' : 'entry';
  let spliced: string | undefined;
  if (!pair) {
    spliced = splice(text, text.length, text.length, `models:${eol}${entryLines(2, 2, modelId, cmd, eol)}`, eol);
  } else if (isMap(models) && !models.flow && models.items.length > 0) {
    const first = models.items[0] as Pair;
    const indent = column(text, (first.key as Scalar).range![0]);
    const step = indent > 0 ? indent : 2;
    if (existing) {
      const value = existing.value;
      const cmdPair = isMap(value) && !value.flow ? (value.items.find((p) => keyOf(p as Pair) === 'cmd') as Pair | undefined) : undefined;
      if (cmdPair && (cmdPair.value as Scalar | null)?.range) {
        const keyAt = (cmdPair.key as Scalar).range![0];
        const start = lineStart(text, keyAt);
        const end = trimBlankLines(text, start, nextLine(text, ((cmdPair.value as Scalar).range as Range)[1]));
        spliced = splice(text, start, end, cmdLines(column(text, keyAt), step, cmd, eol), eol);
      } else if (!(isMap(value) && value.flow) && (value as Scalar | null)?.range) {
        // An entry with no cmd (or not a map): it becomes Kiln's entry whole.
        const start = lineStart(text, (existing.key as Scalar).range![0]);
        const end = trimBlankLines(text, start, nextLine(text, ((value as Scalar).range as Range)[1]));
        spliced = splice(text, start, end, entryLines(indent, step, modelId, cmd, eol), eol);
      }
    } else {
      const last = models.items.at(-1) as Pair;
      const lastEnd = ((last.value as Scalar | null)?.range ?? (last.key as Scalar).range!) as Range;
      const start = lineStart(text, (last.key as Scalar).range![0]);
      const at = trimBlankLines(text, start, nextLine(text, lastEnd[1]));
      spliced = splice(text, at, at, entryLines(indent, step, modelId, cmd, eol), eol);
    }
  } else if (models === null || (isScalar(models) && models.value === null)) {
    const at = nextLine(text, (pair.key as Scalar).range![1]);
    spliced = splice(text, at, at, entryLines(2, 2, modelId, cmd, eol), eol);
  }
  if (spliced !== undefined && check(text, spliced, modelId, cmd, kept)) return spliced;
  // The Document API: comments survive, spacing may not.
  const block = new Scalar(`${cmd}\n`);
  block.type = Scalar.BLOCK_LITERAL;
  if (existing && isMap(existing.value)) (existing.value as YAMLMap).set('cmd', block);
  else doc.setIn(['models', modelId], doc.createNode({ cmd: block }));
  const rewritten = doc.toString({ lineWidth: 0 });
  if (check(text, rewritten, modelId, cmd, kept)) return rewritten;
  throw new ConfigError(`Kiln couldn't write the entry "${modelId}" without changing other entries; edit the config by hand`);
}

/** The lists in llama-swap's config that name model ids: a removed model is taken out of them too. */
const MODEL_LISTS = (doc: Document): YAMLSeq[] => {
  const lists: YAMLSeq[] = [];
  const groups = doc.get('groups', true);
  if (isMap(groups)) {
    for (const group of groups.items) {
      const members = isMap(group.value) ? group.value.get('members', true) : undefined;
      if (isSeq(members)) lists.push(members);
    }
  }
  const preload = doc.getIn(['hooks', 'on_startup', 'preload'], true);
  if (isSeq(preload)) lists.push(preload);
  return lists;
};

/** Takes `modelId` out of the group and preload lists that name it (a splice, like the entry edits). */
function dropFromLists(text: string, modelId: string): string {
  for (;;) {
    const doc = parse(text);
    const hit = MODEL_LISTS(doc)
      .map((seq) => ({ seq, index: seq.items.findIndex((i) => isScalar(i) && String(i.value) === modelId) }))
      .find((h) => h.index !== -1);
    if (!hit) return text;
    const { seq, index } = hit;
    const range = seq.range as Range;
    if (seq.flow) {
      const rest = seq.items.filter((_, i) => i !== index).map((i) => text.slice(...((i as Scalar).range as Range).slice(0, 2)));
      text = text.slice(0, range[0]) + `[${rest.join(', ')}]` + text.slice(range[1]);
    } else {
      const item = seq.items[index] as Scalar;
      const start = lineStart(text, item.range![0]);
      text = text.slice(0, start) + text.slice(nextLine(text, item.range![1]));
    }
  }
}

/** Removes the entry `modelId` (and its mentions in groups and preload). A missing entry is no change. */
export function removeEntry(text: string, modelId: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const doc = parse(text);
  const models = modelsPair(doc)?.value;
  if (!isMap(models)) return text;
  const pair = models.items.find((p) => keyOf(p as Pair) === modelId) as Pair | undefined;
  if (!pair) return dropFromLists(text, modelId);
  let result: string | undefined;
  const value = pair.value as Scalar | null;
  if (!models.flow && value?.range) {
    const start = lineStart(text, (pair.key as Scalar).range![0]);
    const end = trimBlankLines(text, start, nextLine(text, (value.range as Range)[1]));
    const spliced = splice(text, start, end, '', eol);
    if (check(text, spliced, modelId, null, 'entry')) result = spliced;
  }
  if (result === undefined) {
    models.delete(modelId);
    const rewritten = doc.toString({ lineWidth: 0 });
    if (!check(text, rewritten, modelId, null, 'entry')) throw new ConfigError(`Kiln couldn't remove the entry "${modelId}"; edit the config by hand`);
    result = rewritten;
  }
  return dropFromLists(result, modelId);
}

// ---- llama-server command lines ----------------------------------------------------------------

const quote = (arg: string) => (/[\s"']/.test(arg) || arg === '' ? `"${arg}"` : arg);

/**
 * The command an entry Kiln writes runs. Paths use forward slashes (llama-swap splits the command
 * like a shell, where a backslash escapes; Windows takes either slash).
 */
export function buildCommand(serverCommand: string, modelPath: string, settings: VariantSettings): string {
  const args = [quote(serverCommand), '--port', '${PORT}', '-m', quote(modelPath.replace(/\\/g, '/'))];
  if (settings.contextSize !== undefined) args.push('-c', String(settings.contextSize));
  if (settings.gpuLayers !== undefined) args.push('-ngl', String(settings.gpuLayers));
  if (settings.kvCacheType !== undefined) args.push('--cache-type-k', settings.kvCacheType, '--cache-type-v', settings.kvCacheType);
  if (settings.threads !== undefined) args.push('-t', String(settings.threads));
  args.push(...settings.extraFlags.map(quote));
  return args.join(' ');
}

/** Splits a command line like a shell would, without backslash escapes (Windows paths). */
function words(cmd: string): string[] {
  const text = cmd.replace(/\\\r?\n/g, ' ');
  const out: string[] = [];
  let word: string | undefined;
  let q: string | undefined;
  for (const ch of text) {
    if (q) {
      if (ch === q) q = undefined;
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      word ??= '';
    } else if (/\s/.test(ch)) {
      if (word !== undefined) out.push(word);
      word = undefined;
    } else word = (word ?? '') + ch;
  }
  if (word !== undefined) out.push(word);
  return out;
}

const FLAGS: Record<string, 'model' | 'ctx' | 'ngl' | 'ctk' | 'ctv' | 'threads' | 'port'> = {
  '-m': 'model', '--model': 'model',
  '-c': 'ctx', '--ctx-size': 'ctx',
  '-ngl': 'ngl', '--n-gpu-layers': 'ngl', '--gpu-layers': 'ngl',
  '-ctk': 'ctk', '--cache-type-k': 'ctk',
  '-ctv': 'ctv', '--cache-type-v': 'ctv',
  '-t': 'threads', '--threads': 'threads',
  '--port': 'port',
};

export interface ParsedCommand {
  serverCommand?: string;
  modelPath?: string;
  settings: VariantSettings;
}

/** Reads a hand-written entry's command line back into a variant's file and settings, as far as it can. */
export function parseCommand(cmd: string): ParsedCommand {
  const [serverCommand, ...args] = words(cmd);
  const settings: VariantSettings = { extraFlags: [] };
  let modelPath: string | undefined;
  let valueK: string | undefined;
  let valueV: string | undefined;
  for (let i = 0; i < args.length; i++) {
    let arg = args[i]!;
    let value: string | undefined;
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    if (eq !== -1) [arg, value] = [arg.slice(0, eq), arg.slice(eq + 1)];
    const flag = FLAGS[arg];
    if (!flag) {
      settings.extraFlags.push(args[i]!);
      continue;
    }
    if (value === undefined) value = args[++i];
    if (value === undefined) break;
    const n = Number(value);
    if (flag === 'model') modelPath = value;
    else if (flag === 'ctk') valueK = value;
    else if (flag === 'ctv') valueV = value;
    else if (flag === 'ctx' && Number.isInteger(n)) settings.contextSize = n;
    else if (flag === 'ngl' && Number.isInteger(n)) settings.gpuLayers = n;
    else if (flag === 'threads' && Number.isInteger(n)) settings.threads = n;
    else if (flag !== 'port') settings.extraFlags.push(arg, value);
  }
  // One KV cache type for both; a different value type stays an extra flag.
  if (valueK !== undefined) settings.kvCacheType = valueK;
  if (valueV !== undefined && valueV !== valueK) {
    if (valueK === undefined) settings.kvCacheType = valueV;
    else settings.extraFlags.push('--cache-type-v', valueV);
  }
  return { ...(serverCommand ? { serverCommand } : {}), ...(modelPath ? { modelPath } : {}), settings };
}

/** The quant in a GGUF file name, e.g. `Q4_K_M`, `IQ4_XS`, `UD-Q5_K_XL`, `BF16`. */
export function quantOf(fileName: string): string | undefined {
  const base = fileName.replace(/\\/g, '/').split('/').pop()!.replace(/\.gguf$/i, '');
  const match = /(?:^|[-_.])((?:UD-)?(?:I?Q\d+(?:_[A-Z0-9]+)*|BF16|F16|F32))(?:$|[-_.])/i.exec(base);
  return match?.[1]?.toUpperCase();
}
