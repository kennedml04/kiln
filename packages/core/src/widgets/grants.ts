// Grants: what an Admin approved for a Widget, whether an update asks for more, and whether a
// Widget's request is inside what it was granted.
import { eventProject, widgetEventScope, type KilnEvent, type Manifest, type WidgetGrants, type WidgetNeeds } from '@kiln/widget-sdk';

type WorkNeed = NonNullable<WidgetNeeds['work']>[number];

/** The grants an Admin gives by approving this Manifest. */
export function grantsFor(manifest: Manifest, approvedBy: string): WidgetGrants {
  return {
    needs: structuredClone(manifest.needs ?? {}),
    pools: { ...(manifest.provides?.pools ?? {}) },
    approvedBy,
    approvedAt: new Date().toISOString(),
  };
}

const covers = (granted: WorkNeed, wanted: WorkNeed) =>
  (granted.access === 'write' || wanted.access === 'read') &&
  (granted.projects === '*' || (wanted.projects !== '*' && wanted.projects.every((p) => granted.projects.includes(p))));

const describeWork = (need: WorkNeed) =>
  `work: ${need.access} ${need.projects === '*' ? 'all Projects' : `Projects ${need.projects.join(', ')}`}`;

/** What this Manifest asks for beyond the grants, in words. Empty when it asks for nothing new. */
export function newNeeds(grants: WidgetGrants, manifest: Manifest): string[] {
  const had = grants.needs;
  const wants = manifest.needs ?? {};
  const added: string[] = [];
  for (const need of wants.work ?? []) if (!(had.work ?? []).some((g) => covers(g, need))) added.push(describeWork(need));
  if (wants.asks && !had.asks) added.push('asks');
  for (const domain of wants.network ?? []) if (!(had.network ?? []).includes(domain)) added.push(`network: ${domain}`);
  for (const secret of wants.secrets ?? []) if (!(had.secrets ?? []).includes(secret)) added.push(`secret: ${secret}`);
  if (wants.dataFolder && !had.dataFolder) added.push('data folder');
  for (const [pool, size] of Object.entries(manifest.provides?.pools ?? {})) {
    if ((grants.pools[pool] ?? 0) < size) added.push(`pool: ${pool} ${size}`);
  }
  return added;
}

const PROJECT_PATH = /^\/api\/projects\/([^/]+)(\/items)?$/;
const ITEM_PATH = /^\/api\/items\/([^/]+)$/;

/** The Work access and Project scope a Widget request needs, or undefined when no grant can cover it. */
function workNeedOf(method: string, url: URL): WorkNeed | undefined {
  const path = url.pathname;
  if (method === 'GET' && path === '/api/projects') return { access: 'read', projects: '*' };
  if (method === 'GET' && path === '/api/items') {
    const project = url.searchParams.get('project');
    return { access: 'read', projects: project ? [project] : '*' };
  }
  const project = PROJECT_PATH.exec(path);
  if (project) {
    const id = decodeURIComponent(project[1]!);
    if (method === 'GET') return { access: 'read', projects: [id] };
    if (method === 'POST' && project[2]) return { access: 'write', projects: [id] };
    return undefined;
  }
  const item = ITEM_PATH.exec(path);
  if (item && method === 'PATCH') {
    const projectId = decodeURIComponent(item[1]!).split('/')[0]!;
    return { access: 'write', projects: [projectId] };
  }
  return undefined;
}

/** The scope of a requested event type: exact (`item.updated`) or a family (`session.*`, `widget.*`). */
function requestedScope(type: string): 'work' | 'health' | null {
  if (!type.endsWith('.*')) return widgetEventScope(type);
  const family = type.slice(0, -2);
  if (family === 'widget') return 'health';
  return widgetEventScope(`${family}.any`) === 'work' ? 'work' : null;
}

const matchesType = (pattern: string, type: string) => (pattern.endsWith('.*') ? type.startsWith(pattern.slice(0, -1)) : pattern === type);

/**
 * What a Widget may follow of the event types it asks for (see widget-events.ts in the SDK).
 * `refused` lists the types its grants don't allow; `accepts` says whether to deliver one event.
 */
export function eventSubscription(grants: WidgetGrants | null, types: string[]) {
  const work = grants?.needs.work ?? [];
  const refused = types.filter((type) => {
    const scope = requestedScope(type);
    return scope === null || (scope === 'work' && work.length === 0);
  });
  const accepts = (event: KilnEvent): boolean => {
    const scope = widgetEventScope(event.type);
    if (scope === null || !types.some((pattern) => matchesType(pattern, event.type))) return false;
    if (scope === 'health') return true;
    const project = eventProject(event.payload);
    const need: WorkNeed = { access: 'read', projects: project ? [project] : '*' };
    return work.some((g) => covers(g, need));
  };
  return { refused, accepts };
}

/** Whether a Widget holding these grants may make this request. */
export function grantAllows(grants: WidgetGrants | null, method: string, url: URL): boolean {
  if (!grants) return false;
  const need = workNeedOf(method, url);
  return need !== undefined && (grants.needs.work ?? []).some((g) => covers(g, need));
}
