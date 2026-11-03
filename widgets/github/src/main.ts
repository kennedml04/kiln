// The GitHub Widget process: GitHub Issues as a Tracker, and pull requests for PR-mode Projects.
//
// The core asks it, down the command stream (`widget.request`), to list, create or move a Project's
// records and to open a pull request; it answers on POST /api/widget/replies. It polls GitHub and
// tells the core when a Project's issues changed or when a pull request it opened was merged.
//
// It talks to the core over the plain Widget API with `fetch` and imports only types from the SDK
// (erased at run time), so it runs from a clone of the public repo that has no node_modules.
//
// The token is the Platform-held `github-token` secret, read from the core; it is never written to
// disk. Config (KILN_WIDGET_CONFIG), both optional:
//   apiUrl   the GitHub REST API, default https://api.github.com
//   pollMs   how often to look for changes on GitHub, default 15000
import { execFile } from 'node:child_process';
import type {
  OpenedPullRequest,
  OpenPullRequestRequest,
  PullRequestRecord,
  SecretValue,
  TrackerCreateRequest,
  TrackerProjectRef,
  TrackerWriteStage,
  WidgetCommand,
  WidgetRequestCommand,
} from '@kiln/widget-sdk';
import { createRecord, fingerprint, gitHubClient, listRecords, writeStage } from './github.ts';

interface GitHubConfig {
  apiUrl?: string;
  pollMs?: number;
}

const env = process.env;
const api = env.KILN_API_URL;
const config = JSON.parse(env.KILN_WIDGET_CONFIG || '{}') as GitHubConfig;
const pollMs = Math.max(50, config.pollMs ?? 15_000);

const auth = { authorization: `Bearer ${env.KILN_WIDGET_TOKEN}` };
const call = async <T = unknown>(method: string, path: string, body?: unknown): Promise<T> => {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: { ...auth, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
};

let token: string | undefined;
const readToken = async (fresh: boolean) => {
  if (!token || fresh) {
    try {
      token = (await call<SecretValue>('GET', '/api/widget/secrets/github-token')).value;
    } catch {
      throw new Error('The GitHub Widget has no github-token secret: an Admin enters it on the Widget page');
    }
  }
  return token;
};
const github = gitHubClient(config.apiUrl ?? 'https://api.github.com', readToken);

const repoOf = (project: TrackerProjectRef) => {
  const repo = project.settings.github?.repo;
  if (!repo) throw new Error('The Project has no github.repo setting');
  return repo;
};

/** The Projects the core has asked about, by id, and what their issues looked like last. */
const projects = new Map<string, { project: TrackerProjectRef; seen?: string }>();
const remember = (project: TrackerProjectRef) => {
  const known = projects.get(project.id);
  projects.set(project.id, { project, ...(known?.seen ? { seen: known.seen } : {}) });
};

const git = (cwd: string, args: string[]) =>
  new Promise<string>((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8', windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args.filter((a) => !a.startsWith('http.extraheader')).join(' ')} failed: ${stderr || err.message}`));
      else resolve(stdout.trim());
    });
  });

/** Pushes the branch, then proposes it. Only a github.com remote is handed the token. */
async function openPullRequest(request: OpenPullRequestRequest): Promise<OpenedPullRequest> {
  const repo = repoOf(request.project);
  const remoteUrl = await git(request.project.path, ['remote', 'get-url', request.remote]);
  const header = /^https:\/\/github\.com\//i.test(remoteUrl)
    ? ['-c', `http.extraheader=Authorization: Basic ${Buffer.from(`x-access-token:${await readToken(false)}`).toString('base64')}`]
    : [];
  await git(request.project.path, [...header, 'push', request.remote, `${request.branch}:refs/heads/${request.branch}`]);
  const pull = await github.openPull(repo, { title: request.title, body: request.body, head: request.branch, base: request.base });
  return { number: pull.number, url: pull.html_url };
}

async function answer(command: WidgetRequestCommand): Promise<unknown> {
  switch (command.op) {
    case 'tracker.list': {
      const { project } = command.payload as { project: TrackerProjectRef };
      remember(project);
      // What the core has now read is what the next poll compares with.
      const { records, all } = await listRecords(github, repoOf(project));
      projects.get(project.id)!.seen = fingerprint(all);
      return records;
    }
    case 'tracker.create': {
      const { project, input } = command.payload as TrackerCreateRequest;
      remember(project);
      return { key: await createRecord(github, repoOf(project), input) };
    }
    case 'tracker.writeStage': {
      const change = command.payload as TrackerWriteStage;
      remember(change.project);
      await writeStage(github, repoOf(change.project), change);
      return {};
    }
    case 'pr.open':
      return openPullRequest(command.payload as OpenPullRequestRequest);
    default:
      throw new Error(`The GitHub Widget does not answer ${String(command.op)}`);
  }
}

async function handle(command: WidgetRequestCommand) {
  let reply: { requestId: string; result?: unknown; error?: string };
  try {
    reply = { requestId: command.requestId, result: await answer(command) };
  } catch (err) {
    reply = { requestId: command.requestId, error: err instanceof Error ? err.message : String(err) };
  }
  await call('POST', '/api/widget/replies', reply).catch((err: unknown) => process.stderr.write(`${String(err)}\n`));
}

/** Tells the core about issues changed on GitHub and pull requests merged or closed there. */
async function poll() {
  for (const [id, entry] of projects) {
    try {
      const seen = fingerprint(await github.issues(repoOf(entry.project)));
      if (entry.seen !== seen) await call('POST', '/api/widget/trackers/changed', { projectId: id });
      entry.seen = seen;
    } catch (err) {
      process.stderr.write(`${String(err)}\n`);
    }
  }
  try {
    for (const record of await call<PullRequestRecord[]>('GET', '/api/widget/pull-requests')) {
      const pull = await github.pull(record.repo, record.number);
      const body = { projectId: record.projectId, number: record.number };
      if (pull.merged || pull.merged_at) await call('POST', '/api/widget/pull-requests/merged', body);
      else if (pull.state === 'closed') await call('POST', '/api/widget/pull-requests/closed', body);
    }
  } catch (err) {
    process.stderr.write(`${String(err)}\n`);
  }
  setTimeout(() => void poll(), pollMs);
}

/** Calls `onData` with the data of each SSE message until the stream ends. */
async function readSse(body: ReadableStream<Uint8Array>, onData: (data: string) => void) {
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
      let end: number;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const data = buffer
          .slice(0, end)
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        buffer = buffer.slice(end + 2);
        if (data) onData(data);
      }
    }
  } catch {
    // The core went away.
  }
}

await call('POST', '/api/widget/register', { agents: [] });
const stream = await fetch(`${api}/api/widget/commands`, { headers: auth });
if (!stream.ok || !stream.body) throw new Error(`Command stream failed: ${stream.status}`);
await call('POST', '/api/widget/ready');
setTimeout(() => void poll(), pollMs);
await readSse(stream.body, (data) => {
  const command = JSON.parse(data) as WidgetCommand;
  if (command.type === 'widget.stop') process.exit(0);
  if (command.type === 'widget.request') void handle(command);
});
// No command stream means no core: exit rather than linger.
process.exit(0);
