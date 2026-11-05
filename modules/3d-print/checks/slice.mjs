// The 3D print module's Exit check, "The slice reports no problems". Kiln runs it in the Item's
// worktree:
//
//   node slice.mjs <bambu-studio> [model ...]
//
// It slices each model (by default every .3mf in the worktree, outside out/ and node_modules/) with
// the Bambu Studio CLI into a temp folder, reads the result.json the CLI writes there, and lists
// the problems: a slicing error, a non-zero exit, or any warning on a plate. It exits 1 when any
// model has a problem, so the Agent gets the list as Exit feedback. A worktree with no model passes.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { count, findFiles, findTool, missingTool, runTool } from './tool.mjs';

const [given = 'bambu-studio', ...named] = process.argv.slice(2);
const models = named.length ? named : findFiles(process.cwd(), ['.3mf']);
if (!models.length) {
  console.log('No .3mf model to slice.');
  process.exit(0);
}
const tool = findTool(given);
if (!tool) {
  console.error(missingTool('the Bambu Studio CLI', given));
  process.exit(1);
}

/** A warning entry as the CLI writes it: a string, or an object with its message. */
const messageOf = (entry) => (typeof entry === 'string' ? entry : (entry?.msg ?? entry?.message ?? JSON.stringify(entry)));

/** Every problem in one slice: what the CLI's result says, and its exit code. */
function problemsOf(result, code, output) {
  const problems = [];
  if (!result) {
    problems.push(`Bambu Studio wrote no result.json (exit code ${code})${output ? `: ${output.slice(-1000)}` : ''}`);
    return problems;
  }
  if (result.return_code !== undefined && result.return_code !== 0) {
    problems.push(result.error_string || `Bambu Studio returned ${result.return_code}`);
  }
  for (const plate of result.sliced_plates ?? []) {
    const warnings = plate.warning_message ?? plate.warnings ?? [];
    for (const warning of Array.isArray(warnings) ? warnings : [warnings]) problems.push(`plate ${plate.id ?? '?'}: ${messageOf(warning)}`);
  }
  if (code !== 0 && !problems.length) problems.push(`Bambu Studio exited with ${code}${output ? `: ${output.slice(-1000)}` : ''}`);
  return problems;
}

let failed = false;
for (const model of models) {
  const out = mkdtempSync(join(tmpdir(), 'kiln-slice-'));
  try {
    const { code, output } = runTool(tool, ['--slice', '0', '--outputdir', out, model]);
    const resultFile = join(out, 'result.json');
    let result;
    try {
      result = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, 'utf8')) : undefined;
    } catch {
      result = undefined;
    }
    const problems = problemsOf(result, code, output);
    if (problems.length) {
      failed = true;
      console.log(`${model}: ${count(problems.length, 'problem')}`);
      for (const problem of problems) console.log(`  - ${problem}`);
    } else console.log(`${model}: sliced, no problems`);
  } finally {
    await rm(out, { recursive: true, force: true, maxRetries: 5 });
  }
}
process.exit(failed ? 1 : 0);
