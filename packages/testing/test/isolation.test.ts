// The test-isolation guard: the live Kiln's folders always, and each PC's own live folders from
// KILN_TEST_FORBIDDEN_FOLDERS, so the repo never has to name them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { forbiddenFolders } from '@kiln/testing';

test('forbiddenFolders adds every folder named in KILN_TEST_FORBIDDEN_FOLDERS to the live Kiln folders', () => {
  const a = join(tmpdir(), 'kiln-live-a');
  const b = join(tmpdir(), 'kiln-live-b');
  const base = forbiddenFolders({ LOCALAPPDATA: join(tmpdir(), 'appdata') });
  assert.ok(base.includes(join(tmpdir(), 'appdata', 'Kiln')));
  const named = forbiddenFolders({ LOCALAPPDATA: join(tmpdir(), 'appdata'), KILN_TEST_FORBIDDEN_FOLDERS: `${a}${delimiter} ${delimiter}${b}` });
  assert.deepEqual(named, [...base, a, b]);
});
