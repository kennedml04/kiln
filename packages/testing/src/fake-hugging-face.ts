// A fake Hugging Face for tests: the public tree API (`/api/models/<repo>/tree/main`) and file
// downloads (`/<repo>/resolve/main/<path>`, redirected to a "CDN" path as the real one does) with
// HTTP Range support. A download can be cut part-way or stall, to test resuming. Served on 127.0.0.1 on a
// free port, so no test ever reaches huggingface.co.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { onCleanup, type Cleanup } from './harness.ts';
import { assertIsolated } from './isolation.ts';

export interface FakeHuggingFaceFile {
  path: string;
  bytes: Buffer;
}

export interface FakeHuggingFaceRequest {
  method: string;
  path: string;
  /** The Range header, when the request had one. */
  range?: string;
}

export interface FakeHuggingFace {
  /** The base URL, for the core's `KILN_HUGGINGFACE_URL`. */
  url: string;
  /** A public repo and its files. */
  addRepo(repo: string, files: FakeHuggingFaceFile[]): void;
  /** The next download of this file sends only its first `afterBytes` bytes, then drops the connection. */
  cutNext(repo: string, path: string, afterBytes: number): void;
  /** The next download of this file sends only its first `afterBytes` bytes, then sends nothing more but keeps the connection open. */
  stallNext(repo: string, path: string, afterBytes: number): void;
  /** Every request it was sent, oldest first. */
  requests(): FakeHuggingFaceRequest[];
}

export interface FakeHuggingFaceOptions {
  /** Bytes a download sends at a time. Default 16 KB. */
  chunkBytes?: number;
  /** The pause between chunks, so progress can be seen. Default 0. */
  chunkDelayMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startFakeHuggingFace(t: Cleanup, options: FakeHuggingFaceOptions = {}): Promise<FakeHuggingFace> {
  const repos = new Map<string, FakeHuggingFaceFile[]>();
  const cuts = new Map<string, number>();
  const stalls = new Map<string, number>();
  const log: FakeHuggingFaceRequest[] = [];
  const chunkBytes = options.chunkBytes ?? 16 * 1024;

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const serveFile = async (req: IncomingMessage, res: ServerResponse, repo: string, file: FakeHuggingFaceFile) => {
    const total = file.bytes.length;
    const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
    const start = range ? Number(range[1]) : 0;
    if (start >= total) {
      res.writeHead(416, { 'content-range': `bytes */${total}` });
      return res.end();
    }
    const body = file.bytes.subarray(start);
    res.writeHead(range ? 206 : 200, {
      'content-type': 'application/octet-stream',
      'content-length': String(body.length),
      'accept-ranges': 'bytes',
      ...(range ? { 'content-range': `bytes ${start}-${total - 1}/${total}` } : {}),
    });
    const key = `${repo}/${file.path}`;
    const cut = cuts.get(key);
    cuts.delete(key);
    const stall = stalls.get(key);
    stalls.delete(key);
    const stop = cut ?? stall;
    const end = stop === undefined ? body.length : Math.min(body.length, stop);
    for (let at = 0; at < end; at += chunkBytes) {
      const chunk = body.subarray(at, Math.min(end, at + chunkBytes));
      await new Promise<void>((done) => res.write(chunk, () => done()));
      if (options.chunkDelayMs) await sleep(options.chunkDelayMs);
    }
    if (stall !== undefined) {
      // Hold the connection open, sending nothing, until the client gives up.
      await new Promise<void>((done) => res.once('close', () => done()));
      return;
    }
    if (cut !== undefined) {
      await sleep(50);
      res.socket?.destroy();
      return;
    }
    res.end();
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = decodeURIComponent(url.pathname);
    log.push({ method: req.method ?? '', path, ...(req.headers.range ? { range: req.headers.range } : {}) });
    const tree = /^\/api\/models\/([^/]+\/[^/]+)\/tree\/main$/.exec(path);
    if (req.method === 'GET' && tree) {
      const files = repos.get(tree[1]!);
      if (!files) return send(res, 404, { error: 'Repository not found' });
      const dirs = new Set(files.flatMap((f) => (f.path.includes('/') ? [f.path.slice(0, f.path.lastIndexOf('/'))] : [])));
      return send(res, 200, [
        { type: 'file', oid: 'readme', size: 120, path: 'README.md' },
        ...[...dirs].map((d) => ({ type: 'directory', oid: d, size: 0, path: d })),
        ...files.map((f) => ({ type: 'file', oid: f.path, size: 135, path: f.path, lfs: { oid: f.path, size: f.bytes.length, pointerSize: 135 } })),
      ]);
    }
    const resolve = /^\/([^/]+\/[^/]+)\/resolve\/main\/(.+)$/.exec(path);
    if (req.method === 'GET' && resolve) {
      const file = repos.get(resolve[1]!)?.find((f) => f.path === resolve[2]);
      if (!file) return send(res, 404, { error: 'Entry not found' });
      res.writeHead(302, { location: `/cdn/${resolve[1]}/${encodeURI(resolve[2]!)}` });
      return res.end();
    }
    const cdn = /^\/cdn\/([^/]+\/[^/]+)\/(.+)$/.exec(path);
    if (req.method === 'GET' && cdn) {
      const file = repos.get(cdn[1]!)?.find((f) => f.path === cdn[2]);
      if (!file) return send(res, 404, { error: 'Entry not found' });
      return serveFile(req, res, cdn[1]!, file);
    }
    return send(res, 404, { error: `No route for ${req.method} ${path}` });
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err: Error) => {
      if (!res.headersSent) send(res, 500, { error: err.message });
      else res.destroy();
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  const { port } = server.address() as AddressInfo;
  assertIsolated({ port });
  onCleanup(t, 'stop the fake Hugging Face', () => new Promise<void>((done) => {
    server.close(() => done());
    server.closeAllConnections();
  }));

  return {
    url: `http://127.0.0.1:${port}`,
    addRepo: (repo, files) => void repos.set(repo, files),
    cutNext: (repo, path, afterBytes) => void cuts.set(`${repo}/${path}`, afterBytes),
    stallNext: (repo, path, afterBytes) => void stalls.set(`${repo}/${path}`, afterBytes),
    requests: () => [...log],
  };
}
