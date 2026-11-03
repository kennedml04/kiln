// Fails when package-lock.json is out of step with the package.json files.
// npm rewrites the lock in place, so after a failure the fixed lock is ready to commit.
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const lock = 'package-lock.json';
const before = readFileSync(lock, 'utf8');
execSync('npm install --package-lock-only --ignore-scripts --no-audit --no-fund', { stdio: 'inherit' });
if (readFileSync(lock, 'utf8') !== before) {
  console.error(`${lock} was out of step with package.json and has been updated. Commit the new ${lock}.`);
  process.exit(1);
}
