// The GitHub Widget against the shared Tracker contract: once against a fake GitHub (always), and
// once against a real throwaway repo, only when asked for with both of
//   KILN_GITHUB_TEST_REPO   owner/name of a throwaway repo whose issues the run may create and close
//   KILN_GITHUB_TEST_TOKEN  a token for that repo only (never your everyday gh credentials)
import type { Project } from '@kiln/widget-sdk';
import { startFakeGitHub, type FakeGitHub } from '@kiln/testing/fake-github';
import { CONTRACT_TREE, trackerContract, type RecordedItem } from '@kiln/testing/tracker-contract';
import { recordOf, registerGitHubProject, seedIssues, startGitHubWidget } from './helpers.ts';

let fake: FakeGitHub | undefined;
const fakeIssue = (title: string) => fake!.issues().find((i) => i.title === title);

trackerContract({
  name: 'the GitHub Tracker (fake GitHub)',
  async setUp(t, kiln): Promise<Project> {
    fake = await startFakeGitHub(t);
    seedIssues(fake);
    await startGitHubWidget(t, kiln, { apiUrl: fake.url, token: fake.token });
    return registerGitHubProject(kiln, fake.repo);
  },
  async recorded(title) {
    const issue = fakeIssue(title);
    return issue && recordOf(fake!, issue);
  },
  async renameOutside(title, to) {
    const issue = fakeIssue(title);
    if (!issue) throw new Error(`No issue titled "${title}"`);
    fake!.editIssue(issue.number, { title: to });
  },
});

// The opt-in run against the real GitHub.
const REAL_REPO = process.env.KILN_GITHUB_TEST_REPO;
const REAL_TOKEN = process.env.KILN_GITHUB_TEST_TOKEN;
const REAL_API = 'https://api.github.com';

interface RealIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: { name: string }[];
  pull_request?: unknown;
}

const real = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const res = await fetch(`${REAL_API}/repos/${REAL_REPO}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${REAL_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${await res.text()}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
};

const realIssues = async () => {
  const all: RealIssue[] = [];
  for (let page = 1; ; page++) {
    const batch = await real<RealIssue[]>('GET', `/issues?state=all&per_page=100&page=${page}`);
    all.push(...batch.filter((i) => !i.pull_request));
    if (batch.length < 100) return all;
  }
};

/** Every earlier run's issues lose their Kiln labels and close, so only this run's tree counts. */
async function clearRealRepo() {
  for (const issue of await realIssues()) {
    const labels = issue.labels.map((l) => l.name);
    if (!labels.some((l) => /^(kind|stage|status):/.test(l))) continue;
    await real('PATCH', `/issues/${issue.number}`, { labels: labels.filter((l) => !/^(kind|stage|status):/.test(l)), state: 'closed' });
  }
}

const realCreate = async (title: string, body: string, labels: string[], state: 'open' | 'closed', parent?: RealIssue) => {
  const issue = await real<RealIssue>('POST', '/issues', { title, body, labels });
  if (parent) await real('POST', `/issues/${parent.number}/sub_issues`, { sub_issue_id: issue.id });
  if (state === 'closed') await real('PATCH', `/issues/${issue.number}`, { state });
  return issue;
};

const realRecorded = async (title: string): Promise<RealIssue | undefined> =>
  (await realIssues()).find((i) => i.title === title && i.labels.some((l) => l.name.startsWith('kind:')));

trackerContract({
  name: 'the GitHub Tracker (real GitHub, opt-in)',
  skip: REAL_REPO && REAL_TOKEN ? false : 'set KILN_GITHUB_TEST_REPO and KILN_GITHUB_TEST_TOKEN to run against a throwaway repo',
  timeoutMs: 300_000,
  async setUp(t, kiln) {
    await clearRealRepo();
    const epic = await realCreate(CONTRACT_TREE.epic, 'The board becomes the home page.', ['kind:epic', 'stage:roadmap'], 'open');
    const story = await realCreate(CONTRACT_TREE.story, 'Show every Project on one board.', ['kind:story', 'stage:spec'], 'open', epic);
    await realCreate(CONTRACT_TREE.ready, 'One column per run state.', ['kind:ticket', 'stage:implementing', 'status:ready-for-agent'], 'open', story);
    await realCreate(CONTRACT_TREE.shipped, 'Patch the board over SSE.', ['kind:ticket', 'stage:shipped', 'status:done'], 'closed', story);
    await startGitHubWidget(t, kiln, { apiUrl: REAL_API, token: REAL_TOKEN!, pollMs: 5_000 });
    return registerGitHubProject(kiln, REAL_REPO!);
  },
  async recorded(title): Promise<RecordedItem | undefined> {
    const issue = await realRecorded(title);
    if (!issue) return undefined;
    const labels = issue.labels.map((l) => l.name);
    const value = (name: string) => labels.find((l) => l.startsWith(`${name}:`))?.slice(name.length + 1);
    const parent = await real<RealIssue | null>('GET', `/issues/${issue.number}/parent`).catch(() => null);
    return {
      title: issue.title,
      kind: value('kind') ?? '',
      stage: value('stage') ?? '',
      ...(value('status') ? { status: value('status') } : {}),
      ...(issue.body ? { description: issue.body } : {}),
      ...(parent ? { parent: parent.title } : {}),
    };
  },
  async renameOutside(title, to) {
    const issue = await realRecorded(title);
    if (!issue) throw new Error(`No issue titled "${title}"`);
    await real('PATCH', `/issues/${issue.number}`, { title: to });
  },
});
