// Run by cleanup.test.ts in its own `node --test` process; not matched by the suite's glob.
import { test } from 'node:test';
import { onCleanup, startTestKiln } from '@kiln/testing';
import { openShell } from '@kiln/testing/browser';

test('a cleanup of its own fails while the Shell is open', async (t) => {
  const kiln = await startTestKiln(t);
  t.after(() => {
    throw new Error('the test cleanup failed');
  });
  await openShell(t, kiln);
});

test('a harness cleanup that never finishes', async (t) => {
  const kiln = await startTestKiln(t);
  await openShell(t, kiln);
  onCleanup(t, 'wait for nothing', () => new Promise(() => undefined), { timeoutMs: 500 });
});
