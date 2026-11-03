// The Shell's way to call the core API. Use `api()` for every call: it sends the CSRF token
// that the core requires on mutating browser requests, and refreshes it once if the core restarted.
import type { Me } from '@kiln/widget-sdk';

const CSRF_HEADER = 'x-kiln-csrf';

let csrfToken: string | undefined;

export class ApiError extends Error {
  readonly status: number;
  readonly reason: string | undefined;
  constructor(status: number, message: string, reason?: string) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

/** Who this browser is. Also picks up the CSRF token. */
export async function fetchMe(): Promise<Me> {
  const res = await fetch('/api/me');
  if (!res.ok) throw new ApiError(res.status, `GET /api/me -> ${res.status}`);
  const me = (await res.json()) as Me;
  csrfToken = me.csrfToken;
  return me;
}

async function send(method: string, path: string, body: unknown): Promise<Response> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers[CSRF_HEADER] = csrfToken;
  return fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  let res = await send(method, path, body);
  if (res.status === 403 && method !== 'GET') {
    const { reason } = (await res.clone().json().catch(() => ({}))) as { reason?: string };
    if (reason === 'csrf') {
      await fetchMe();
      res = await send(method, path, body);
    }
  }
  const text = await res.text();
  const parsed = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const { error, reason } = (parsed ?? {}) as { error?: string; reason?: string };
    throw new ApiError(res.status, error ?? `${method} ${path} -> ${res.status}`, reason);
  }
  return parsed as T;
}
