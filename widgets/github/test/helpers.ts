// Test helpers for the GitHub Widget: install it from a copy of the public repo, hand it its token as
// a Platform secret, and seed a fake GitHub with the standard Item tree. No test talks to the real
// GitHub unless it is the opt-in run (see tracker-contract.test.ts).
import { execFileSync } from 'node:child_process';
import { cpSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Item, Project, WidgetSecrets } from '@kiln/widget-sdk';
import { createTempRepo, onCleanup, type Cleanup, type TestKiln } from '@kiln/testing';
import { writeRepoFile } from '@kiln/testing/scratch';
import type { FakeGitHub, FakeIssue } from '@kiln/testing/fake-github';
import { CONTRACT_TREE, waitForItems, type RecordedItem } from '@kiln/testing/tracker-contract';

const HERE = dirname(fileURLToPath(import.meta.url));
const WIDGET_DIR = resolve(HERE, '..');

/** A throwaway copy of the public repo holding the Widget at `widgets/github`. */
export function publicRepo(t: Cleanup): string {
  const repo = createTempRepo(t);
  cpSync(WIDGET_DIR, join(repo.path, 'widgets', 'github'), { recursive: true, filter: (src) => !src.includes('node_modules') });
  repo.git('add', '.');
  repo.git('commit', '-q', '-m', 'GitHub Widget');
  return repo.path;
}

/** Removes one entry of the Windows credential store, the way an Admin could. */
const removeFromVault = (resource: string, account: string) => {
  const script = `
    [void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]
    $v = New-Object Windows.Security.Credentials.PasswordVault
    try { $c = $v.Retrieve('${resource}', '${account}') } catch { exit 0 }
    $v.Remove($c)`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
};

/**
 * Installs the GitHub Widget pointed at `apiUrl`, enters `token` as its `github-token` secret (removed
 * from the OS credential store when the test ends), approves it and waits until it is ready.
 */
export async function startGitHubWidget(t: Cleanup, kiln: TestKiln, options: { apiUrl: string; token: string; pollMs?: number }) {
  const events = await kiln.events();
  await kiln.api('POST', '/api/widgets', {
    source: publicRepo(t),
    path: 'widgets/github',
    config: { apiUrl: options.apiUrl, pollMs: options.pollMs ?? 100 },
  });
  await kiln.api('PUT', '/api/widgets/github/secrets/github-token', { value: options.token });
  const secrets = await kiln.api<WidgetSecrets>('GET', '/api/widgets/github/secrets');
  onCleanup(t, 'remove the test GitHub token from the credential store', () => {
    if (process.platform === 'win32') for (const e of secrets.entries) removeFromVault(e.location.resource, e.location.account);
  });
  await kiln.api('POST', '/api/widgets/github/approve');
  await events.next('widget.ready', { timeoutMs: 15_000 });
  events.close();
}

/** The standard contract tree as issues: kinds, Stages and Statuses as labels, parents as sub-issues. */
export function seedIssues(fake: FakeGitHub) {
  const epic = fake.addIssue({ title: CONTRACT_TREE.epic, body: 'The board becomes the home page.', labels: ['kind:epic', 'stage:roadmap'] });
  const story = fake.addIssue({ title: CONTRACT_TREE.story, body: 'Show every Project on one board.', labels: ['kind:story', 'stage:spec'], parent: epic.number });
  const ready = fake.addIssue({
    title: CONTRACT_TREE.ready,
    body: 'One column per run state.',
    labels: ['kind:ticket', 'stage:implementing', 'status:ready-for-agent', 'area:board'],
    parent: story.number,
  });
  const shipped = fake.addIssue({
    title: CONTRACT_TREE.shipped,
    body: 'Patch the board over SSE.',
    labels: ['kind:ticket', 'stage:shipped', 'status:done'],
    state: 'closed',
    parent: story.number,
  });
  return { epic, story, ready, shipped };
}

/** Registers the test repo as a Project kept in GitHub Issues, and waits for its Items. */
export async function registerGitHubProject(kiln: TestKiln, repo: string, settings: Record<string, unknown> = {}): Promise<Project> {
  writeRepoFile(kiln.repo, '.kiln/settings.json', JSON.stringify({ testCommand: 'node --version', tracker: 'github', github: { repo }, ...settings }));
  kiln.repo.git('add', '.');
  kiln.repo.git('commit', '-q', '-m', 'Keep Items in GitHub Issues');
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  await waitForItems(kiln, project.id, Object.values(CONTRACT_TREE));
  return project;
}

const labelValue = (labels: string[], name: string) => labels.find((l) => l.startsWith(`${name}:`))?.slice(name.length + 1);

/** What GitHub holds for one issue, in the contract's terms. */
export function recordOf(fake: FakeGitHub, issue: FakeIssue): RecordedItem {
  const status = labelValue(issue.labels, 'status');
  const parent = issue.parent === undefined ? undefined : fake.issue(issue.parent).title;
  return {
    title: issue.title,
    kind: labelValue(issue.labels, 'kind') ?? '',
    stage: labelValue(issue.labels, 'stage') ?? '',
    ...(status ? { status } : {}),
    ...(issue.body ? { description: issue.body } : {}),
    ...(parent ? { parent } : {}),
  };
}

export const byTitle = (items: Item[], title: string): Item => {
  const item = items.find((i) => i.title === title);
  if (!item) throw new Error(`No Item titled "${title}"`);
  return item;
};
