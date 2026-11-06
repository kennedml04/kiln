// The rule "Always allow" saves, the shapes the Permission review groups Asks by, and which
// commands count as killing processes by name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  alwaysAllowMatch,
  effectivePolicy,
  groupByRule,
  killsByName,
  projectPolicyTemplate,
  rulePattern,
  shellRequest,
  ORG_POLICY_DEFAULT,
} from '@kiln/widget-sdk';

// Built from parts, so this file names no home folder itself.
const home = ['C:', 'Users', 'someone'].join('/');

test('a command gets the narrowest prefix that covers its shape', () => {
  const cases: [string, string | undefined][] = [
    ['git checkout -q feature/x', 'git checkout -q *'],
    ['git commit -qm "Fix the thing"', 'git commit -qm *'],
    ['git log --oneline -5 master', 'git log --oneline *'],
    ['git stash list', 'git stash list'],
    ['git stash pop stash@{1}', 'git stash pop *'],
    ['npm run lint', 'npm run lint'],
    ['npm run test -- --grep x', 'npm run test *'],
    ['npm test', 'npm test'],
    ['npx tsc --noEmit -p packages/core', 'npx tsc --noEmit -p *'],
    ['gh pr view 12 --json title', 'gh pr view *'],
    ['docker compose up -d web', 'docker compose up -d *'],
    ['node scripts/check-banned.ts', 'node scripts/check-banned.ts'],
    ['node --test packages/core/test/policy.test.ts', 'node --test *'],
    ['uptime', 'uptime'],
    ['tasklist /FI "IMAGENAME eq node.exe"', 'tasklist *'],
  ];
  for (const [command, rule] of cases) assert.equal(rulePattern('other_commands', command), rule, command);
});

test('commands that delete, kill, force or run other code get no pattern', () => {
  for (const command of [
    'rm -rf dist',
    'pkill -f vite',
    'taskkill //F //IM node.exe',
    'kill 1234',
    'bash -c "npm test"',
    'powershell -Command Get-Process',
    'node -e "process.exit(1)"',
    'python -c "print(1)"',
    'xargs rm',
    'curl https://example.com',
    'git reset --hard HEAD~1',
    'git push origin main',
    'git worktree add ../x main',
    'git branch -D old',
    'git checkout -f main',
    'git -C ../other status',
    'gh api repos/o/r/issues -X POST',
    './scripts/run.sh',
    'cd packages && npm test',
    'cat package.json',
  ]) {
    assert.equal(rulePattern('other_commands', command), undefined, command);
  }
});

test('no rule names a local folder: Always allow is then not offered', () => {
  assert.equal(rulePattern('other_commands', `node ${home}/x.js`), undefined);
  assert.equal(alwaysAllowMatch('other_commands', `cd ${home}/projects`), undefined, 'the literal is refused too');
  assert.equal(alwaysAllowMatch('other_commands', `git log ${home}/x`), 'git log *', 'the pattern leaves the folder out');
  assert.equal(alwaysAllowMatch('outside_worktree', `${home}/notes.txt`), undefined);
  assert.equal(alwaysAllowMatch('other_commands', 'make build'), 'make *');
  assert.equal(alwaysAllowMatch('other_commands', './build.sh fast'), './build.sh fast', 'no pattern: saved as it stands');
  assert.equal(alwaysAllowMatch('network', 'example.com'), 'example.com');
});

test('a prefix rule allows arguments, not a command run inside them', () => {
  const policy = effectivePolicy([
    { actions: ORG_POLICY_DEFAULT, rules: [] },
    {
      ...projectPolicyTemplate(false),
      rules: [
        { action: 'other_commands', match: 'make build *', decision: 'allow' },
        { action: 'other_commands', match: 'make $(x)', decision: 'allow' },
      ],
    },
  ]);
  const run = (command: string) => shellRequest(policy, 'C:\\kiln-wt\\story-x', command).decision;
  assert.equal(run('make build fast'), 'allow');
  assert.equal(run('make build $(rm -rf src)'), 'ask');
  assert.equal(run('make build `rm -rf src`'), 'ask');
  assert.equal(run('make $(x)'), 'allow', 'an exact rule still matches');
});

test('kills by image name, not by PID', () => {
  for (const command of ['taskkill //F //IM node.exe', 'taskkill /im node.exe /f', 'pkill -f vite', 'killall node', 'Stop-Process -Name node', 'kill $(pgrep node)', 'pgrep node | xargs kill']) {
    assert.equal(killsByName(command), true, command);
  }
  for (const command of ['kill 1234', 'taskkill /PID 1234 /F', 'Stop-Process -Id 1234', 'pgrep -f vite', 'grep pkill notes.md']) {
    assert.equal(killsByName(command), false, command);
  }
});

test('answered Permission Asks group by the rule that would cover them', () => {
  const groups = groupByRule([
    { askId: 'a1', action: 'other_commands', detail: 'git checkout -q a', allowed: true },
    { askId: 'a2', action: 'other_commands', detail: 'git checkout -q b', allowed: true },
    { askId: 'a3', action: 'other_commands', detail: 'npm run lint', allowed: false },
    { askId: 'a4', action: 'other_commands', detail: 'rm -rf dist', allowed: true },
    { askId: 'a5', action: 'outside_worktree', detail: `${home}/x`, allowed: true },
  ]);
  assert.deepEqual(groups, [
    { action: 'other_commands', match: 'git checkout -q *', askIds: ['a1', 'a2'], details: ['git checkout -q a', 'git checkout -q b'], allAllowed: true },
    { action: 'other_commands', match: 'npm run lint', askIds: ['a3'], details: ['npm run lint'], allAllowed: false },
    { action: 'other_commands', match: 'rm -rf dist', askIds: ['a4'], details: ['rm -rf dist'], allAllowed: true },
  ]);
});
