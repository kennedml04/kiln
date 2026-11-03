import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DoctorCheckResult } from '@kiln/widget-sdk';
import { createWidgetSource, startTestKiln, tempDir, type TestKiln } from '@kiln/testing';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

interface DoctorRun {
  code: number;
  checks: DoctorCheckResult[];
  byId(id: string): DoctorCheckResult;
}

/** Runs `kiln doctor --json` against a data folder and port, and returns the checks. */
const doctor = (args: string[], env: NodeJS.ProcessEnv = {}) =>
  new Promise<DoctorRun>((done, fail) => {
    execFile(
      process.execPath,
      [CLI, 'doctor', '--json', ...args],
      { env: { ...process.env, KILN_PORT: undefined, KILN_DATA_DIR: undefined, KILN_LOGIN: undefined, ...env } },
      (err, stdout, stderr) => {
        try {
          const checks = (JSON.parse(stdout) as { checks: DoctorCheckResult[] }).checks;
          const byId = (id: string) => {
            const check = checks.find((c) => c.id === id);
            assert.ok(check, `no "${id}" check in ${checks.map((c) => c.id).join(', ')}`);
            return check;
          };
          done({ code: err ? ((err as { code?: number }).code ?? 1) : 0, checks, byId });
        } catch (parseError) {
          fail(new Error(`kiln doctor printed no JSON: ${String(parseError)}\n${stdout}\n${stderr}`));
        }
      },
    );
  });

const target = (kiln: TestKiln) => ['--port', String(kiln.port), '--data-dir', kiln.dataDir];

/** Environment that makes git read only `config` as its global settings (and no system ones). */
const gitConfig = (t: Parameters<typeof tempDir>[0], config: string): NodeJS.ProcessEnv => {
  const file = join(tempDir(t, 'kiln-gitconfig'), 'gitconfig');
  writeFileSync(file, config);
  return { GIT_CONFIG_GLOBAL: file, GIT_CONFIG_NOSYSTEM: '1' };
};
const WITH_IDENTITY = '[user]\n\tname = Doctor Test\n\temail = doctor@kiln.invalid\n';

test('kiln doctor passes a healthy Kiln, and reports parts not set up yet as not configured', async (t) => {
  const kiln = await startTestKiln(t);
  await kiln.installFakeAgent();

  const run = await doctor(target(kiln), gitConfig(t, WITH_IDENTITY));

  assert.equal(run.code, 0, JSON.stringify(run.checks, null, 2));
  for (const id of ['core', 'port', 'data-dir', 'git', 'widgets', 'agents', 'proxy', 'knowledge-store']) {
    assert.equal(run.byId(id).status, 'pass', id);
  }
  for (const id of ['budgets']) assert.equal(run.byId(id).status, 'not-configured', id);
  for (const check of run.checks) assert.ok(check.detail.length > 0, `${check.id} says what it found`);
  assert.match(run.byId('knowledge-store').detail, /knowledge/);
});

test('kiln doctor warns about each unknown window of a subscription Budget, since its rules are off while it is unknown', async (t) => {
  const kiln = await startTestKiln(t);
  await kiln.installFakeAgent();
  await kiln.api('PUT', '/api/budgets/home', { kind: 'subscription', name: 'Home', models: ['fake-model'] });

  const budgets = (await doctor(target(kiln))).byId('budgets');

  assert.equal(budgets.status, 'warn');
  for (const window of ['Week', '5-hour window', 'Fable']) assert.match(budgets.detail, new RegExp(`Home: ${window} is unknown`));
  assert.ok(budgets.fix, 'says what to do');
});

test('kiln doctor warns when git has no identity, since an Agent could not commit its work, and says how to set one', async (t) => {
  const kiln = await startTestKiln(t);

  const run = await doctor(target(kiln), gitConfig(t, ''));

  const check = run.byId('git');
  assert.equal(check.status, 'warn');
  assert.match(check.detail, /user\.name/);
  assert.match(check.detail, /commit/);
  assert.match(check.fix!, /git config --global user\.name/);
  assert.match(check.fix!, /git config --global user\.email/);
});

test('kiln doctor fails a Knowledge store Kiln cannot write Digests to, and says how to point it elsewhere', async (t) => {
  const notAFolder = join(tempDir(t, 'kiln-knowledge'), 'a-file');
  writeFileSync(notAFolder, 'not a folder');
  const kiln = await startTestKiln(t, { env: { KILN_KNOWLEDGE_DIR: notAFolder } });

  const run = await doctor(target(kiln));

  assert.equal(run.code, 1);
  assert.equal(run.byId('knowledge-store').status, 'fail');
  assert.match(run.byId('knowledge-store').detail, /a-file/);
  assert.match(run.byId('knowledge-store').fix!, /KILN_KNOWLEDGE_DIR/);
});

test('kiln doctor fails a crashing Widget and a Kiln with no Agent, with a plain fix for each', async (t) => {
  const kiln = await startTestKiln(t, { widgetRestartMs: 10 });
  const source = createWidgetSource(t);
  await kiln.api('POST', '/api/widgets', { source: source.path, config: { crash: true } });
  const events = await kiln.events();
  await kiln.api('POST', '/api/widgets/test-widget/approve');
  await events.next('widget.unhealthy', { timeoutMs: 15_000 });

  const run = await doctor(target(kiln));

  assert.equal(run.code, 1);
  assert.equal(run.byId('widgets').status, 'fail');
  assert.match(run.byId('widgets').detail, /Test Widget/);
  assert.equal(run.byId('agents').status, 'fail');
  for (const id of ['widgets', 'agents']) assert.ok(run.byId(id).fix, `${id} says how to fix it`);
});

test('kiln doctor without a running core reports it, and a port another program holds', async (t) => {
  const dataDir = tempDir(t, 'kiln-doctor');
  const squatter = createServer();
  await new Promise<void>((done) => squatter.listen(0, '127.0.0.1', () => done()));
  t.after(() => squatter.close());
  const port = (squatter.address() as AddressInfo).port;

  const run = await doctor(['--port', String(port), '--data-dir', dataDir]);

  assert.equal(run.code, 1);
  assert.equal(run.byId('core').status, 'fail');
  assert.match(run.byId('core').fix!, /kiln start/);
  assert.equal(run.byId('port').status, 'fail');
  assert.match(run.byId('port').detail, new RegExp(`${port}.*in use`));
  assert.match(run.byId('port').fix!, /--port/);
  assert.equal(run.byId('data-dir').status, 'pass');
});

test('kiln doctor fails when git is missing', async (t) => {
  const dataDir = tempDir(t, 'kiln-doctor');

  const run = await doctor(['--port', '0', '--data-dir', dataDir], { PATH: dataDir, Path: dataDir });

  assert.equal(run.byId('git').status, 'fail');
  assert.match(run.byId('git').fix!, /Install Git/);
});

test('kiln doctor fails when a local reverse proxy fronts Kiln, since its callers would all be the local Admin', async (t) => {
  const kiln = await startTestKiln(t, { login: 'tailscale' });
  await kiln.request('GET', '/api/status', undefined, { 'x-forwarded-for': '100.64.0.7' });

  const run = await doctor(target(kiln));

  assert.equal(run.byId('proxy').status, 'fail');
  assert.match(run.byId('proxy').detail, /local Admin/);
  assert.match(run.byId('proxy').fix!, /tailscale/);
});

test('kiln doctor fails when tailscale serve forwards to Kiln', async (t) => {
  const fakeTailscale = join(tempDir(t, 'kiln-fake-tailscale'), 'tailscale.mjs');
  // The fake is written once the core's port is known; the core runs it only when asked for checks.
  const kiln = await startTestKiln(t, { login: 'tailscale', env: { KILN_TAILSCALE_CLI: fakeTailscale } });
  writeFileSync(
    fakeTailscale,
    `const port = ${kiln.port};\n` +
      'if (process.argv.slice(2).join(" ") === "serve status --json") {\n' +
      '  console.log(JSON.stringify({ Web: { "pc.example.ts.net:443": { Handlers: { "/": { Proxy: `http://127.0.0.1:${port}` } } } } }));\n' +
      '} else process.exit(1);\n',
  );

  const run = await doctor(target(kiln));

  assert.equal(run.byId('proxy').status, 'fail');
  assert.match(run.byId('proxy').detail, /tailscale serve/);
});
