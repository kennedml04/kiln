// A Widget installed from git gets the npm packages its lock file pins, and `@kiln/widget-sdk`
// from the core. Every package here is a local tarball, so no test needs the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { WidgetInfo } from '@kiln/widget-sdk';
import { createWidgetSource, startTestKiln, tempDir, type Cleanup, type TestKiln, type WidgetSource } from '@kiln/testing';

const NPM_CLI = [
  join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
].find(existsSync)!;

const npm = (cwd: string, ...args: string[]) =>
  execFileSync(process.execPath, [NPM_CLI, ...args, '--no-audit', '--no-fund', '--offline'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** A script that leaves a file behind if npm ever runs it. */
const marker = (file: string) => `node -e "require('fs').writeFileSync('${file.replace(/\\/g, '/')}', 'ran')"`;

/** Packs a one-file package `tiny` at `version` into `<source>/vendor`, with a postinstall script. */
function packTiny(t: Cleanup, source: string, version: string, ranFile: string): string {
  const dir = tempDir(t, 'kiln-tiny-package');
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'tiny', version, type: 'module', exports: './index.js', scripts: { postinstall: marker(ranFile) } }),
  );
  writeFileSync(join(dir, 'index.js'), `export const tiny = ${JSON.stringify(version)};\n`);
  mkdirSync(join(source, 'vendor'), { recursive: true });
  npm(dir, 'pack', '--pack-destination', join(source, 'vendor'));
  return `file:vendor/tiny-${version}.tgz`;
}

/** Writes the Widget's package.json listing `tiny`, and (unless told not to) its lock file. */
function writePackage(source: string, tinySpec: string, ranFile: string, options: { lock?: boolean } = {}) {
  writeFileSync(
    join(source, 'package.json'),
    JSON.stringify({ name: 'packaged-widget', version: '1.0.0', private: true, type: 'module', dependencies: { tiny: tinySpec }, scripts: { preinstall: marker(ranFile) } }),
  );
  rmSync(join(source, 'package-lock.json'), { force: true });
  if (options.lock ?? true) npm(source, 'install', '--package-lock-only', '--ignore-scripts', '--prefix', '.');
}

const commit = (source: WidgetSource, message: string) => {
  source.git('add', '-A');
  source.git('commit', '-q', '-m', message);
};

// Loads its package and the SDK, says what it got, then runs as the test Widget.
const ENTRY = `import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tiny } from 'tiny';
import { ORG_POLICY_DEFAULT } from '@kiln/widget-sdk';
writeFileSync(join(process.env.KILN_WIDGET_DATA_DIR, 'loaded.json'), JSON.stringify({ tiny, sdk: typeof ORG_POLICY_DEFAULT }));
await import('./main.mjs');
`;

interface PackagedSource {
  source: WidgetSource;
  /** Written by an install script if npm ever runs one. */
  ranFiles: string[];
}

function createPackagedSource(t: Cleanup, options: { lock?: boolean } = {}): PackagedSource {
  const ran = tempDir(t, 'kiln-scripts-ran');
  const ranFiles = [join(ran, 'tiny-postinstall'), join(ran, 'widget-preinstall')];
  const source = createWidgetSource(t, { manifest: { command: ['node', 'entry.mjs'] }, files: { 'entry.mjs': ENTRY } });
  writePackage(source.path, packTiny(t, source.path, '1.0.0', ranFiles[0]!), ranFiles[1]!, options);
  commit(source, 'tiny 1.0.0');
  return { source, ranFiles };
}

const loaded = (kiln: TestKiln) => JSON.parse(readFileSync(join(kiln.dataDir, 'widgets', 'test-widget', 'data', 'loaded.json'), 'utf8')) as { tiny: string; sdk: string };

async function installAndApprove(kiln: TestKiln, source: string) {
  const events = await kiln.events();
  await kiln.api('POST', '/api/widgets', { source });
  await kiln.api('POST', '/api/widgets/test-widget/approve');
  await events.next('widget.ready', { timeoutMs: 20_000 });
  events.close();
}

const installError = async (kiln: TestKiln, source: string) => {
  const res = await kiln.request('POST', '/api/widgets', { source });
  return { status: res.status, error: String((res.body as { error?: string }).error) };
};

test('a Widget installed from git loads the packages its lock pins and the core SDK, with no install scripts run', async (t) => {
  const kiln = await startTestKiln(t);
  const { source, ranFiles } = createPackagedSource(t);

  await installAndApprove(kiln, source.path);

  assert.deepEqual(loaded(kiln), { tiny: '1.0.0', sdk: 'object' });
  for (const file of ranFiles) assert.equal(existsSync(file), false, `${file}: npm ran an install script`);
});

test('an update installs the new commit its own packages', async (t) => {
  const kiln = await startTestKiln(t);
  const { source, ranFiles } = createPackagedSource(t);
  await installAndApprove(kiln, source.path);

  writePackage(source.path, packTiny(t, source.path, '2.0.0', ranFiles[0]!), ranFiles[1]!);
  source.setManifest({ version: '1.1.0' });
  const events = await kiln.events();
  const updated = await kiln.api<WidgetInfo>('POST', '/api/widgets/test-widget/update');
  assert.equal(updated.version, '1.1.0');
  await events.next('widget.ready', { timeoutMs: 20_000 });
  events.close();

  assert.deepEqual(loaded(kiln), { tiny: '2.0.0', sdk: 'object' });
});

test('a Widget that lists packages but has no lock file is refused, and says why', async (t) => {
  const kiln = await startTestKiln(t);
  const { source } = createPackagedSource(t, { lock: false });

  const { status, error } = await installError(kiln, source.path);

  assert.equal(status, 400);
  assert.match(error, /package-lock\.json/);
  assert.deepEqual(await kiln.api<WidgetInfo[]>('GET', '/api/widgets'), []);
});

test('a Widget whose packages cannot be installed is refused with npm\'s reason, and nothing runs', async (t) => {
  const kiln = await startTestKiln(t);
  const { source, ranFiles } = createPackagedSource(t);
  // package.json now asks for a version its lock doesn't pin; npm ci refuses that.
  writePackage(source.path, 'file:vendor/tiny-9.9.9.tgz', ranFiles[1]!, { lock: false });
  source.git('checkout', 'HEAD', '--', 'package-lock.json');
  commit(source, 'out of step with the lock');

  const { status, error } = await installError(kiln, source.path);

  assert.equal(status, 400);
  assert.match(error, /Could not install the Widget's npm packages/);
  assert.deepEqual(await kiln.api<WidgetInfo[]>('GET', '/api/widgets'), []);
});

test('a folder install runs in place with the packages it has, and Kiln installs none', async (t) => {
  const kiln = await startTestKiln(t);
  const ran = tempDir(t, 'kiln-scripts-ran');
  const source = createWidgetSource(t, { git: false });
  // It lists a package with no lock and no tarball: a git install would refuse it, a folder install doesn't look.
  writeFileSync(join(source.path, 'package.json'), JSON.stringify({ name: 'folder-widget', type: 'module', dependencies: { tiny: 'file:vendor/missing.tgz' }, scripts: { preinstall: marker(join(ran, 'x')) } }));

  const events = await kiln.events();
  await kiln.api('POST', '/api/widgets', { source: source.path });
  await kiln.api('POST', '/api/widgets/test-widget/approve');
  await events.next('widget.ready');
  events.close();

  assert.equal(existsSync(join(source.path, 'node_modules')), false);
});
