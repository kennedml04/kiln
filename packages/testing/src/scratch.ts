// Writes files into a temp repo, and seeds the `.scratch` layout the markdown Tracker reads:
// `.scratch/epics/<epic>.md`, `.scratch/<story>/{story.md,spec.md,issues/NN-<slug>.md}`.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { TempRepo } from './harness.ts';

/** Writes a file at a repo-relative path, creating folders as needed. */
export function writeRepoFile(repo: TempRepo, relativePath: string, content: string): void {
  const file = join(repo.path, relativePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

export function readRepoFile(repo: TempRepo, relativePath: string): string {
  return readFileSync(join(repo.path, relativePath), 'utf8');
}

/**
 * Seeds one Epic (`board-as-home`), one Story under it (`home-board`, at Stage spec, with a spec)
 * and two Tickets of that Story (01 ready, 02 done), then commits them.
 */
export function seedScratch(repo: TempRepo): void {
  writeRepoFile(
    repo,
    '.scratch/epics/board-as-home.md',
    '---\ntitle: Board as home\norder: 1\n---\n\nThe board becomes the home page.\n',
  );
  writeRepoFile(
    repo,
    '.scratch/home-board/story.md',
    '---\ntitle: Home board\nepic: board-as-home\nstage: spec\nblocked-by: []\n---\n\nShow every Project on one board.\n',
  );
  writeRepoFile(repo, '.scratch/home-board/spec.md', '# Spec: Home board\n\nStatus: ready-for-agent\n');
  writeRepoFile(
    repo,
    '.scratch/home-board/issues/01-draw-the-columns.md',
    '# 01: Draw the columns\n\n**What to build:** One column per run state.\n\n**Blocked by:** None\n\n**Status:** ready-for-agent\n\n- [ ] Columns show\n',
  );
  writeRepoFile(
    repo,
    '.scratch/home-board/issues/02-live-updates.md',
    '# 02: Live updates\n\n**What to build:** Patch the board over SSE.\n\n**Blocked by:** 01\n\n**Status:** done\n\n- [x] Updates live\n',
  );
  repo.git('add', '.');
  repo.git('commit', '-q', '-m', 'Seed .scratch');
}
