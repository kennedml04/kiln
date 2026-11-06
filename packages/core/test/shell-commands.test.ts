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
    'cat x > y',
    'echo hi > notes.md',
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
    'git checkout main',
    'git commit --no-verify -m x',
    'git push',
    "cat > /tmp/edit.mjs <<'EOF'",
    'cat > notes.md <<EOF',
    'rg --pre ./run.sh foo',
    'for b in 07 08 09',
    "$p='packages/core/src/flow/session-manager.ts'",
    'tail -f log.txt',
    'grep "$HOME" notes.md',
    'grep "${x}" notes.md',
  ]) {
    assert.equal(worktreeEffect(command, worktree), undefined, command);
    assert.notEqual(bash(command)?.decision, 'allow', command);
  }
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
