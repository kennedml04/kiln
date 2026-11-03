// A fake GitHub REST API for tests: one repo's issues (with labels and sub-issues) and pull requests,
// served on 127.0.0.1 on a free port. Tests point the GitHub Widget at it through its install config,
// so no test ever talks to the real GitHub or uses anyone's real credentials.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { onCleanup, type Cleanup } from './harness.ts';

export interface FakeIssue {
  /** GitHub's global id (what the sub-issue API takes). */
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: string[];
  /** The number of the issue this one is a sub-issue of. */
  parent?: number;
}

export interface FakePull {
  number: number;
  title: string;
  body: string | null;
  head: string;
  base: string;
  state: 'open' | 'closed';
  merged: boolean;
}

export interface FakeRequest {
  method: string;
  path: string;
  body: unknown;
  authorization: string | undefined;
}

export interface FakeGitHub {
  /** The API's base URL, e.g. http://127.0.0.1:51234 (what the Widget's `apiUrl` config takes). */
  url: string;
  /** `owner/name` of the one repo it serves. */
  repo: string;
  /** The only token it accepts (as `authorization: Bearer <token>`). */
  token: string;
  issues(): FakeIssue[];
  issue(number: number): FakeIssue;
  /** A person opens an issue on GitHub. */
  addIssue(issue: { title: string; body?: string; labels?: string[]; state?: 'open' | 'closed'; parent?: number }): FakeIssue;
  /** A person edits an issue on GitHub. */
  editIssue(number: number, change: Partial<Pick<FakeIssue, 'title' | 'body' | 'state' | 'labels'>>): FakeIssue;
  pulls(): FakePull[];
  /** A person merges a pull request on GitHub. */
  mergePull(number: number): void;
  /** A person closes a pull request on GitHub without merging it. */
  closePull(number: number): void;
  /** Every API request it was sent, oldest first. */
  requests(): FakeRequest[];
}

const PAGE = 30;

/** Starts a fake GitHub serving one repo; closed at the end of the test. */
export async function startFakeGitHub(t: Cleanup, options: { repo?: string } = {}): Promise<FakeGitHub> {
  const repo = options.repo ?? 'acme/board';
  const token = `fake-gh-${randomBytes(8).toString('hex')}`;
  const issues = new Map<number, FakeIssue>();
  const pulls = new Map<number, FakePull>();
  const log: FakeRequest[] = [];
  let next = 1;
  let nextId = 9000;

  const view = (issue: FakeIssue) => {
    const children = [...issues.values()].filter((i) => i.parent === issue.number);
    return {
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((name) => ({ name })),
      html_url: `https://github.com/${repo}/issues/${issue.number}`,
      sub_issues_summary: { total: children.length, completed: children.filter((c) => c.state === 'closed').length },
    };
  };
  const pullView = (pull: FakePull) => ({
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged ? new Date().toISOString() : null,
    head: { ref: pull.head },
    base: { ref: pull.base },
    html_url: `https://github.com/${repo}/pull/${pull.number}`,
  });

  const addIssue: FakeGitHub['addIssue'] = (input) => {
    const issue: FakeIssue = {
      id: nextId++,
      number: next++,
      title: input.title,
      body: input.body ?? null,
      state: input.state ?? 'open',
      labels: [...(input.labels ?? [])],
      ...(input.parent ? { parent: input.parent } : {}),
    };
    issues.set(issue.number, issue);
    return issue;
  };
  const issue = (number: number) => {
    const found = issues.get(number);
    if (!found) throw new Error(`No fake issue #${number}`);
    return found;
  };

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const readBody = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? (JSON.parse(text) as unknown) : undefined;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const body = (await readBody(req)) as Record<string, unknown> | undefined;
    log.push({ method: req.method ?? '', path: url.pathname + url.search, body, authorization: req.headers.authorization });
    if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { message: 'Bad credentials' });
    const prefix = `/repos/${repo}`;
    if (!url.pathname.startsWith(`${prefix}/`)) return send(res, 404, { message: 'Not Found' });
    const path = url.pathname.slice(prefix.length);
    const route = `${req.method} ${path}`;
    let m: RegExpExecArray | null;

    if (route === 'GET /issues') {
      const state = url.searchParams.get('state') ?? 'open';
      const page = Number(url.searchParams.get('page') ?? 1);
      const per = Math.min(Number(url.searchParams.get('per_page') ?? PAGE), 100);
      const all = [...issues.values()].filter((i) => state === 'all' || i.state === state);
      return send(res, 200, all.slice((page - 1) * per, page * per).map(view));
    }
    if (route === 'POST /issues') {
      if (typeof body?.title !== 'string' || !body.title) return send(res, 422, { message: 'title is required' });
      const labels = Array.isArray(body.labels) ? (body.labels as string[]) : [];
      return send(res, 201, view(addIssue({ title: body.title, body: (body.body as string | undefined) ?? undefined, labels })));
    }
    if ((m = /^\/issues\/(\d+)$/.exec(path))) {
      const found = issues.get(Number(m[1]));
      if (!found) return send(res, 404, { message: 'Not Found' });
      if (req.method === 'GET') return send(res, 200, view(found));
      if (req.method === 'PATCH') {
        if (typeof body?.title === 'string') found.title = body.title;
        if (body && 'body' in body) found.body = (body.body as string | null) ?? null;
        if (body?.state === 'open' || body?.state === 'closed') found.state = body.state;
        if (Array.isArray(body?.labels)) found.labels = [...(body.labels as string[])];
        return send(res, 200, view(found));
      }
    }
    if ((m = /^\/issues\/(\d+)\/sub_issues$/.exec(path))) {
      const parent = issues.get(Number(m[1]));
      if (!parent) return send(res, 404, { message: 'Not Found' });
      if (req.method === 'GET') return send(res, 200, [...issues.values()].filter((i) => i.parent === parent.number).map(view));
      if (req.method === 'POST') {
        const child = [...issues.values()].find((i) => i.id === body?.sub_issue_id);
        if (!child) return send(res, 422, { message: 'sub_issue_id is not an issue of this repo' });
        if (child.parent !== undefined) return send(res, 422, { message: 'The issue already has a parent' });
        child.parent = parent.number;
        return send(res, 201, view(parent));
      }
    }
    if (route === 'POST /pulls') {
      const { title, head, base } = body ?? {};
      if (typeof title !== 'string' || typeof head !== 'string' || typeof base !== 'string') return send(res, 422, { message: 'title, head and base are required' });
      if ([...pulls.values()].some((p) => p.head === head && p.state === 'open')) return send(res, 422, { message: `A pull request already exists for ${head}` });
      const pull: FakePull = { number: next++, title, body: (body?.body as string | undefined) ?? null, head, base, state: 'open', merged: false };
      pulls.set(pull.number, pull);
      return send(res, 201, pullView(pull));
    }
    if ((m = /^\/pulls\/(\d+)$/.exec(path)) && req.method === 'GET') {
      const pull = pulls.get(Number(m[1]));
      return pull ? send(res, 200, pullView(pull)) : send(res, 404, { message: 'Not Found' });
    }
    return send(res, 404, { message: `Not Found: ${route}` });
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => send(res, 500, { message: String(err) }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  onCleanup(t, 'stop the fake GitHub', () => new Promise<void>((done) => {
    server.close(() => done());
    server.closeAllConnections();
  }));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    repo,
    token,
    issues: () => [...issues.values()],
    issue,
    addIssue,
    editIssue(number, change) {
      const found = issue(number);
      Object.assign(found, change);
      return found;
    },
    pulls: () => [...pulls.values()],
    mergePull(number) {
      const pull = pulls.get(number);
      if (!pull) throw new Error(`No fake pull request #${number}`);
      pull.state = 'closed';
      pull.merged = true;
    },
    closePull(number) {
      const pull = pulls.get(number);
      if (!pull) throw new Error(`No fake pull request #${number}`);
      pull.state = 'closed';
      pull.merged = false;
    },
    requests: () => [...log],
  };
}
