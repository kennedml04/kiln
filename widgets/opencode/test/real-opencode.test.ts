// The shared Agent contracts against a real OpenCode 1.x and a real model. Opt-in, because it
// spends money (or a local model's time):
//
//   KILN_REAL_OPENCODE=1 KILN_REAL_OPENCODE_MODEL=<provider>/<model> node --test --test-timeout=900000 widgets/opencode/test/real-opencode.test.ts
//
// Optional: KILN_REAL_OPENCODE_CMD (JSON command list, default ["opencode"]), KILN_REAL_OPENCODE_MAX_USD
// (the hard cost cap per case, default 0.05: the metered Budget's per-Session and monthly limit),
// KILN_REAL_OPENCODE_LOCAL (JSON, the Widget's `local` setting: the model then runs on a local
// Budget and must cost nothing).
import assert from 'node:assert/strict';
import type { UsageRecord } from '@kiln/widget-sdk';
import type { TestKiln, Cleanup } from '@kiln/testing';
import { agentContract } from '@kiln/testing/agent-contract';
import { agentLifecycleContract } from '@kiln/testing/agent-lifecycle-contract';
import { installOpenCode } from './support.ts';

const env = process.env;
const model = env.KILN_REAL_OPENCODE_MODEL ?? '';
const local = env.KILN_REAL_OPENCODE_LOCAL ? (JSON.parse(env.KILN_REAL_OPENCODE_LOCAL) as Record<string, unknown>) : undefined;
const cap = Number(env.KILN_REAL_OPENCODE_MAX_USD ?? 0.05);
const skip =
  env.KILN_REAL_OPENCODE !== '1' ? 'a paid run: set KILN_REAL_OPENCODE=1 and KILN_REAL_OPENCODE_MODEL to run it' : !model ? 'set KILN_REAL_OPENCODE_MODEL' : false;
const name = `OpenCode (real, ${model || 'no model set'})`;

async function install(t: Cleanup, kiln: TestKiln, cacheLifetimeMs?: number) {
  // The Budget is the hard cap: Kiln holds the Session when it is spent.
  await kiln.api(
    'PUT',
    '/api/budgets/real',
    local
      ? { kind: 'local', name: 'Real local', models: [model] }
      : { kind: 'metered', name: 'Real', models: [model], unit: 'USD', ratePerUsd: 1, monthly: cap, perSession: { cost: cap, turns: 40 } },
  );
  await installOpenCode(t, kiln, {
    opencode: env.KILN_REAL_OPENCODE_CMD ? JSON.parse(env.KILN_REAL_OPENCODE_CMD) : ['opencode'],
    model,
    ...(local ? { local } : {}),
    ...(cacheLifetimeMs ? { cacheLifetimeMs } : {}),
  });
}

agentContract({ name, skip, timeoutMs: 300_000, install: (t, kiln) => install(t, kiln) });

agentLifecycleContract({
  name,
  skip,
  timeoutMs: 600_000,
  eventTimeoutMs: 300_000,
  install: (t, kiln, _behaviour, options) => install(t, kiln, options.cacheLifetimeMs),
  async check(kiln) {
    const records = await kiln.api<UsageRecord[]>('GET', '/api/usage/records');
    assert.ok(records.length > 0, 'usage reached Kiln');
    for (const r of records) assert.equal(r.budgetId, 'real', `${r.model} is on the real Budget`);
    const spent = records.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
    if (local) assert.ok(records.every((r) => r.costUsd === null), 'a local model costs nothing');
    else assert.ok(spent <= cap, `spent $${spent}, over the $${cap} cap`);
  },
});
