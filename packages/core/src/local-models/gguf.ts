// Reads a GGUF model file's header: the magic, the version, the tensor count and the metadata
// key-value pairs. It reads the file in small chunks and stops where the tensor infos begin, so a
// 20 GB model costs a few kilobytes to megabytes of reading (the tokenizer's vocabulary is the
// largest part of most headers), never the weights.
//
// Layout (GGUF v2 and v3, little-endian; v1 used 32-bit counts and is refused):
//   magic "GGUF" | u32 version | u64 tensor count | u64 metadata count | metadata pairs ...
//   a pair is: string key | u32 value type | value
//   a string is: u64 byte length | UTF-8 bytes
//   an array is: u32 item type | u64 item count | items
import { open, type FileHandle } from 'node:fs/promises';

export type GgufValue = number | bigint | boolean | string | GgufValue[] | GgufArraySummary;

/** A long array (the tokenizer's vocabulary, its scores) is skipped and kept only as its size. */
export interface GgufArraySummary {
  itemType: string;
  length: number;
}

export interface GgufHeader {
  version: number;
  tensorCount: number;
  /** Integers that fit a JS number are numbers; larger 64-bit ones stay bigint. */
  metadata: Record<string, GgufValue>;
  /** Where the metadata ends and the tensor infos begin. */
  headerBytes: number;
  /** The whole file's size, which is close to the weights' size. */
  fileBytes: number;
}

export class GgufError extends Error {}

/** Arrays longer than this are skipped, not stored. Per-layer arrays are far shorter. */
const MAX_STORED_ARRAY = 1024;
const CHUNK = 64 * 1024;

const TYPE_NAMES = ['u8', 'i8', 'u16', 'i16', 'u32', 'i32', 'f32', 'bool', 'string', 'array', 'u64', 'i64', 'f64'];

/** Reads a GGUF file's header without its tensor data. Rejects with GgufError when it isn't one. */
export async function readGgufHeader(path: string): Promise<GgufHeader> {
  const file = await open(path, 'r');
  try {
    const fileBytes = (await file.stat()).size;
    const r = new ChunkReader(file, fileBytes, path);
    const magic = (await r.bytes(4)).toString('latin1');
    if (magic !== 'GGUF') throw new GgufError(`${path} is not a GGUF file (it starts with "${printable(magic)}")`);
    const version = (await r.bytes(4)).readUInt32LE();
    if (version < 2 || version > 3) throw new GgufError(`${path} is GGUF version ${version}; Kiln reads versions 2 and 3`);
    const tensorCount = toNumber((await r.bytes(8)).readBigUInt64LE());
    const count = toNumber((await r.bytes(8)).readBigUInt64LE());
    const metadata: Record<string, GgufValue> = {};
    for (let i = 0; i < count; i++) {
      const key = await readString(r);
      const type = (await r.bytes(4)).readUInt32LE();
      metadata[key] = await readValue(r, type, key);
    }
    return { version, tensorCount: Number(tensorCount), metadata, headerBytes: r.offset, fileBytes };
  } finally {
    await file.close();
  }
}

/** Sequential reads over a file handle, a chunk at a time. */
class ChunkReader {
  offset = 0;
  private buffer = Buffer.alloc(0);
  private bufferStart = 0;
  private readonly file: FileHandle;
  private readonly size: number;
  private readonly path: string;

  constructor(file: FileHandle, size: number, path: string) {
    this.file = file;
    this.size = size;
    this.path = path;
  }

  async bytes(n: number): Promise<Buffer> {
    if (this.offset + n > this.size) throw new GgufError(`${this.path} ends inside its header (at byte ${this.size})`);
    const end = this.offset + n;
    if (end > this.bufferStart + this.buffer.length) {
      const length = Math.max(n, CHUNK);
      const fresh = Buffer.alloc(length);
      const { bytesRead } = await this.file.read(fresh, 0, length, this.offset);
      this.buffer = fresh.subarray(0, bytesRead);
      this.bufferStart = this.offset;
    }
    const from = this.offset - this.bufferStart;
    this.offset = end;
    return this.buffer.subarray(from, from + n);
  }
}

const printable = (s: string) => s.replace(/[^\x20-\x7e]/g, '?');

const toNumber = (n: bigint): number | bigint => (n <= BigInt(Number.MAX_SAFE_INTEGER) && n >= -BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n);

async function readString(r: ChunkReader): Promise<string> {
  const length = Number((await r.bytes(8)).readBigUInt64LE());
  return (await r.bytes(length)).toString('utf8');
}

async function readValue(r: ChunkReader, type: number, key: string): Promise<GgufValue> {
  switch (type) {
    case 0: return (await r.bytes(1)).readUInt8();
    case 1: return (await r.bytes(1)).readInt8();
    case 2: return (await r.bytes(2)).readUInt16LE();
    case 3: return (await r.bytes(2)).readInt16LE();
    case 4: return (await r.bytes(4)).readUInt32LE();
    case 5: return (await r.bytes(4)).readInt32LE();
    case 6: return (await r.bytes(4)).readFloatLE();
    case 7: return (await r.bytes(1)).readUInt8() !== 0;
    case 8: return readString(r);
    case 9: {
      const itemType = (await r.bytes(4)).readUInt32LE();
      const length = Number((await r.bytes(8)).readBigUInt64LE());
      const items: GgufValue[] = [];
      const keep = length <= MAX_STORED_ARRAY;
      for (let i = 0; i < length; i++) {
        const item = await readValue(r, itemType, key);
        if (keep) items.push(item);
      }
      return keep ? items : { itemType: TYPE_NAMES[itemType] ?? String(itemType), length };
    }
    case 10: return toNumber((await r.bytes(8)).readBigUInt64LE());
    case 11: return toNumber((await r.bytes(8)).readBigInt64LE());
    case 12: return (await r.bytes(8)).readDoubleLE();
    default: throw new GgufError(`unknown GGUF value type ${type} for "${key}"`);
  }
}
