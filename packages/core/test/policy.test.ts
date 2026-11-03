import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  Ask,
  AskRaisedEvent,
  AuditEntry,
  EffectivePolicy,
  Item,
  Manifest,
  OrgPolicy,
  PolicyView,
  Project,
  SessionAgentEvent,
  StartResult,
} from '@kiln/widget-sdk';
import { decide as decideIn } from '@kiln/widget-sdk';
import { createWidgetSource, driveTestWidget, startTestKiln, type Cleanup, type FakeAgentScript, type TestKiln } from '@kiln/testing';
import { readRepoFile, seedScratch, writeRepoFile } from '@kiln/testing/scratch';

const startWidget = async (t: Cleanup, kiln: TestKiln, manifest: Partial<Manifest>) => {
  const source = createWidgetSource(t, { manifest });
  const events = await kiln.events();
  await kiln.api('POST', '/api/widgets', { source: source.path });
  await kiln.api('POST', `/api/widgets/${source.manifest.id}/approve`);
  await events.next('widget.ready');
  events.close();
  return driveTestWidget(kiln, source.manifest.id);
};

const QUESTION = {
  type: 'question',
  question: 'Which printer?',
  why: 'The job needs one.',
  recommendation: 'The big one',
  blocking: false,
};

test('a Widget raises Asks only when its grants include asks, and a refusal is audited', async (t) => {
  const kiln = await startTestKiln(t);
  seedScratch(kiln.repo);
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const item = (await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`))[0]!;
  const widget = await startWidget(t, kiln, {});

  const refused = await widget.call<{ reason: string }>('POST', '/api/widget/asks', { ...QUESTION, itemId: item.id });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.reason, 'grant');
  const audit = await kiln.api<AuditEntry[]>('GET', '/api/audit?actorKind=widget&outcome=refused');
  assert.ok(audit.some((e) => e.action === 'ask.raise'), 'the refused raise is audited');
  assert.equal((await kiln.api<unknown[]>('GET', '/api/asks')).length, 0);
});

test('the Org Policy starts by allowing everything but outside the worktree, and only Admins change it', async (t) => {
  const kiln = await startTestKiln(t, { login: 'tailscale' });
  const initial = await kiln.api<OrgPolicy>('GET', '/api/org-policy');
  assert.deepEqual(initial, {
    actions: {
      worktree_read: 'allow',
      worktree_write: 'allow',
      known_commands: 'allow',
      other_commands: 'allow',
      network: 'allow',
      external_writes: 'allow',
      outside_worktree: 'ask',
    },
    rules: [],
    widgetSources: null,
  });

  await kiln.api('PUT', '/api/users/mo', { role: 'member' });
  const mo = kiln.as('mo');
  const refused = await mo.request('PUT', '/api/org-policy', { actions: { network: 'deny' } });
  assert.equal(refused.status, 403);
  assert.equal((await mo.request('GET', '/api/org-policy')).status, 200, 'anyone with a role can read it');

  const changed = await kiln.api<OrgPolicy>('PUT', '/api/org-policy', {
    actions: { network: 'deny' },
    rules: [{ action: 'network', match: 'registry.npmjs.org', decision: 'allow' }],
    widgetSources: ['C:\\vetted'],
  });
  assert.equal(changed.actions.network, 'deny');
  assert.equal(changed.actions.worktree_read, 'allow', 'actions left out keep their value');
  assert.deepEqual(changed.rules, [{ action: 'network', match: 'registry.npmjs.org', decision: 'allow' }]);
  assert.deepEqual(changed.widgetSources, ['C:\\vetted']);
  assert.deepEqual(await kiln.api('GET', '/api/org-policy/widget-sources'), { allowed: ['C:\\vetted'] });

  const bad = await kiln.request('PUT', '/api/org-policy', { actions: { network: 'sometimes' } });
  assert.equal(bad.status, 400);
  const audit = await kiln.api<AuditEntry[]>('GET', '/api/audit?action=org_policy.update');
  assert.deepEqual(
    audit.map((e) => [e.actor.kind === 'user' ? e.actor.id : e.actor.kind, e.outcome]),
    [
      ['local', 'failed'],
      ['local', 'allowed'],
      ['mo', 'refused'],
    ],
  );
});

const policyOf = (kiln: TestKiln, project: Project, kind: string, stage: string) =>
  kiln.api<PolicyView>('GET', `/api/projects/${project.id}/policy?kind=${kind}&stage=${stage}`);

test('registering a Project commits the Project Policy template, which asks about shell commands, unknown domains and external writes', async (t) => {
  const kiln = await startTestKiln(t);
  seedScratch(kiln.repo);
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });

  assert.deepEqual(JSON.parse(readRepoFile(kiln.repo, '.kiln/policy.json')), {
    actions: { other_commands: 'ask', network: 'ask', external_writes: 'ask' },
    rules: [],
  });
  assert.equal(kiln.repo.git('status', '--porcelain'), '');
  assert.equal(kiln.repo.git('log', '-1', '--format=%an|%s', '--', '.kiln/policy.json').trim(), 'Kiln|Kiln: add the Project Policy');

  const { effective } = await policyOf(kiln, project, 'ticket', 'implementing');
  assert.deepEqual(effective.actions, {
    worktree_read: 'allow',
    worktree_write: 'allow',
    known_commands: 'allow',
    other_commands: 'ask',
    network: 'ask',
    external_writes: 'ask',
    outside_worktree: 'ask',
  });
});

test('a local-only Project denies external writes', async (t) => {
  const kiln = await startTestKiln(t);
  seedScratch(kiln.repo);
  writeRepoFile(kiln.repo, '.kiln/settings.json', JSON.stringify({ localOnly: true }));
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  assert.equal(JSON.parse(readRepoFile(kiln.repo, '.kiln/policy.json')).actions.external_writes, 'deny');
  assert.equal((await policyOf(kiln, project, 'ticket', 'implementing')).effective.actions.external_writes, 'deny');
});

test('a local-only Project denies external writes whatever its Policy rules or the Org rules allow', async (t) => {
  const kiln = await startTestKiln(t);
  seedScratch(kiln.repo);
  writeRepoFile(kiln.repo, '.kiln/settings.json', JSON.stringify({ localOnly: true }));
  writeRepoFile(
    kiln.repo,
    '.kiln/policy.json',
    JSON.stringify({ actions: {}, rules: [{ action: 'external_writes', match: 'gh pr create', decision: 'allow' }] }),
  );
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  await kiln.api('PUT', '/api/org-policy', { rules: [{ action: 'external_writes', match: 'git push*', decision: 'allow' }] });

  const { effective } = await policyOf(kiln, project, 'ticket', 'implementing');
  assert.equal(effective.actions.external_writes, 'deny');
  assert.deepEqual(effective.rules.filter((r) => r.action === 'external_writes'), []);
  assert.equal(decideIn(effective, 'external_writes', 'gh pr create'), 'deny');
  assert.equal(decideIn(effective, 'external_writes', 'git push origin main'), 'deny');
});

test('a Project keeps its own Policy file, and the effective Policy is the strictest of Org, Project and Stage', async (t) => {
  const kiln = await startTestKiln(t);
  seedScratch(kiln.repo);
  writeRepoFile(
    kiln.repo,
    '.kiln/policy.json',
    JSON.stringify({
      actions: { worktree_write: 'allow', other_commands: 'deny', network: 'ask' },
      rules: [
        { action: 'network', match: 'registry.npmjs.org', decision: 'allow' },
        { action: 'other_commands', match: 'gh pr create', decision: 'allow' },
      ],
    }),
  );
  writeRepoFile(kiln.repo, '.kiln/settings.json', JSON.stringify({ testCommand: 'npm test', knownCommands: ['npm run build'] }));
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  await kiln.api('PUT', '/api/org-policy', {
    actions: { worktree_write: 'ask', other_commands: 'allow' },
    rules: [{ action: 'network', match: 'evil.example', decision: 'deny' }],
  });

  const view = await policyOf(kiln, project, 'ticket', 'implementing');
  assert.equal(view.effective.actions.worktree_write, 'ask', 'the Org asks though the Project allows');
  assert.equal(view.effective.actions.other_commands, 'deny', 'the Project denies though the Org allows');
  assert.deepEqual(
    view.effective.rules.sort((a, b) => a.match.localeCompare(b.match)),
    [
      { action: 'network', match: 'evil.example', decision: 'deny' },
      { action: 'other_commands', match: 'gh pr create', decision: 'allow' },
      { action: 'network', match: 'registry.npmjs.org', decision: 'allow' },
    ],
    "a Project's narrow rules beat its own rule for the action, and an Org deny rule holds",
  );
  await kiln.api('PUT', '/api/org-policy', { rules: [{ action: 'other_commands', match: 'gh *', decision: 'ask' }] });
  const tightened = await policyOf(kiln, project, 'ticket', 'implementing');
  assert.deepEqual(
    tightened.effective.rules.find((r) => r.match === 'gh pr create'),
    { action: 'other_commands', match: 'gh pr create', decision: 'ask' },
    'an Org rule for a command prefix tightens the Project rule',
  );
  assert.deepEqual(view.effective.knownCommands, ['npm test', 'npm run build']);

  // The default Workflow's Grill Stage can't make external writes, whatever the Project says.
  const grill = await policyOf(kiln, project, 'story', 'grill');
  assert.deepEqual(grill.stage, { actions: { external_writes: 'deny' } });
  assert.equal(grill.effective.actions.external_writes, 'deny');
});

test('a Widget granted asks raises one', async (t) => {
  const kiln = await startTestKiln(t);
  seedScratch(kiln.repo);
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  const item = (await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`))[0]!;
  const widget = await startWidget(t, kiln, { needs: { asks: true } });
  const raised = await widget.call('POST', '/api/widget/asks', { ...QUESTION, itemId: item.id });
  assert.equal(raised.status, 201);
});

// Sessions under the Policy.

type Progress = SessionAgentEvent<'progress'>;
type Events = Awaited<ReturnType<TestKiln['events']>>;

async function ticketSession(kiln: TestKiln, script: FakeAgentScript, before?: (project: Project) => Promise<void>) {
  await kiln.installFakeAgent({ script });
  seedScratch(kiln.repo);
  const project = await kiln.api<Project>('POST', '/api/projects', { path: kiln.repo.path });
  await before?.(project);
  const ticket = (await kiln.api<Item[]>('GET', `/api/projects/${project.id}/items`)).find((i) => i.title === 'Draw the columns')!;
  const events = await kiln.events();
  const { session } = await kiln.api<StartResult>('POST', `/api/items/${encodeURIComponent(ticket.id)}/start`);
  assert.ok(session, 'the Session starts at once');
  return { project, ticket, session, events };
}

async function progress(events: Events, pattern: RegExp): Promise<string> {
  for (;;) {
    const text = (await events.next<Progress>('session.progress', { timeoutMs: 15_000 })).payload.text ?? '';
    if (pattern.test(text)) return text;
  }
}

test('the Agent gets the effective Policy when its Session starts', async (t) => {
  const kiln = await startTestKiln(t);
  const { events } = await ticketSession(kiln, [{ do: 'report_policy' }]);
  const text = await progress(events, /^policy: /);
  const policy = JSON.parse(text.slice('policy: '.length)) as EffectivePolicy;
  assert.equal(policy.actions.other_commands, 'ask');
  assert.equal(policy.actions.outside_worktree, 'ask');
  assert.equal(policy.actions.worktree_write, 'allow');
  assert.deepEqual(policy.rules, []);
});

const permissionAudit = (kiln: TestKiln) =>
  kiln
    .api<AuditEntry[]>('GET', '/api/audit')
    .then((entries) => entries.filter((e) => e.action.startsWith('permission.')).reverse());

async function permissionAsk(events: Events): Promise<Ask> {
  const raised = await events.next<AskRaisedEvent>('ask.raised', { timeoutMs: 15_000 });
  return raised.payload.ask;
}

test('a permission request the Policy asks about pauses the Session on a blocking Permission Ask, and Allow once lets the step run', async (t) => {
  const kiln = await startTestKiln(t);
  const { session, ticket, events } = await ticketSession(kiln, [
    { do: 'permission', action: 'other_commands', detail: 'rm -rf build' },
    { do: 'progress', text: 'after the permission' },
  ]);
  const ask = await permissionAsk(events);
  assert.equal(ask.type, 'permission');
  assert.equal(ask.blocking, true);
  assert.equal(ask.itemId, ticket.id);
  assert.match(ask.question, /rm -rf build/);
  assert.deepEqual(ask.options, ['Allow once', 'Always allow', 'Deny']);
  assert.equal(ask.recommendation, 'Allow once');
  assert.deepEqual(ask.permission, { sessionId: session.id, requestId: ask.permission!.requestId, action: 'other_commands', detail: 'rm -rf build' });
  assert.deepEqual((await kiln.api<Ask[]>('GET', '/api/asks')).map((a) => a.id), [ask.id], 'it lands in Needs you');
  assert.equal((await kiln.api<{ state: string }>('GET', `/api/sessions/${session.id}`)).state, 'waiting');

  await kiln.api('POST', `/api/asks/${ask.id}/answer`, { answer: 'Allow once' });
  assert.equal(await progress(events, /^permission /), 'permission allow');
  await progress(events, /^after the permission$/);
  const audit = await permissionAudit(kiln);
  assert.deepEqual(
    audit.map((e) => [e.action, e.actor.kind, e.target, e.outcome]),
    [['permission.allow_once', 'user', `item:${ticket.id}`, 'allowed']],
  );
  assert.deepEqual(audit[0]!.detail, { sessionId: session.id, action: 'other_commands', detail: 'rm -rf build', askId: ask.id });
});

test('Deny tells the Session it was refused, and is audited', async (t) => {
  const kiln = await startTestKiln(t);
  const { ticket, events } = await ticketSession(kiln, [{ do: 'permission', action: 'network', detail: 'example.com' }]);
  const ask = await permissionAsk(events);
  await kiln.api('POST', `/api/asks/${ask.id}/answer`, { answer: 'Deny' });
  assert.equal(await progress(events, /^permission /), 'permission deny');
  assert.deepEqual(
    (await permissionAudit(kiln)).map((e) => [e.action, e.target, e.outcome]),
    [['permission.deny', `item:${ticket.id}`, 'refused']],
  );
});

test('Always allow commits one narrow rule to the Project Policy file alone, and the same request is allowed from then on', async (t) => {
  const kiln = await startTestKiln(t);
  const script: FakeAgentScript = [
    { do: 'permission', action: 'other_commands', detail: 'npm run lint' },
    { do: 'permission', action: 'other_commands', detail: 'npm run lint' },
  ];
  const { project, events } = await ticketSession(kiln, script);
  writeRepoFile(kiln.repo, 'notes.md', 'work in progress\n');
  const ask = await permissionAsk(events);
  await kiln.api('POST', `/api/asks/${ask.id}/answer`, { answer: 'Always allow' });
  assert.equal(await progress(events, /^permission /), 'permission allow');
  assert.equal(await progress(events, /^permission /), 'permission allow', 'the second request needs no Ask');
  assert.equal((await kiln.api<Ask[]>('GET', '/api/asks?state=all')).length, 1);

  assert.deepEqual(JSON.parse(readRepoFile(kiln.repo, '.kiln/policy.json')).rules, [
    { action: 'other_commands', match: 'npm run lint', decision: 'allow' },
  ]);
  assert.equal(kiln.repo.git('log', '-1', '--format=%an|%s').trim(), 'Kiln|Kiln: always allow other_commands "npm run lint"');
  assert.equal(kiln.repo.git('show', '--name-only', '--format=', 'HEAD').trim(), '.kiln/policy.json');
  assert.equal(kiln.repo.git('status', '--porcelain').trim(), '?? notes.md', 'nothing else is committed');
  const { effective } = await policyOf(kiln, project, 'ticket', 'implementing');
  assert.equal(decideIn(effective, 'other_commands', 'npm run lint'), 'allow');
  assert.equal(decideIn(effective, 'other_commands', 'npm run lint --fix'), 'ask', 'the rule is narrow');
  assert.deepEqual(
    (await permissionAudit(kiln)).map((e) => [e.action, e.actor.kind]),
    [
      ['permission.always_allow', 'user'],
      ['permission.allow', 'kiln'],
    ],
  );
});

test('Always allow is not offered when the Org Policy would still ask', async (t) => {
  const kiln = await startTestKiln(t);
  const { events } = await ticketSession(kiln, [{ do: 'permission', action: 'other_commands', detail: 'npm run lint' }], async () => {
    await kiln.api('PUT', '/api/org-policy', { actions: { other_commands: 'ask' } });
  });
  const ask = await permissionAsk(events);
  assert.deepEqual(ask.options, ['Allow once', 'Deny']);
  const refused = await kiln.request('POST', `/api/asks/${ask.id}/answer`, { answer: 'Always allow' });
  assert.equal(refused.status, 400);
  assert.equal(JSON.parse(readRepoFile(kiln.repo, '.kiln/policy.json')).rules.length, 0);
});

test('the Policy answers allow and deny itself, and Kiln audits it', async (t) => {
  const kiln = await startTestKiln(t);
  const { events } = await ticketSession(kiln, [
    { do: 'permission', action: 'worktree_write', detail: 'src/board.ts' },
    { do: 'permission', action: 'external_writes', detail: 'git push origin' },
  ], async () => {
    await kiln.api('PUT', '/api/org-policy', { actions: { external_writes: 'deny' } });
  });
  assert.equal(await progress(events, /^permission /), 'permission allow');
  assert.equal(await progress(events, /^permission /), 'permission deny');
  assert.equal((await kiln.api<Ask[]>('GET', '/api/asks?state=all')).length, 0);
  assert.deepEqual(
    (await permissionAudit(kiln)).map((e) => [e.action, e.actor.kind, e.outcome]),
    [
      ['permission.allow', 'kiln', 'allowed'],
      ['permission.deny', 'kiln', 'refused'],
    ],
  );
});
