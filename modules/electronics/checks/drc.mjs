// The Electronics module's Exit check, "DRC passes". Kiln runs it in the Item's worktree:
//
//   node drc.mjs <kicad-cli> [board ...]
//
// It runs `kicad-cli pcb drc` on each board (by default every .kicad_pcb in the worktree, outside
// out/ and node_modules/) with a JSON report in a temp folder, and fails when the report has any
// error: a violation, an unconnected item or a schematic parity problem of severity "error".
// Warnings are counted but pass. A worktree with no board passes.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { count, findFiles, findTool, missingTool, runTool } from './tool.mjs';

const [given = 'kicad-cli', ...named] = process.argv.slice(2);
const boards = named.length ? named : findFiles(process.cwd(), ['.kicad_pcb']);
if (!boards.length) {
  console.log('No .kicad_pcb board to check.');
  process.exit(0);
}
const tool = findTool(given);
if (!tool) {
  console.error(missingTool('kicad-cli', given));
  process.exit(1);
}

/** One line for a report entry: its type, description and the items it is about. */
function lineOf(entry) {
  const items = (entry.items ?? []).map((i) => i.description).filter(Boolean);
  return `[${entry.type ?? 'drc'}] ${entry.description ?? 'DRC error'}${items.length ? `: ${items.join(', ')}` : ''}`;
}

let failed = false;
for (const board of boards) {
  const out = mkdtempSync(join(tmpdir(), 'kiln-drc-'));
  try {
    const report = join(out, 'drc.json');
    const { code, output } = runTool(tool, ['pcb', 'drc', '--format', 'json', '--severity-all', '--output', report, board]);
    let parsed;
    try {
      parsed = existsSync(report) ? JSON.parse(readFileSync(report, 'utf8')) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!parsed) {
      failed = true;
      console.log(`${board}: kicad-cli wrote no report (exit code ${code})${output ? `\n${output.slice(-1000)}` : ''}`);
      continue;
    }
    const entries = [...(parsed.violations ?? []), ...(parsed.unconnected_items ?? []), ...(parsed.schematic_parity ?? [])];
    const errors = entries.filter((e) => e.severity === 'error');
    const warnings = entries.filter((e) => e.severity === 'warning');
    if (errors.length) {
      failed = true;
      console.log(`${board}: ${count(errors.length, 'DRC error')}${warnings.length ? ` and ${count(warnings.length, 'warning')}` : ''}`);
      for (const error of errors) console.log(`  - ${lineOf(error)}`);
    } else console.log(`${board}: DRC passes${warnings.length ? ` (${count(warnings.length, 'warning')})` : ''}`);
  } finally {
    await rm(out, { recursive: true, force: true, maxRetries: 5 });
  }
}
process.exit(failed ? 1 : 0);
