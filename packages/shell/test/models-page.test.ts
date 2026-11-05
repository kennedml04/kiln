// Settings → Models (local-first Ticket 06), driven in a browser: the local server Setting, the
// variant list (hand-written entries included), Add a model from a file on disk or from Hugging
// Face, and "Add another variant". llama-swap and Hugging Face are fakes on local ports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { startTestKiln, tempDir, type Cleanup, type TestKiln } from '@kiln/testing';
import { openShell } from '@kiln/testing/browser';
import { startFakeHuggingFace } from '@kiln/testing/fake-hugging-face';
import { startFakeLocalServer, type FakeLocalServer } from '@kiln/testing/fake-local-server';
import { testGguf } from '@kiln/testing/test-gguf';

/** A config a person wrote, with one entry. */
const HAND_WRITTEN = `models:
  small:
    cmd: llama-server --port \${PORT} -m /models/small-Q8_0.gguf -c 8192
`;

const UI = { timeout: 20_000 };

/** Fills and saves the Local server form. */
async function saveLocalServer(page: Page, values: { configPath?: string; url?: string; modelsFolder?: string }) {
  const form = page.getByRole('form', { name: 'Local server' });
  if (values.configPath !== undefined) await form.getByLabel('llama-swap config file').fill(values.configPath);
  if (values.url !== undefined) await form.getByLabel('llama-swap URL').fill(values.url);
  if (values.modelsFolder !== undefined) await form.getByLabel('Models folder').fill(values.modelsFolder);
  await form.getByRole('button', { name: 'Save the local server' }).click();
  await form.getByRole('status').filter({ hasText: 'Saved' }).waitFor();
}

/** Opens the Shell and goes Settings → Local models, as a person would. */
async function openModels(t: Cleanup, kiln: TestKiln): Promise<Page> {
  const page = await openShell(t, kiln);
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('link', { name: 'Local models' }).click(UI);
  await page.getByRole('heading', { name: 'Models', level: 2 }).waitFor(UI);
  return page;
}

const settingsForm = (page: Page) => page.getByRole('form', { name: 'Variant settings' });
const row = (page: Page, name: string) => page.getByRole('row', { name, exact: true });
const configHas = (fake: FakeLocalServer, text: string) => fake.config().includes(text);

test('the Models page sets the local server, lists hand-written entries, and adds a model from disk with editable recommended settings', async (t) => {
  const kiln = await startTestKiln(t);
  const fake = await startFakeLocalServer(t, { config: HAND_WRITTEN, loadMs: 30 });
  const gguf = join(tempDir(t, 'kiln-gguf'), 'Tiny-Test-Q4_K_M.gguf');
  writeFileSync(gguf, testGguf());

  // Reached from Settings.
  const page = await openModels(t, kiln);
  // No defaults: the fields start empty and the page says what's missing.
  const server = page.getByRole('form', { name: 'Local server' });
  assert.equal(await server.getByLabel('llama-swap config file').inputValue(), '');
  assert.equal(await server.getByLabel('llama-swap URL').inputValue(), '');
  await page.getByText('Set the llama-swap config file and URL above').waitFor();

  await saveLocalServer(page, { configPath: fake.configPath, url: fake.url });
  // The hand-written entry is a variant, disabled until someone enables it.
  const small = row(page, 'small');
  await small.getByText(/Disabled: Found in the local server's config/).waitFor(UI);
  await small.getByText('written by hand in the server config', { exact: false }).waitFor();
  await small.getByRole('button', { name: 'Enable' }).click();
  await small.getByText('Enabled', { exact: true }).waitFor(UI);

  // Add a model: a GGUF file on the Kiln machine. Its header gives the recommendation, each with a reason.
  await page.getByRole('form', { name: 'GGUF file' }).getByRole('textbox').fill(gguf);
  await page.getByRole('button', { name: 'Read the file' }).click();
  const form = settingsForm(page);
  await form.waitFor(UI);
  await form.getByText(/Tiny Test: Q4_K_M, .* 32 layers, trained for 128K tokens/).waitFor();
  await form.getByText(/No GPU reading: install the GPU monitor Widget/).waitFor();
  assert.equal(await form.getByLabel('Name', { exact: true }).inputValue(), 'Tiny Test Q4_K_M');
  assert.equal(await form.getByLabel('Server model id').inputValue(), 'tiny-test-q4_k_m');
  assert.equal(await form.getByLabel('Context size').inputValue(), '16384');
  assert.equal(await form.getByLabel('GPU layers').inputValue(), '0');
  assert.equal(await form.getByLabel('KV cache type').inputValue(), 'f16');
  assert.equal(await form.getByLabel('Extra flags').inputValue(), '--jinja');
  await form.getByText(/Recommended 0: no VRAM figures .* every layer stays on the CPU/).waitFor();
  await form.getByText(/Recommended f16: f16 takes 128 KB of cache a token/).waitFor();
  await form.getByText(/Recommended \d+: half of this machine's \d+ logical CPUs/).waitFor();

  // Every field is editable; another cache type is sized for again.
  await form.getByLabel('KV cache type').selectOption('q8_0');
  await form.getByText(/Recommended q8_0: q8_0 takes/).waitFor(UI);
  await form.getByLabel('Context size').fill('8192');
  await form.getByLabel('Threads').fill('4');
  await form.getByRole('button', { name: 'Save and smoke-test' }).click();

  // Save writes the entry, reloads the server, smoke-tests it and shows the result.
  await page.getByRole('status').filter({ hasText: /Tiny Test Q4_K_M is enabled\. Smoke test passed: loaded in .* tokens\/s, answered a Claude Code tool call/ }).waitFor(UI);
  assert.ok(configHas(fake, 'tiny-test-q4_k_m:'), fake.config());
  assert.ok(configHas(fake, '-c 8192 -ngl 0 --cache-type-k q8_0 --cache-type-v q8_0 -t 4 --jinja'), fake.config());
  assert.ok(configHas(fake, 'small:'), 'the hand-written entry stays');
  const added = row(page, 'Tiny Test Q4_K_M');
  await added.getByText('Enabled', { exact: true }).waitFor(UI);
  await added.getByText(/^Passed: loaded in/).waitFor();

  // Add another variant: the same file and its last settings, under a free name and id.
  fake.reply('tiny-test-q4_k_m-2', { kind: 'text', text: 'Sure, here it is.' });
  await added.getByRole('button', { name: 'Add another variant' }).click();
  await page.getByRole('heading', { name: 'Add another variant', level: 3 }).waitFor();
  await form.waitFor(UI);
  assert.equal(await form.getByLabel('Name', { exact: true }).inputValue(), 'Tiny Test Q4_K_M 2');
  assert.equal(await form.getByLabel('Server model id').inputValue(), 'tiny-test-q4_k_m-2');
  assert.equal(await form.getByLabel('Context size').inputValue(), '8192');
  assert.equal(await form.getByLabel('KV cache type').inputValue(), 'q8_0');
  assert.equal(await form.getByLabel('Threads').inputValue(), '4');
  assert.equal(await page.getByRole('form', { name: 'GGUF file' }).getByRole('textbox').inputValue(), gguf);
  await form.getByLabel('Context size').fill('4096');
  await form.getByRole('button', { name: 'Save and smoke-test' }).click();

  // A failed smoke test leaves it disabled, saying why.
  await page.getByRole('alert').filter({ hasText: /Tiny Test Q4_K_M 2 stays disabled\. Smoke test failed: It answered without calling the tool/ }).waitFor(UI);
  const second = row(page, 'Tiny Test Q4_K_M 2');
  await second.getByText(/^Disabled: Smoke test failed/).waitFor(UI);
  await second.getByText(/^Failed: It answered without calling the tool/).waitFor();
  assert.ok(configHas(fake, '-c 4096'), fake.config());

  // Disable and remove, from the list. Remove asks first.
  await added.getByRole('button', { name: 'Disable' }).click();
  await added.getByText(/^Disabled:/).waitFor(UI);
  await added.getByRole('button', { name: 'Remove' }).click();
  const confirm = added.getByRole('group', { name: 'Remove Tiny Test Q4_K_M?' });
  await confirm.getByRole('button', { name: 'Keep it' }).click();
  assert.ok(configHas(fake, 'tiny-test-q4_k_m:'));
  await added.getByRole('button', { name: 'Remove' }).click();
  await confirm.getByRole('button', { name: 'Remove it' }).click();
  await added.getByText(/^Removed/).waitFor(UI);
  assert.equal(configHas(fake, 'tiny-test-q4_k_m:'), false);
  assert.deepEqual(fake.models().sort(), ['small', 'tiny-test-q4_k_m-2']);

  // A path that isn't a GGUF file is refused, saying why.
  await page.getByRole('button', { name: 'Add a different model instead' }).click();
  const notGguf = join(tempDir(t, 'kiln-gguf'), 'notes.gguf');
  writeFileSync(notGguf, 'hello world');
  await page.getByRole('form', { name: 'GGUF file' }).getByRole('textbox').fill(notGguf);
  await page.getByRole('button', { name: 'Read the file' }).click();
  await page.getByRole('alert').filter({ hasText: /is not a GGUF file/ }).waitFor(UI);
});

test('Add a model from Hugging Face: pick a quant, see its size, confirm, and an interrupted download resumes', async (t) => {
  const hf = await startFakeHuggingFace(t, { chunkBytes: 8 * 1024 });
  const repo = 'test-org/Tiny-Coder-GGUF';
  const q8 = testGguf({ name: 'Tiny Coder', weightBytes: 400 * 1024 });
  hf.addRepo(repo, [
    { path: 'Tiny-Coder-Q4_K_M.gguf', bytes: testGguf({ name: 'Tiny Coder', weightBytes: 200 * 1024 }) },
    { path: 'Q8_0/Tiny-Coder-Q8_0.gguf', bytes: q8 },
  ]);
  const kiln = await startTestKiln(t, { env: { KILN_HUGGINGFACE_URL: hf.url } });
  const fake = await startFakeLocalServer(t, { loadMs: 30 });
  const models = tempDir(t, 'kiln-models');
  const downloads = () => hf.requests().filter((r) => r.path.includes('/resolve/') || r.path.startsWith('/cdn/'));

  const page = await openModels(t, kiln);
  await page.getByRole('radio', { name: /A Hugging Face repo/ }).check();
  const picker = page.getByRole('form', { name: 'Hugging Face repo' });

  // No models folder yet: the confirm step says to set one, and nothing downloads.
  await picker.getByRole('textbox').fill(repo);
  await picker.getByRole('button', { name: 'List files' }).click();
  await page.getByRole('radio', { name: /Q8_0\/Tiny-Coder-Q8_0\.gguf \(\d+ KB\)/ }).check(UI);
  await page.getByRole('alert').filter({ hasText: 'Set the models folder above first' }).waitFor();

  await saveLocalServer(page, { configPath: fake.configPath, url: fake.url, modelsFolder: models });
  // An unknown repo says so.
  await picker.getByRole('textbox').fill('test-org/nothing');
  await picker.getByRole('button', { name: 'List files' }).click();
  await page.getByRole('alert').filter({ hasText: 'Hugging Face has no public repo test-org/nothing' }).waitFor(UI);

  await picker.getByRole('textbox').fill(repo);
  await picker.getByRole('button', { name: 'List files' }).click();
  await page.getByRole('radio', { name: /Tiny-Coder-Q4_K_M\.gguf/ }).waitFor(UI);
  await page.getByRole('radio', { name: /Q8_0\/Tiny-Coder-Q8_0\.gguf/ }).check();
  // The file's name and size are shown, and nothing downloads until the person confirms.
  const confirm = page.getByRole('group', { name: 'Confirm the download' });
  await confirm.getByText(new RegExp(`Download Tiny-Coder-Q8_0\\.gguf \\(\\d+ KB\\) from ${repo} to `)).waitFor();
  assert.equal(downloads().length, 0, 'nothing is fetched before the person confirms');

  // The first try is cut part-way; the page shows how far it got and offers to resume.
  hf.cutNext(repo, 'Q8_0/Tiny-Coder-Q8_0.gguf', 100 * 1024);
  await confirm.getByRole('button', { name: /^Download \d+ KB$/ }).click();
  await page.getByRole('alert').filter({ hasText: /The download stopped at .* Start it again to resume from there\./ }).waitFor(UI);
  const progress = page.getByRole('progressbar', { name: 'Download progress' });
  const partial = await progress.evaluate((el) => (el as HTMLProgressElement).value);
  assert.ok(partial > 0 && partial < q8.length, `progress shows ${partial} of ${q8.length} bytes`);
  await page.getByRole('status').filter({ hasText: /Tiny-Coder-Q8_0\.gguf: \d+ KB of \d+ KB \(\d+%\)/ }).waitFor();

  await page.getByRole('button', { name: 'Resume the download' }).click();
  await page.getByRole('status').filter({ hasText: /Downloaded Tiny-Coder-Q8_0\.gguf/ }).waitFor(UI);
  assert.equal(await progress.evaluate((el) => (el as HTMLProgressElement).value), q8.length);
  const ranges = hf.requests().filter((r) => r.path.startsWith('/cdn/')).map((r) => r.range);
  assert.deepEqual(ranges, [undefined, `bytes=${partial}-`], 'the second try asks only for the rest');

  // The downloaded file is read like one on disk, and saved like one.
  const form = settingsForm(page);
  await form.waitFor(UI);
  assert.equal(await form.getByLabel('Name', { exact: true }).inputValue(), 'Tiny Coder Q8_0');
  assert.equal(await form.getByLabel('Server model id').inputValue(), 'tiny-coder-q8_0');
  await form.getByRole('button', { name: 'Save and smoke-test' }).click();
  await page.getByRole('status').filter({ hasText: /Tiny Coder Q8_0 is enabled\. Smoke test passed/ }).waitFor(UI);
  assert.ok(configHas(fake, join(models, 'Tiny-Coder-Q8_0.gguf').replace(/\\/g, '/')), fake.config());
});
