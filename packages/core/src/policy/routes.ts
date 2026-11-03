// Core API routes for the Policy.
//   GET /api/org-policy                                  OrgPolicy (any role)
//   PUT /api/org-policy {actions?, rules?, widgetSources?}  OrgPolicy (Admin; audited as org_policy.update)
//   GET /api/projects/:id/policy?kind=<kind>&stage=<stage>  PolicyView: each layer and the effective Policy
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { OrgPolicyUpdate } from '@kiln/widget-sdk';
import type { Access } from '../access.ts';
import { WorkError, type Work } from '../work/work.ts';
import type { RouteHelpers } from '../work/routes.ts';
import type { PolicyEngine } from './policy.ts';

const PROJECT_POLICY = /^\/api\/projects\/([^/]+)\/policy$/;

/** Answers the request if it is a Policy route; returns false otherwise. */
export async function handlePolicyRoute(
  policy: PolicyEngine,
  work: Work,
  access: Access,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  { sendJson, readJson }: RouteHelpers,
): Promise<boolean> {
  try {
    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /api/org-policy') return (sendJson(res, 200, policy.org()), true);
    if (route === 'PUT /api/org-policy') {
      const body = ((await readJson(req)) ?? {}) as OrgPolicyUpdate;
      access.note(req, { target: 'org-policy', detail: { actions: body.actions, rules: body.rules, widgetSources: body.widgetSources } });
      return (sendJson(res, 200, policy.updateOrg(body)), true);
    }
    const match = PROJECT_POLICY.exec(url.pathname);
    if (match && req.method === 'GET') {
      const project = work.project(decodeURIComponent(match[1]!));
      if (!project) throw new WorkError(404, `No Project "${match[1]}"`);
      const kind = url.searchParams.get('kind') ?? '';
      const stage = url.searchParams.get('stage') ?? '';
      const found = project.workflow.kinds.find((k) => k.id === kind)?.stages.some((s) => s.id === stage);
      if (!found) throw new WorkError(400, 'Name an Item kind and one of its Stages: ?kind=ticket&stage=implementing');
      return (sendJson(res, 200, policy.view({ project, kind, stage })), true);
    }
    return false;
  } catch (err) {
    if (err instanceof WorkError) return (sendJson(res, err.status, { error: err.message }), true);
    throw err;
  }
}
