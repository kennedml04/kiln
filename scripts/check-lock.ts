// Fails when a lock file is out of step with its package.json: the repo root's, and the one in
// each Widget folder that lists npm packages (Kiln installs a git-installed Widget's packages from
// it, see packages/core/src/widgets/sources.ts).
// npm rewrites a lock in place, so after a failure the fixed lock is ready to commit.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const lockOnly = 'npm install --package-lock-only --ignore-scripts --no-audit --no-fund';

const widgetFolders = readdirSync('widgets')
  .map((name) => join('widgets', name))
  .filter((folder) => {
    const pkg = join(folder, 'package.json');
    if (!existsSync(pkg)) return false;
    const { dependencies } = JSON.parse(readFileSync(pkg, 'utf8')) as { dependencies?: Record<string, string> };
    return !!dependencies && Object.keys(dependencies).length > 0;
  });

let failed = false;
for (const folder of ['.', ...widgetFolders]) {
  const lock = join(folder, 'package-lock.json');
  const before = existsSync(lock) ? readFileSync(lock, 'utf8') : null;
  // --prefix keeps npm in the Widget's folder instead of the workspace root.
  execSync(folder === '.' ? lockOnly : `${lockOnly} --prefix .`, { stdio: 'inherit', cwd: folder });
  if (readFileSync(lock, 'utf8') !== before) {
    console.error(`${lock} was ${before === null ? 'missing' : 'out of step with package.json'} and has been written. Commit the new ${lock}.`);
    failed = true;
  }
}
if (failed) process.exit(1);
