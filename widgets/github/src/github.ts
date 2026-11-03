// GitHub Issues as a Tracker: the REST calls, and how an issue reads as an Item record.
//
//   kind:<kind>       the Item's kind (an issue without one is not an Item)
//   stage:<stage>     its Stage; a closed issue without one reads as shipped
//   status:<status>   its Status
//   sub-issues        its parent
//   the issue body    its description
//
// Kiln writes only the stage and status labels and the open/closed state; every other label, the
// title and the body are left to people and Sessions.
import type { TrackerCreateInput, TrackerItem } from '@kiln/widget-sdk';

export interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: Array<{ name: string } | string>;
  pull_request?: unknown;
  sub_issues_summary?: { total: number };
}

export interface GitHubPull {
  number: number;
  html_url: string;
  state: string;
  merged?: boolean;
  merged_at?: string | null;
}

export class GitHubError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface GitHubClient {
  issues(repo: string): Promise<GitHubIssue[]>;
  subIssues(repo: string, number: number): Promise<GitHubIssue[]>;
  issue(repo: string, number: number): Promise<GitHubIssue>;
  createIssue(repo: string, issue: { title: string; body?: string; labels: string[] }): Promise<GitHubIssue>;
  addSubIssue(repo: string, parent: number, childId: number): Promise<void>;
  updateIssue(repo: string, number: number, change: { labels?: string[]; state?: 'open' | 'closed' }): Promise<void>;
  openPull(repo: string, pull: { title: string; body: string; head: string; base: string }): Promise<GitHubPull>;
  pull(repo: string, number: number): Promise<GitHubPull>;
}

/** A REST client; `token()` is asked again after a 401, in case the secret was changed. */
export function gitHubClient(apiUrl: string, token: (fresh: boolean) => Promise<string>): GitHubClient {
  const base = apiUrl.replace(/\/+$/, '');
  const call = async <T>(method: string, path: string, body?: unknown, retried = false): Promise<T> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await token(retried)}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 && !retried) return call<T>(method, path, body, true);
    const text = await res.text();
    if (!res.ok) throw new GitHubError(res.status, `GitHub ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : undefined) as T;
  };
  const repoPath = (repo: string) => `/repos/${repo}`;
  const pages = async (path: string): Promise<GitHubIssue[]> => {
    const all: GitHubIssue[] = [];
    for (let page = 1; ; page++) {
      const sep = path.includes('?') ? '&' : '?';
      const batch = await call<GitHubIssue[]>('GET', `${path}${sep}per_page=100&page=${page}`);
      all.push(...batch);
      if (batch.length < 100) return all;
    }
  };
  return {
    issues: (repo) => pages(`${repoPath(repo)}/issues?state=all`),
    subIssues: (repo, number) => pages(`${repoPath(repo)}/issues/${number}/sub_issues`),
    issue: (repo, number) => call('GET', `${repoPath(repo)}/issues/${number}`),
    createIssue: (repo, issue) => call('POST', `${repoPath(repo)}/issues`, issue),
    async addSubIssue(repo, parent, childId) {
      await call('POST', `${repoPath(repo)}/issues/${parent}/sub_issues`, { sub_issue_id: childId });
    },
    async updateIssue(repo, number, change) {
      await call('PATCH', `${repoPath(repo)}/issues/${number}`, change);
    },
    openPull: (repo, pull) => call('POST', `${repoPath(repo)}/pulls`, pull),
    pull: (repo, number) => call('GET', `${repoPath(repo)}/pulls/${number}`),
  };
}

export const labelNames = (issue: GitHubIssue) => issue.labels.map((l) => (typeof l === 'string' ? l : l.name));
const labelValue = (labels: string[], name: string) => labels.find((l) => l.startsWith(`${name}:`))?.slice(name.length + 1);

/** An Item's key on GitHub: its kind and issue number, e.g. `ticket/12`. */
export const keyOf = (kind: string, number: number) => `${kind}/${number}`;
export function numberOf(key: string): number {
  const number = Number(key.slice(key.lastIndexOf('/') + 1));
  if (!Number.isInteger(number) || number < 1) throw new Error(`"${key}" is not a GitHub issue key`);
  return number;
}

/** Every issue (not pull request) with a kind label, as Item records; `all` is what GitHub returned. */
export async function listRecords(client: GitHubClient, repo: string): Promise<{ records: TrackerItem[]; all: GitHubIssue[] }> {
  const all = await client.issues(repo);
  const issues = all.filter((i) => i.pull_request === undefined);
  const kinds = new Map<number, string>();
  for (const issue of issues) {
    const kind = labelValue(labelNames(issue), 'kind');
    if (kind) kinds.set(issue.number, kind);
  }
  const parents = new Map<number, number>();
  for (const issue of issues) {
    if (!kinds.has(issue.number) || !issue.sub_issues_summary?.total) continue;
    for (const child of await client.subIssues(repo, issue.number)) parents.set(child.number, issue.number);
  }
  const records: TrackerItem[] = [];
  for (const issue of issues) {
    const kind = kinds.get(issue.number);
    if (!kind) continue;
    const labels = labelNames(issue);
    const status = labelValue(labels, 'status');
    const parent = parents.get(issue.number);
    const parentKind = parent === undefined ? undefined : kinds.get(parent);
    records.push({
      key: keyOf(kind, issue.number),
      kind,
      title: issue.title,
      stage: labelValue(labels, 'stage') ?? (issue.state === 'closed' ? 'shipped' : ''),
      ...(status ? { status } : {}),
      ...(issue.body ? { description: issue.body } : {}),
      ...(parent !== undefined && parentKind ? { parentKey: keyOf(parentKind, parent) } : {}),
    });
  }
  return { records, all };
}

/** Opens the issue for a new Item, under its parent's issue when it has one. */
export async function createRecord(client: GitHubClient, repo: string, input: TrackerCreateInput): Promise<string> {
  const labels = [`kind:${input.kind}`, ...(input.stage ? [`stage:${input.stage}`] : [])];
  const issue = await client.createIssue(repo, { title: input.title, labels, ...(input.description ? { body: input.description } : {}) });
  if (input.parentKey) await client.addSubIssue(repo, numberOf(input.parentKey), issue.id);
  return keyOf(input.kind, issue.number);
}

/** Moves an issue to a Stage: its stage (and status) labels change, the rest stay; done closes it. */
export async function writeStage(client: GitHubClient, repo: string, change: { key: string; stage: string; status?: string; closed: boolean }) {
  const number = numberOf(change.key);
  const labels = labelNames(await client.issue(repo, number)).filter(
    (l) => !l.startsWith('stage:') && !(change.status !== undefined && l.startsWith('status:')),
  );
  labels.push(`stage:${change.stage}`);
  if (change.status) labels.push(`status:${change.status}`);
  await client.updateIssue(repo, number, { labels, state: change.closed ? 'closed' : 'open' });
}

/** What changes when any issue Kiln reads changes. */
export const fingerprint = (issues: GitHubIssue[]) =>
  JSON.stringify(issues.map((i) => [i.number, i.title, i.body, i.state, labelNames(i).sort(), i.sub_issues_summary?.total ?? 0]));
