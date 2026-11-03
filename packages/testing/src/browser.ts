// Browser end-to-end helpers for the Shell, on top of the core-API harness.
// Kept out of the main entry so API-only tests never load Playwright.
import { chromium, type Page } from 'playwright';
import { TEST_PEER_HEADER, onCleanup, type Cleanup, type TestKiln } from './harness.ts';

export interface OpenShellOptions {
  /** Browse as this tailnet user (Tailscale mode only). Defaults to the person at the PC (Admin). */
  as?: string;
  /** Page size, e.g. `{ width: 390, height: 844 }` for a phone. */
  viewport?: { width: number; height: number };
}

/** Opens the Shell of a test core in a fresh headless Chromium page, closed at the end of the test. */
export async function openShell(t: Cleanup, kiln: TestKiln, path = '/', options: OpenShellOptions = {}): Promise<Page> {
  if (options.as !== undefined && kiln.login !== 'tailscale') throw new Error('openShell({ as }) needs a Tailscale-mode test core');
  const browser = await chromium.launch();
  // Through the harness, so the browser closes even when an earlier cleanup failed: a browser
  // left open keeps the test process alive for ever.
  onCleanup(t, 'close the browser', () => browser.close());
  const context = await browser.newContext({
    ...(options.viewport ? { viewport: options.viewport } : {}),
    ...(options.as !== undefined ? { extraHTTPHeaders: { [TEST_PEER_HEADER]: options.as } } : {}),
  });
  const page = await context.newPage();
  await page.goto(`${kiln.url}${path}`);
  return page;
}
