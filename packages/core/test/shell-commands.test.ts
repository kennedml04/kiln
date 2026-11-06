// Which shell commands Kiln treats as worktree reads and writes, so a Session needs no Permission
// Ask for an `ls`, and which stay ordinary commands for the Policy (the Project template asks).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectPolicyTemplate, effectivePolicy, shellRequest, staysInside, worktreeEffect, ORG_POLICY_DEFAULT, PROJECT_THREAD_POLICY } from '@kiln/widget-sdk';

const worktree = 'C:\\kiln-wt\\story-x';
const outside = 'C:/kiln-wt/elsewhere/notes.txt';
const projectPolicy = effectivePolicy([{ actions: ORG_POLICY_DEFAULT, rules: [] }, projectPolicyTemplate(false)]);
const bash = (command: string, policy = projectPolicy) => shellRequest(policy, worktree, command);

test('paths are judged as text, on Windows and posix worktrees alike', () => {
  assert.equal(staysInside(worktree, 'packages/core'), true);
  assert.equal(staysInside(worktree, '/c/KILN-WT/story-x/x.md'), true, 'Git Bash path, any case');
  assert.equal(staysInside(worktree, 'C:\\kiln-wt\\story-xy'), false, 'a sibling with the same prefix');
  assert.equal(staysInside(worktree, 'a/../../story-x/b'), true);
  assert.equal(staysInside(worktree, 'D:x'), false);
  assert.equal(staysInside('/srv/k/wt', 'src/../README.md'), true);
  assert.equal(staysInside('/srv/k/wt', '/srv/k/WT/x'), false, 'posix paths keep their case');
  assert.equal(staysInside('/srv/k/wt', '../../../etc/passwd'), false);
});

test('commands that only read the worktree are reads', () => {
  for (const command of [
    'ls',
    'ls .scratch',
    'ls -a .kiln 2>&1',
    'cat .kiln/settings.json',
    'cat .scratch/local-first/issues/07*.md .scratch/local-first/issues/09*.md',
    'head -40 packages/core/src/db.ts',
    'wc -l packages/core/src/db.ts',
    "find . -path ./node_modules -prune -o -ipath '*local-first*' -print",
    'grep -n "THREAD_TYPES" -A6 packages/core/src/flow/session-manager.ts',
    'grep -H "^\\*\\*Status" .scratch/local-first/issues/*.md',
    'grep -A1 -E "typecheck|check$"',
    'grep -rln "chatThreadId\\|scratch-chat" packages widgets --include=*.ts --include=*.tsx',
    'sed -n 195,260p packages/core/src/db.ts',
    "sed -n '195,260p' packages/core/src/db.ts",
    "sed -n '/^## Done/,$p' .scratch/x/story.md",
    "sed 's/foo/bar/g' README.md",
    'git status -s',
    'git log --oneline -60',
    'git log --oneline --all -i --grep=variant',
    'git log --oneline -3 -- widgets/claude-code',
    'git --no-pager log -5',
    'git diff HEAD~1 local-first-03 --stat',
    'git diff main...HEAD --stat',
    'git show demo-project:.scratch/demo-project/issues/09-first-live-run-by-hand.md',
    'git ls-tree -r --name-only demo-project',
    'git branch -a',
    'git branch --list master main',
    'git rev-parse HEAD',
    'git worktree list',
    'cd packages/core/src/flow',
    `cd "${worktree.split('\\').join('/')}"`,
    'cd .',
    'Get-ChildItem widgets/claude-code/src',
    'Get-Content packages/core/src/db.ts | Select-Object -First 10',
    'pwd',
    'echo ---',
    'echo done $?',
    'echo "exit: $?"',
  ]) {
    assert.equal(worktreeEffect(command, worktree), 'read', command);
    assert.deepEqual(bash(command)?.decision, 'allow', command);
  }
});

test('commands that only change files in the worktree are writes', () => {
  for (const command of [
    'git add .scratch/scratch-chat/grill.md',
    'git add -A',
    'git commit -qm "story-flow: give the full-Workflow test room"',
    'git checkout --ours .kiln/policy.json',
    'git restore packages/core/src/db.ts',
    'mkdir -p .scratch/demo-project',
    'mkdir .kiln',
    "cat > packages/core/test/role-modes.test.ts <<'EOF'",
    'sed -i s/a/b/ file.ts',
    "sed -i 's|^  layerDecision,$|  CHAT_POLICY,\\n  layerDecision,|' policy/policy.ts",
    `sed -i "s|{ content: { decided: string\\[\\] } }\\[\\]|{ decided: string[] }[]|; s|digests.map((d) => d.content.decided)|digests.map((d) => d.decided)|" packages/core/test/scratch-chat.test.ts`,
    `sed -i "0,/{ do: 'wait_for_message' }, { do: 'finish'/s//{ do: 'wait_for_message' }, { do: 'finish'/" packages/core/test/scratch-chat.test.ts`,
    "sed -i '903s/.*/            digests: (() => { const store = knowledgeFor(item); return store.seed(item); })(),/' packages/core/src/flow/session-manager.ts",
    "sed -i 's/chats\\.touch(id);/chats.touch(id, clock.now());/; s/chats\\.open(ownerOf(), text)/chats.open(ownerOf(), text, clock.now())/' packages/core/src/chats/routes.ts",
    "sed -i.bak -e 's/a/b/g' -e '/^$/d' README.md",
  ]) {
    assert.equal(worktreeEffect(command, worktree), 'write', command);
  }
  const heredoc = "cat > packages/core/test/x.test.ts <<'EOF'\nimport { test } from 'node:test';\nrm -rf /\nEOF";
  assert.equal(bash(heredoc)?.decision, 'allow', 'a quoted heredoc body is data');
  assert.equal(bash(heredoc)?.action, 'worktree_write');
});

test('anything else still asks under the Project template', () => {
  for (const command of [
    'rm -rf packages',
    'node scripts/publish.ts --push',
    'npm test',
    `cat "${outside}"`,
    'cat ../../secrets.txt',
    'cd ../../..',
    'cd',
    'cd /c/Windows',
    'ls -d "$TEMP"/kiln-scratch-repo 2>&1',
    'cat ~/.ssh/id_rsa',
    'cat x > ../y',
    'echo hi > /etc/notes.md',
    'echo $(rm -rf packages)',
    'echo `whoami`',
    'find . -name "*.tmp" -delete',
    'find . -exec rm {} ;',
    "sed -i 's/a/b/w /tmp/out' file.ts",
    "sed -i 's/a/b/e' file.ts",
    "sed -i '1r /etc/passwd' file.ts",
    "sed -i 'e rm -rf /' file.ts",
    "sed -i 's/a/b/' ../../other.ts",
    "sed -i 's/a/b/'",
    'sed -i -f edits.sed file.ts',
    "sed -n '1w /tmp/out' file.ts",
    'sed -i s/a/b\\/w file.ts',
    'git diff --no-index /etc/passwd x',
    'git diff --output=out.txt',
    'git -c core.pager=evil log',
    'git branch new-branch',
    'git branch -D old',
    'git checkout -b main',
    'git commit --no-verify -m x',
    'git push',
    "cat > /etc/edit.mjs <<'EOF'",
    'cat > notes.md <<EOF',
    'rg --pre ./run.sh foo',
    "$p='packages/core/src/flow/session-manager.ts'",
    'cat /tmp/../etc/passwd',
    'cat tmp/../../x',
    'cd /tmp',
    'timeout 120 rm -rf packages',
    '(rm -rf packages)',
    'FOO=1 git log',
    'git rebase main',
    'git merge -s ours main',
    'git checkout -f packages/x.ts',
    'pkill -f archive.test',
    'f=$(rm -rf packages)',
    'tail -f log.txt',
    'grep "$HOME" notes.md',
    'grep "${x}" notes.md',
  ]) {
    assert.equal(worktreeEffect(command, worktree), undefined, command);
    assert.notEqual(bash(command)?.decision, 'allow', command);
  }
});

const tmp = 'D:/scratch/Temp';
const scratchBash = (command: string, policy = projectPolicy) => shellRequest(policy, worktree, command, [tmp, '/tmp']);

test('the temp folder is scratch: reads and writes there need no Ask', () => {
  for (const command of [
    'tail -c 600 /tmp/full.out',
    'grep -nE "^✖|^ℹ (fail|pass)|not ok" /tmp/t.log',
    'sed -n 225,260p /tmp/t.log',
    `cat "${tmp}/claude/4f73/4929/tasks/b4edr95kp.output"`,
    `tail -14 ${tmp}/claude/4f73/4929/tasks/b4edr95kp.output`,
    '[ -s /tmp/time8.log ]',
  ]) {
    assert.equal(worktreeEffect(command, worktree, [tmp, '/tmp']), 'read', command);
    assert.equal(scratchBash(command)?.decision, 'allow', command);
  }
  for (const command of [
    "cat > /tmp/edit.mjs <<'EOF'",
    "sed -i 's/a/b/' /tmp/dbg.test.ts",
    'git log --oneline > /tmp/log.txt 2>&1',
    'echo hi > notes.md',
    'cat x > y',
    'git show master:x.ts > packages/x.ts',
  ]) {
    assert.equal(worktreeEffect(command, worktree, [tmp, '/tmp']), 'write', command);
    assert.equal(scratchBash(command)?.decision, 'allow', command);
  }
  assert.equal(worktreeEffect('cat /tmp/x', worktree), undefined, 'no scratch folders, no scratch');
});

test('wrappers, loops and branches are judged by the commands inside them', () => {
  const rules = effectivePolicy([
    { actions: ORG_POLICY_DEFAULT, rules: [] },
    { ...projectPolicyTemplate(false), rules: [{ action: 'other_commands', match: 'npm *', decision: 'allow' }, { action: 'other_commands', match: 'node *', decision: 'allow' }] },
  ]);
  for (const command of [
    'timeout 120 node --test --test-name-pattern="single Unarchive" packages/core/test/archive.test.ts 2>&1',
    '(npm test > /tmp/full.out 2>&1; echo done >> /tmp/full.out) &',
    '(time npm run test:only > /tmp/t8.log 2>&1) 2> /tmp/time8.log',
    '(npm ci > /tmp/ci.log 2>&1 &)',
    "until grep -q '^done' /tmp/full.out; do sleep 10; done; grep -E \"^ℹ (pass|fail)\" /tmp/full.out",
    'until [ -s /tmp/time8.log ]; do sleep 5; done',
    'for f in a.md b.md; do grep -c x "$f"; done',
    'for b in 07 08 09; do cat .scratch/x/issues/$b.md; done',
    'if ($?) { git commit -m "Up next reorder: grill record" }',
    'GIT_EDITOR=true git rebase --continue 2>&1',
    'git merge --no-edit master',
    'git stash pop',
    'nproc',
    'node /tmp/edit.mjs',
  ]) {
    assert.equal(scratchBash(command, rules)?.decision, 'allow', command);
  }
  for (const command of [
    'for f in ../../secret x; do cat "$f"; done',
    'until grep -q x /tmp/a; do rm -rf packages; done',
    'timeout 50 git push',
  ]) {
    assert.notEqual(scratchBash(command, rules)?.decision, 'allow', command);
  }
});

test('deleting files in the worktree is a write; folders, .git and anything outside it still ask', () => {
  for (const command of ['rm packages/core/test/old.test.ts', 'rm -f a.ts b.ts', 'rm -fv -- -odd.ts', 'rm .scratch/x/*.md', 'rm packages/x/../y.ts']) {
    assert.equal(worktreeEffect(command, worktree), 'write', command);
    assert.equal(bash(command)?.decision, 'allow', command);
  }
  for (const command of [
    'rm -rf packages',
    'rm -r .scratch',
    'rm -i x.ts',
    'rm',
    `rm ${outside}`,
    'rm ../other/x.ts',
    'rm packages/../../x.ts',
    'rm .git',
    'rm sub/.git',
    'rm .gi?',
    'rm .*',
    'rm .[g]it',
    'rm /tmp/x.log',
    'rm $f',
  ]) {
    assert.equal(worktreeEffect(command, worktree, [tmp, '/tmp']), undefined, command);
    assert.notEqual(scratchBash(command)?.decision, 'allow', command);
  }
});

test('git checkout of revisions and paths inside the worktree is a write', () => {
  for (const command of [
    'git checkout main',
    'git checkout -q HEAD~1',
    'git checkout -q kiln/ticket/board-reset/02',
    'git checkout package.json',
    'git checkout packages/core/test/threads.test.ts',
    'git checkout -- package.json',
    'git checkout --theirs -- .kiln/policy.json',
    'git checkout --detach main',
    'git checkout .',
  ]) {
    assert.equal(worktreeEffect(command, worktree), 'write', command);
    assert.equal(bash(command)?.decision, 'allow', command);
  }
  for (const command of [
    'git checkout -b new',
    'git checkout -B new',
    'git checkout -f main',
    'git checkout --force main',
    'git checkout -p',
    'git checkout --orphan x',
    'git checkout --pathspec-from-file=list.txt',
    'git checkout -qf main',
    `git checkout -- ${outside}`,
    'git checkout ../other/x.ts',
    'git checkout $branch',
  ]) {
    assert.equal(worktreeEffect(command, worktree), undefined, command);
    assert.notEqual(bash(command)?.decision, 'allow', command);
  }
});

test('git branch with a listing filter only lists', () => {
  for (const command of ['git branch --contains 3945fc9', 'git branch -a --merged main', 'git branch --no-merged', 'git branch --points-at HEAD']) {
    assert.equal(worktreeEffect(command, worktree), 'read', command);
  }
  assert.equal(worktreeEffect('git branch --contains x -D y', worktree), undefined);
});

const sub = `${worktree}\\packages\\core\\src`;
const bashIn = (cwd: string, command: string, policy = projectPolicy) => shellRequest(policy, worktree, command, [tmp, '/tmp'], { cwd });

test('relative paths are judged from the folder the command runs in', () => {
  for (const command of ['grep -rn "x" ../../widget-sdk/src/*.ts', 'wc -l ../*', 'cat ../../../README.md', 'ls', 'git add ../test/x.test.ts', 'rm ../test/old.test.ts']) {
    assert.notEqual(worktreeEffect(command, worktree, [], { cwd: sub }), undefined, command);
    assert.equal(bashIn(sub, command)?.decision, 'allow', command);
  }
  for (const command of ['cat ../../../../secret.txt', 'rm ../../../../x.ts', 'cd ../../../..']) {
    assert.equal(worktreeEffect(command, worktree, [], { cwd: sub }), undefined, command);
    assert.notEqual(bashIn(sub, command)?.decision, 'allow', command);
  }
  // A Session whose shell already stands outside the worktree is not judged as in it.
  const elsewhere = 'C:\\kiln-wt\\elsewhere';
  for (const command of ['ls', 'git add -A', 'git log -3', 'cat notes.txt']) {
    assert.notEqual(bashIn(elsewhere, command)?.decision, 'allow', command);
  }
});

test('a cd changes the folder the commands after it are judged from', () => {
  assert.equal(bash('cd packages && cat ../README.md')?.decision, 'allow');
  assert.equal(bash('cd packages/core && grep -n x ../widget-sdk/src/policy.ts')?.decision, 'allow');
  // From the root this would be the worktree's own README; from packages it is outside.
  assert.notEqual(bash('cd packages && cat ../../kiln-wt/story-x/x')?.decision, 'allow');
  // A cd that might not have run (`;`, `||`, a subshell) leaves both folders possible.
  assert.notEqual(bash('cd packages; cat ../README.md')?.decision, 'allow');
  assert.notEqual(bash('cd packages && ls || cat ../README.md')?.decision, 'allow');
  assert.notEqual(bash('(cd packages && ls) && cat ../README.md')?.decision, 'allow');
  assert.notEqual(bash('ls | cd packages && cat ../README.md')?.decision, 'allow');
  // A cd a rule allows to a folder outside the worktree: what follows is outside too.
  const cdAnywhere = effectivePolicy([
    { actions: ORG_POLICY_DEFAULT, rules: [] },
    { ...projectPolicyTemplate(false), rules: [{ action: 'other_commands', match: 'cd *', decision: 'allow' }] },
  ]);
  for (const command of ['cd /c/kiln-wt/elsewhere && git add -A', 'cd ../.. && ls', 'cd "$X" && git add -A', 'cd && ls', 'cd - && git commit -m x']) {
    assert.notEqual(bash(command, cdAnywhere)?.decision, 'allow', command);
  }
  assert.equal(bash('cd /c/kiln-wt/story-x/packages && ls', cdAnywhere)?.decision, 'allow');
});

test('a plain assignment, and a substitution that only reads, set a variable', () => {
  const rules = effectivePolicy([
    { actions: ORG_POLICY_DEFAULT, rules: [] },
    { ...projectPolicyTemplate(false), rules: [{ action: 'other_commands', match: 'pgrep *', decision: 'allow' }] },
  ]);
  for (const command of [
    'f=packages/core/src/db.ts',
    `f="${tmp}/claude/x/tasks/b4.output"`,
    'F=x',
    'n=',
    'f=$(ls -t .scratch/*/spec.md)',
    'n="$(git rev-parse HEAD)"',
    'for i in $(seq 1 55); do echo $i; done',
    'seq 1 57',
    `f="${tmp}/claude/x/tasks/b4.output"; tail -5 "$f"`,
    'f=packages/x.ts && grep -n foo $f',
    'while pgrep -f node-test > /dev/null; do sleep 5; done',
  ]) {
    assert.equal(scratchBash(command, rules)?.decision, 'allow', command);
  }
  for (const command of [
    'PATH=/c/evil',
    'GIT_DIR=../x',
    'path=/c/evil',
    'x=1 git push',
    'f=$(rm -rf packages)',
    'f=$(ls ../..)',
    `f=${outside} && cat $f`,
    'f=$(ls) && cat $f',
    'cat $(ls)',
    'for f in $(ls); do rm "$f"; done',
    'echo $(rm -rf packages)',
  ]) {
    assert.notEqual(scratchBash(command, rules)?.decision, 'allow', command);
  }
});

test('sed scripts that only append, insert, change, transliterate or branch are plain', () => {
  for (const command of [
    `sed -i "s|\\"GET\\"|'GET'|" packages/x.ts`,
    `sed -i '/^import/a import { x } from "y";' a.ts`,
    "sed -i '3i // header' a.ts",
    "sed -i '5c replaced line' a.ts",
    "sed -i '1a\\\nfirst\\\nsecond' a.ts",
    "sed -i 'y/abc/xyz/' a.ts",
    "sed -i '/start/,/end/{/x/d}' a.ts",
    "sed -i '/start/,+2d; 1~2s/a/b/' a.ts",
    "sed -i ':a;N;$!ba;s/\\n/ /g' a.ts",
  ]) {
    assert.equal(worktreeEffect(command, worktree), 'write', command);
  }
  for (const command of ["sed -i '/x/{r /etc/passwd\n}' a.ts", "sed -i '/x/W out' a.ts", "sed -i '/x/{s/a/b/w out\n}' a.ts", "sed -i '1a text' ../x.ts"]) {
    assert.equal(worktreeEffect(command, worktree), undefined, command);
  }
});

test("the Session's own read roots are read, not written", () => {
  const own = 'E:/claude-home/projects/C--kiln-wt-story-x/s-1';
  const where = { readRoots: [own] };
  assert.equal(shellRequest(projectPolicy, worktree, `cat "${own}/tool-results/t1.txt"`, [], where)?.decision, 'allow');
  assert.notEqual(shellRequest(projectPolicy, worktree, `echo x > "${own}/x.txt"`, [], where)?.decision, 'allow');
  assert.notEqual(shellRequest(projectPolicy, worktree, `rm "${own}/x.txt"`, [], where)?.decision, 'allow');
});

test('the strictest command of a line decides', () => {
  assert.equal(bash('ls && git log -3')?.decision, 'allow');
  const mixed = bash('ls && rm -rf packages');
  assert.equal(mixed?.decision, 'ask');
  assert.equal(mixed?.detail, 'rm -rf packages');
});

test('an Ask about a script fed by a heredoc shows the script', () => {
  const line = "python - <<'EOF'\nprint('hi')\nEOF";
  const request = bash(line);
  assert.equal(request?.decision, 'ask');
  assert.equal(request?.detail, line);
});

test('a rule that names a command still holds over the read', () => {
  const policy = effectivePolicy([
    { actions: ORG_POLICY_DEFAULT, rules: [{ action: 'other_commands', match: 'cat secrets*', decision: 'deny' }] },
    projectPolicyTemplate(false),
  ]);
  assert.equal(bash('cat secrets.env', policy)?.decision, 'deny');
  assert.equal(bash('cat README.md', policy)?.decision, 'allow');
});

test('a Stage that denies writes denies the shell writes too', () => {
  const thread = effectivePolicy([{ actions: ORG_POLICY_DEFAULT, rules: [] }, projectPolicyTemplate(false), PROJECT_THREAD_POLICY]);
  assert.equal(bash('git log -3', thread)?.decision, 'allow');
  assert.equal(bash('git add -A', thread)?.decision, 'deny');
  assert.equal(bash('npm test', thread)?.decision, 'deny');
});

test('no command that commits a Co-Authored-By trailer is allowed, whatever the Policy', () => {
  const open = effectivePolicy([{ actions: ORG_POLICY_DEFAULT, rules: [] }]);
  for (const command of [
    'git commit -m "x\n\nCo-Authored-By: Someone <a@b.c>"',
    'git commit -qm "fix" -m "co-authored-by: Someone <a@b.c>"',
    'gh pr create --body "Co-Authored-By: Someone <a@b.c>"',
  ]) {
    assert.equal(bash(command, open)?.decision, 'deny', command);
  }
  assert.equal(bash('git log --format=%B | grep -i co-authored-by', open)?.decision, 'allow', 'looking for trailers is fine');
});
