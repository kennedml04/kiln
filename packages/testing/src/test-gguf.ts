// A tiny GGUF file (v3, little-endian) for tests: a llama-shaped header and filler bytes standing in
// for the weights. Enough for Kiln to read the metadata and recommend settings; no model runs it.

export interface TestGgufOptions {
  /** `general.name`. Default "Tiny Test". */
  name?: string;
  /** `llama.block_count`. Default 32. */
  layers?: number;
  /** `llama.context_length`. Default 131072. */
  contextLength?: number;
  /** `llama.attention.head_count_kv`. Default 8 (with 32 heads of 128). */
  kvHeads?: number;
  /** Filler after the header. Default 64 KB. */
  weightBytes?: number;
}

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64 = (n: number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const str = (s: string) => {
  const bytes = Buffer.from(s, 'utf8');
  return Buffer.concat([u64(bytes.length), bytes]);
};
const STRING = 8;
const UINT32 = 4;

/** The bytes of a small GGUF file. */
export function testGguf(options: TestGgufOptions = {}): Buffer {
  const metadata: [string, Buffer][] = [
    ['general.architecture', Buffer.concat([u32(STRING), str('llama')])],
    ['general.name', Buffer.concat([u32(STRING), str(options.name ?? 'Tiny Test')])],
    ['llama.block_count', Buffer.concat([u32(UINT32), u32(options.layers ?? 32)])],
    ['llama.context_length', Buffer.concat([u32(UINT32), u32(options.contextLength ?? 131072)])],
    ['llama.embedding_length', Buffer.concat([u32(UINT32), u32(4096)])],
    ['llama.attention.head_count', Buffer.concat([u32(UINT32), u32(32)])],
    ['llama.attention.head_count_kv', Buffer.concat([u32(UINT32), u32(options.kvHeads ?? 8)])],
  ];
  return Buffer.concat([
    Buffer.from('GGUF', 'ascii'),
    u32(3),
    u64(0), // tensor count
    u64(metadata.length),
    ...metadata.map(([key, value]) => Buffer.concat([str(key), value])),
    Buffer.alloc(options.weightBytes ?? 64 * 1024, 0xff),
  ]);
}
