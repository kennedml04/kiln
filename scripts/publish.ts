// Publish the trunk to GitHub: `node scripts/publish.ts [--from <branch>] [--push]`.
//
// GitHub's `main` is built from the local `publish-main` branch, a separate history: one commit per
// first-parent commit of the trunk, with the public noreply identity and the trunk commit's exact tree.
// Without --push it only shows what it would publish and runs the checks.
//
// Steps: find the newest trunk commit whose tree publish-main already holds; write one commit per later
// first-parent commit (merge subjects become the merged work's own message); refuse any attribution
// trailer; run scripts/check-banned.ts over the new tree and the new messages; then, with --push, move
// publish-main and push it to public/main with --force-with-lease.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NAME = 'kennedml04';
const EMAIL = '55002497+kennedml04@users.noreply.github.com';
const PUBLIC = 'publish-main';
const REMOTE = 'public';
const TRAILER = /co-authored-by:[^<\n]*<[^>\n]*>/i;

const args = process.argv.slice(2);
const push = args.includes('--push');
const fromAt = args.indexOf('--from');
const git = (...a: string[]) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 1 << 28 }).trimEnd();
const from = fromAt >= 0 ? args[fromAt + 1] : git('rev-parse', '--abbrev-ref', 'HEAD');

const fail = (why: string): never => {
  console.error(`publish: ${why}`);
  process.exit(1);
};

const publicTip = git('rev-parse', PUBLIC);
const publicTree = git('rev-parse', `${PUBLIC}^{tree}`);
const trunk = git('rev-list', '--first-parent', from).split('\n');
const baseAt = trunk.findIndex((sha) => git('rev-parse', `${sha}^{tree}`) === publicTree);
if (baseAt < 0) fail(`no commit on ${from}'s first-parent line has ${PUBLIC}'s tree; publish by hand once to line them up.`);
const todo = trunk.slice(0, baseAt).reverse();
if (todo.length === 0) {
  console.log(`Nothing to publish: ${PUBLIC} already holds ${from}.`);
  process.exit(0);
}

// "Merge branch 'x' into y" takes the merged tip's message; "Merge x: rest" becomes "Rest".
const messageOf = (sha: string) => {
  const parents = git('rev-list', '--parents', '-n', '1', sha).split(' ').slice(1);
  const message = git('log', '-1', '--format=%B', sha);
  const [subject, ...body] = message.split('\n');
  if (parents.length < 2) return message;
  if (/^Merge branch '[^']+'/.test(subject)) return git('log', '-1', '--format=%B', parents[1]);
  const named = /^Merge [^\s:]+: (.+)$/.exec(subject);
  if (named) return [named[1][0].toUpperCase() + named[1].slice(1), ...body].join('\n').trimEnd();
  return message;
};

// Live Kiln's "Always allow" commits a Project Policy rule to the trunk, and a rule can name a
// folder on this PC (`cd C:/Users/...`). The public history leaves such rules out of
// .kiln/policy.json and says only what kind of rule it was; the trunk itself must drop them before
// it publishes, since the public tip's tree must be the trunk's.
const POLICY = '.kiln/policy.json';
const LOCAL_PATH = /[a-z]:(\\\\|\\|\/)+(Users|home)(\\\\|\\|\/)|\/(Users|home)\//i;
const index = join(tmpdir(), `kiln-publish-index-${process.pid}`);
const publicTreeOf = (sha: string) => {
  const tree = git('rev-parse', `${sha}^{tree}`);
  let text: string;
  try {
    text = git('show', `${tree}:${POLICY}`);
  } catch {
    return tree;
  }
  if (!LOCAL_PATH.test(text)) return tree;
  const doc = JSON.parse(text) as { rules?: { match?: string }[] };
  doc.rules = (doc.rules ?? []).filter((r) => !LOCAL_PATH.test(r.match ?? ''));
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { input: `${JSON.stringify(doc, null, 2)}\n`, encoding: 'utf8' }).trim();
  const env = { ...process.env, GIT_INDEX_FILE: index };
  execFileSync('git', ['read-tree', tree], { env });
  execFileSync('git', ['update-index', '--cacheinfo', `100644,${blob},${POLICY}`], { env });
  return execFileSync('git', ['write-tree'], { env, encoding: 'utf8' }).trim();
};
const publicMessage = (message: string) => {
  const rule = /^Kiln: always allow (\S+) /.exec(message);
  return rule && LOCAL_PATH.test(message) ? `Kiln: always allow ${rule[1]} (a rule that named a local folder, left out here)` : message;
};

const commits = todo.map((sha) => ({ sha, tree: publicTreeOf(sha), date: git('log', '-1', '--format=%aI', sha), message: publicMessage(messageOf(sha)) }));
await rm(index, { force: true });
for (const c of commits) if (TRAILER.test(c.message)) fail(`${c.sha.slice(0, 7)} carries a Co-Authored-By trailer; reword it on ${from} first.`);

// The checks run over exactly what goes public: the new tip's tree, plus the new messages as a text file.
const scratch = mkdtempSync(join(tmpdir(), 'kiln-publish-'));
try {
  const tarball = execFileSync('git', ['archive', '--format=tar', commits.at(-1)!.tree], { maxBuffer: 1 << 30 });
  execFileSync('tar', ['-x', '-f', '-', '-C', scratch], { input: tarball });
  writeFileSync(join(scratch, 'publish-messages.txt'), commits.map((c) => c.message).join('\n\n'));
  try {
    execFileSync('node', [join(import.meta.dirname, 'check-banned.ts')], { cwd: scratch, stdio: 'inherit' });
  } catch {
    fail('check-banned refused the tree or a message (publish-messages.txt is the commit messages).');
  }
} finally {
  await rm(scratch, { recursive: true, force: true, maxRetries: 5 });
}

console.log(`${commits.length} commit(s) from ${from} onto ${PUBLIC} (${publicTip.slice(0, 7)}):`);
for (const c of commits) console.log(`  ${c.sha.slice(0, 7)}  ${c.message.split('\n')[0]}`);
if (!push) {
  console.log('Checks passed. Run again with --push to publish.');
  process.exit(0);
}

const remoteTip = git('ls-remote', REMOTE, 'refs/heads/main').split('\t')[0];
if (remoteTip !== publicTip) fail(`${REMOTE}/main is ${remoteTip.slice(0, 7)}, not ${PUBLIC}'s ${publicTip.slice(0, 7)}; line them up by hand first.`);

let parent = publicTip;
for (const c of commits) {
  const env = { ...process.env, GIT_AUTHOR_NAME: NAME, GIT_AUTHOR_EMAIL: EMAIL, GIT_COMMITTER_NAME: NAME, GIT_COMMITTER_EMAIL: EMAIL, GIT_AUTHOR_DATE: c.date, GIT_COMMITTER_DATE: c.date };
  parent = execFileSync('git', ['commit-tree', c.tree, '-p', parent, '-F', '-'], { input: c.message + '\n', env, encoding: 'utf8' }).trim();
}
if (git('rev-parse', `${parent}^{tree}`) !== git('rev-parse', `${from}^{tree}`)) fail(`the new tip's tree differs from ${from}'s; nothing was moved.`);
git('update-ref', `refs/heads/${PUBLIC}`, parent, publicTip);
git('push', `--force-with-lease=main:${publicTip}`, REMOTE, `${PUBLIC}:main`);
console.log(`Published ${parent.slice(0, 7)} to ${REMOTE}/main.`);
