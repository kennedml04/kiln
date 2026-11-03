// Widget secrets: named in a Manifest, entered by an Admin, kept in the OS credential store and
// handed only to the Widget whose grants include the name. Kiln itself stores no value anywhere.
//
// Each core keeps its secrets under its own namespace, `Kiln/<instance>/<widgetId>`, where
// `<instance>` is a short hash of the data folder, so two Kiln data folders never share a secret.
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import type { SecretValue, SetSecretRequest, WidgetInfo, WidgetSecrets } from '@kiln/widget-sdk';
import type { Access } from '../access.ts';
import { WidgetHostError } from '../widget-host.ts';
import type { CredentialStore } from './os-credential-store.ts';

const MAX_SECRET_BYTES = 16 * 1024;

export interface WidgetSecretStore {
  list(widgetId: string): Promise<WidgetSecrets>;
  set(widgetId: string, name: string, value: string): Promise<void>;
  remove(widgetId: string, name: string): Promise<void>;
  /** The value for the Widget itself: 403 `grant` unless granted, 404 when unset. */
  read(widgetId: string, name: string): Promise<SecretValue>;
  /** Removes every secret a Widget's Manifests named (the Widget is being removed). */
  removeAll(widget: WidgetInfo): Promise<void>;
}

export interface SecretDeps {
  store: CredentialStore | null;
  dataDir: string;
  widget(id: string): WidgetInfo | undefined;
  granted(id: string): string[];
}

/** Every name the Widget's Manifest, or its pending update, declares. */
const declared = (widget: WidgetInfo): string[] => [
  ...new Set([...(widget.manifest.needs?.secrets ?? []), ...(widget.pendingUpdate?.manifest.needs?.secrets ?? [])]),
];

export function createWidgetSecrets({ store, dataDir, widget, granted }: SecretDeps): WidgetSecretStore {
  const instance = createHash('sha256').update(resolve(dataDir).toLowerCase()).digest('hex').slice(0, 12);
  const location = (widgetId: string, name: string) => ({ resource: `Kiln/${instance}/${widgetId}`, account: name });

  const osStore = (): CredentialStore => {
    if (!store) throw new WidgetHostError(501, `Kiln has no OS credential store on ${process.platform}`);
    return store;
  };
  const installed = (id: string): WidgetInfo => {
    const found = widget(id);
    if (!found) throw new WidgetHostError(404, `No Widget "${id}" is installed`);
    return found;
  };
  const named = (id: string, name: string) => {
    if (!declared(installed(id)).includes(name)) throw new WidgetHostError(404, `Widget "${id}" declares no secret "${name}"`);
  };
  const get = (widgetId: string, name: string) => {
    const at = location(widgetId, name);
    return osStore().get(at.resource, at.account);
  };

  return {
    async list(widgetId) {
      const names = declared(installed(widgetId));
      const entries = await Promise.all(
        names.map(async (name) => ({ name, set: (await get(widgetId, name)) !== null, location: location(widgetId, name) })),
      );
      return { store: osStore().kind, entries };
    },

    async set(widgetId, name, value) {
      named(widgetId, name);
      if (typeof value !== 'string' || value === '') throw new WidgetHostError(400, 'Give the secret as { "value": "..." }');
      if (Buffer.byteLength(value) > MAX_SECRET_BYTES) throw new WidgetHostError(400, `A secret may be at most ${MAX_SECRET_BYTES} bytes`);
      const at = location(widgetId, name);
      await osStore().set(at.resource, at.account, value);
    },

    async remove(widgetId, name) {
      named(widgetId, name);
      const at = location(widgetId, name);
      await osStore().remove(at.resource, at.account);
    },

    async read(widgetId, name) {
      if (!granted(widgetId).includes(name)) {
        throw new WidgetHostError(403, `This Widget was not granted the secret "${name}"`, 'grant');
      }
      const value = await get(widgetId, name);
      if (value === null) throw new WidgetHostError(404, `The secret "${name}" has not been set`);
      return { name, value };
    },

    async removeAll(info) {
      if (!store) return;
      for (const name of declared(info)) {
        const at = location(info.id, name);
        await store.remove(at.resource, at.account);
      }
    },
  };
}

export interface SecretRouteDeps {
  access: Access;
  /** The calling Widget's id, from its credential (throws 401 without one). */
  widgetId(req: IncomingMessage): string;
  sendJson(res: ServerResponse, code: number, body: unknown): void;
  readJson(req: IncomingMessage): Promise<unknown>;
}

/** The secrets routes (see widget-api.ts). Returns false when the request is not one of them. */
export async function handleSecretRoute(
  secrets: WidgetSecretStore,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: SecretRouteDeps,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const own = /^\/api\/widget\/secrets\/([^/]+)$/.exec(url.pathname);
  if (own && method === 'GET') {
    const name = decodeURIComponent(own[1]!);
    const widgetId = deps.widgetId(req);
    deps.access.note(req, { target: name });
    deps.sendJson(res, 200, await secrets.read(widgetId, name));
    return true;
  }
  const list = /^\/api\/widgets\/([^/]+)\/secrets$/.exec(url.pathname);
  if (list && method === 'GET') {
    deps.sendJson(res, 200, await secrets.list(decodeURIComponent(list[1]!)));
    return true;
  }
  const one = /^\/api\/widgets\/([^/]+)\/secrets\/([^/]+)$/.exec(url.pathname);
  if (one && (method === 'PUT' || method === 'DELETE')) {
    const widgetId = decodeURIComponent(one[1]!);
    const name = decodeURIComponent(one[2]!);
    // The target names the secret; the value never goes into the audit entry.
    deps.access.note(req, { target: `${widgetId}/${name}` });
    if (method === 'PUT') {
      const body = (await deps.readJson(req)) as Partial<SetSecretRequest> | null;
      await secrets.set(widgetId, name, body?.value as string);
      deps.sendJson(res, 200, { name, set: true });
    } else {
      await secrets.remove(widgetId, name);
      deps.sendJson(res, 200, { name, set: false });
    }
    return true;
  }
  return false;
}
