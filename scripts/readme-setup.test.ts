// Makes the README's setup-wizard frames: a fresh dev instance (never set up) opens on the wizard,
// and a headless browser walks its steps and photographs each one. Not part of `npm test`. Run:
//   node --test scripts/readme-setup.test.ts
// Frames land in docs/readme/shots/setup-*.png with the page's text beside each one;
// scripts/readme-media.py turns them into docs/readme/setup.gif.
import { test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { startTestKiln, tempDir } from '@kiln/testing';
import { openShell } from '@kiln/testing/browser';

const OUT = join(process.cwd(), 'docs', 'readme', 'shots');
const VIEWPORT = { width: 1440, height: 900 };

let shot = 0;
async function snap(page: Page, name: string) {
  await page.waitForTimeout(700);
  // The frames are published: the throwaway folder under this PC's temp reads as a plain example path.
  await page.evaluate(() => {
    const swap = (s: string) => s.replace(/[A-Za-z]:\\Users\\[^\\\s]+\\AppData\\Local\\Temp\\kiln-[a-z]+-[^\\\s]+/g, 'C:\\Kiln');
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = swap(node.nodeValue ?? '');
      if (text !== node.nodeValue) node.nodeValue = text;
    }
    for (const input of document.querySelectorAll('input')) input.value = swap(input.value);
  });
  shot += 1;
  const file = join(OUT, `setup-${String(shot).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file, clip: { x: 0, y: 0, ...VIEWPORT } });
  const text = (await page.locator('body').innerText()).replace(/[ \t]+/g, ' ');
  const inputs = await page.locator('input').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value).filter(Boolean).join('\n'));
  writeFileSync(`${file}.txt`, `${text}\n--- inputs ---\n${inputs}\n`);
  console.log(`shot ${file}`);
}

test('README media: the setup wizard on a fresh dev instance, photographed', { timeout: 300_000 }, async (t) => {
  mkdirSync(OUT, { recursive: true });
  const kiln = await startTestKiln(t, { setup: 'fresh', devInstance: true });
  const page = await openShell(t, kiln, '/', { viewport: VIEWPORT });
  const wizard = page.getByRole('region', { name: 'Set up Kiln' });
  const next = page.getByRole('button', { name: 'Next', exact: true });
  const onStep = (title: string) => wizard.getByRole('heading', { name: title, exact: true }).waitFor();

  await onStep('Login');
  await page.getByRole('radio', { name: /^Local/ }).check();
  await snap(page, 'login');

  await next.click();
  await onStep('Knowledge store');
  await page.getByRole('textbox', { name: 'Knowledge store folder', exact: true }).fill(join(tempDir(t, 'kiln-readme'), 'knowledge'));
  await snap(page, 'knowledge');

  await next.click();
  await onStep('Install');
  await page.getByRole('radio', { name: /^Home/ }).check();
  await snap(page, 'install');

  await next.click();
  await onStep('Agents');
  await snap(page, 'agents');

  await next.click();
  await onStep('Models');
  await snap(page, 'models');

  await next.click();
  await onStep('Workflow roles');
  await snap(page, 'roles');

  await next.click();
  await onStep('Demo');
  await page.getByRole('radio', { name: /^Replay/ }).check();
  await snap(page, 'demo');

  await page.getByRole('button', { name: 'Finish', exact: true }).click();
  await page.getByRole('article', { name: 'Add `slugify(title)`', exact: true }).first().waitFor({ timeout: 60_000 });
  await page.waitForLoadState('networkidle');
  await snap(page, 'board');
});
