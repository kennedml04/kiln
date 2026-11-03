// Checks a Manifest's `coreApi` range against the running core's API version.
// Supports the common semver range forms: `1.2.3`, `^1.2.3`, `~1.2.3`, `>=`, `>`, `<=`, `<`, `=`,
// `*`/`x`, partial versions (`1`, `1.2`), space-separated AND and `||` OR. Prerelease tags are ignored.

type Version = [number, number, number];

const parse = (text: string): { v: Version; parts: number } | undefined => {
  const m = /^v?(\d+|[x*])(?:\.(\d+|[x*]))?(?:\.(\d+|[x*]))?(?:[-+].*)?$/i.exec(text.trim());
  if (!m) return undefined;
  const raw = [m[1], m[2], m[3]];
  const parts = raw.findIndex((p) => p === undefined || /[x*]/i.test(p));
  const n = parts === -1 ? 3 : parts;
  return { v: raw.map((p, i) => (i < n ? Number(p) : 0)) as Version, parts: n };
};

const cmp = (a: Version, b: Version) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** The upper bound (exclusive) when only `parts` leading numbers were given. */
const bump = (v: Version, parts: number): Version | undefined => {
  if (parts === 0) return undefined;
  if (parts === 1) return [v[0] + 1, 0, 0];
  return [v[0], v[1] + 1, 0];
};

function satisfiesComparator(version: Version, comparator: string): boolean | undefined {
  const m = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(comparator);
  if (!m) return undefined;
  const op = m[1] ?? '';
  const target = parse(m[2]!);
  if (!target) return undefined;
  const { v, parts } = target;
  const c = cmp(version, v);
  switch (op) {
    case '>=':
      return c >= 0;
    case '>':
      return parts < 3 ? cmp(version, bump(v, parts) ?? [Infinity, 0, 0]) >= 0 : c > 0;
    case '<=':
      return parts < 3 ? (bump(v, parts) ? cmp(version, bump(v, parts)!) < 0 : true) : c <= 0;
    case '<':
      return c < 0;
    case '^': {
      // ^1.2.3 := <2.0.0, ^0.2.3 := <0.3.0, ^0.0.3 := <0.0.4
      const upper: Version = v[0] > 0 || parts === 1 ? [v[0] + 1, 0, 0] : v[1] > 0 || parts === 2 ? [0, v[1] + 1, 0] : [0, 0, v[2] + 1];
      return c >= 0 && cmp(version, upper) < 0;
    }
    case '~': {
      const upper: Version = parts === 1 ? [v[0] + 1, 0, 0] : [v[0], v[1] + 1, 0];
      return c >= 0 && cmp(version, upper) < 0;
    }
    default: {
      if (parts === 3) return c === 0;
      const upper = bump(v, parts);
      return c >= 0 && (!upper || cmp(version, upper) < 0);
    }
  }
}

/** Whether `version` is in `range`. An unreadable range never matches. */
export function satisfies(version: string, range: string): boolean {
  const parsed = parse(version);
  if (!parsed) return false;
  return range.split('||').some((alternative) => {
    const comparators = alternative.trim().replace(/(\^|~|>=|<=|>|<|=)\s+/g, '$1').split(/\s+/).filter(Boolean);
    if (comparators.length === 0) return false;
    return comparators.every((c) => satisfiesComparator(parsed.v, c) === true);
  });
}
