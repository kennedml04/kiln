// The CAD part module's Exit check: every STL in the diff is watertight, that is every edge is shared
// by exactly two triangles. Plain Node, no dependencies; reads ASCII and binary STL.
//
//   node watertight.mjs [file.stl ...]
//
// With no files it checks the STLs changed since $KILN_BASE (the branch the Item's branch started
// from, set by Kiln), or every tracked STL when KILN_BASE is unset. Exits 1 when any is not watertight.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** The triangles of an STL file, each three `x y z` vertex keys. */
function triangles(buffer) {
  if (buffer.length >= 84) {
    const count = buffer.readUInt32LE(80);
    if (buffer.length === 84 + 50 * count) {
      const tris = [];
      for (let i = 0; i < count; i++) {
        const at = 84 + 50 * i + 12; // skip the normal
        const vertex = (v) => [0, 1, 2].map((c) => buffer.readFloatLE(at + 12 * v + 4 * c)).join(' ');
        tris.push([vertex(0), vertex(1), vertex(2)]);
      }
      return tris;
    }
  }
  const vertices = [...buffer.toString('latin1').matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)].map((m) =>
    [m[1], m[2], m[3]].map((n) => String(Number(n))).join(' '),
  );
  if (vertices.length % 3 !== 0) throw new Error(`${vertices.length} vertices is not a whole number of triangles`);
  const tris = [];
  for (let i = 0; i < vertices.length; i += 3) tris.push(vertices.slice(i, i + 3));
  return tris;
}

/** How many edges are not shared by exactly two triangles. */
function openEdges(tris) {
  const ids = new Map();
  const id = (key) => (ids.has(key) ? ids.get(key) : (ids.set(key, ids.size), ids.size - 1));
  const edges = new Map();
  for (const tri of tris) {
    const [a, b, c] = tri.map(id);
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const key = p < q ? `${p},${q}` : `${q},${p}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  return [...edges.values()].filter((n) => n !== 2).length;
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).split('\0').filter(Boolean);

function filesToCheck() {
  const named = process.argv.slice(2);
  if (named.length) return named;
  const base = process.env.KILN_BASE;
  const files = base ? git('diff', '--name-only', '--diff-filter=d', '-z', `${base}...HEAD`) : git('ls-files', '-z');
  return files.filter((f) => /\.stl$/i.test(f));
}

let files;
try {
  files = filesToCheck();
} catch (err) {
  console.error(`Could not list the STLs to check: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
if (files.length === 0) {
  console.log(process.env.KILN_BASE ? 'No STL in the diff.' : 'No STL to check.');
  process.exit(0);
}

let failed = 0;
for (const file of files) {
  let message;
  try {
    const tris = triangles(readFileSync(file));
    const open = tris.length ? openEdges(tris) : 0;
    if (tris.length === 0) message = 'no triangles';
    else if (open) message = `not watertight: ${open} ${open === 1 ? 'edge' : 'edges'} not shared by exactly two triangles`;
    else message = `watertight (${tris.length} triangles)`;
    if (tris.length === 0 || open) failed++;
  } catch (err) {
    failed++;
    message = `cannot read it: ${err instanceof Error ? err.message : String(err)}`;
  }
  console.log(`${file}: ${message}`);
}
if (failed) {
  console.log(`${failed} of ${files.length} STL file(s) failed. Fix the mesh (close holes, fuse touching bodies) and export again.`);
  process.exit(1);
}
