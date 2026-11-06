// The variant picker (local-first Ticket 07): a pure function of the results and the Ticket.
// No clock, no database, no global random source: the caller passes everything in.
import type { TicketSize, VariantResult } from '@kiln/widget-sdk';

/** A variant with fewer results than this for the role goes first. */
export const MIN_RESULTS = 5;
/** One Ticket in this many explores a variant other than the best. */
export const EXPLORE_ONE_IN = 5;
/** This many failures in a row at a size stop a variant getting that size. */
export const CUT_OFF_AFTER = 3;

export interface PickerVariant {
  id: string;
  name: string;
}

export interface PickInput {
  role: string;
  size: TicketSize;
  /** The enabled variants, in list order (ties go to the earlier one). */
  variants: readonly PickerVariant[];
  /** Every recorded result; the picker reads the ones for the role. Oldest first. */
  results: readonly VariantResult[];
  /** A pin on the Ticket, which wins over the pin on the role. */
  ticketPin?: string;
  rolePin?: string;
  /** A random number in [0, 1). Seeded in tests. */
  random: () => number;
}

export interface Pick {
  variant: PickerVariant;
  /** Plain words, shown in the Item's Thread. */
  reason: string;
}

const rate = (results: readonly VariantResult[]) => (results.length ? results.filter((r) => r.passed).length / results.length : 0);
const percent = (n: number) => `${Math.round(n * 100)}%`;

/** Whether the variant's last `CUT_OFF_AFTER` results at this size (oldest first) all failed. */
export function cutOff(results: readonly VariantResult[], size: TicketSize): boolean {
  const atSize = results.filter((r) => r.size === size);
  return atSize.length >= CUT_OFF_AFTER && atSize.slice(-CUT_OFF_AFTER).every((r) => !r.passed);
}

/** A small seeded random source (mulberry32): the same seed gives the same numbers. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A number from text, to seed `seededRandom`. */
export function hashSeed(text: string): number {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

/**
 * The variant for a Ticket of this size in this role, and why. Undefined when no variant may run it
 * (none enabled, or every one is cut off at this size): the caller runs it on cloud and says so.
 */
export function pickVariant(input: PickInput): Pick | undefined {
  const { role, size, variants, random } = input;
  const byId = new Map(variants.map((v) => [v.id, v]));
  const ticketPinned = input.ticketPin ? byId.get(input.ticketPin) : undefined;
  if (ticketPinned) return { variant: ticketPinned, reason: `${ticketPinned.name} is pinned to this Ticket` };
  const rolePinned = input.rolePin ? byId.get(input.rolePin) : undefined;
  if (rolePinned) return { variant: rolePinned, reason: `${rolePinned.name} is pinned to the ${role} role` };

  const forRole = input.results.filter((r) => r.role === role);
  const resultsOf = (v: PickerVariant) => forRole.filter((r) => r.variantId === v.id);
  const skipped = variants.filter((v) => cutOff(resultsOf(v), size));
  const open = variants.filter((v) => !skipped.includes(v));
  if (!open.length) return undefined;

  // A new variant first: the one with the fewest results, then the earlier in the list.
  const fresh = open.filter((v) => resultsOf(v).length < MIN_RESULTS);
  if (fresh.length) {
    const next = fresh.reduce((a, b) => (resultsOf(b).length < resultsOf(a).length ? b : a));
    return { variant: next, reason: `new variant, ${resultsOf(next).length} of ${MIN_RESULTS} results` };
  }

  // The best pass rate at this size; a variant with none at this size is scored on all of its sizes.
  const score = (v: PickerVariant) => {
    const own = resultsOf(v);
    const atSize = own.filter((r) => r.size === size);
    return { rate: rate(atSize.length ? atSize : own), count: (atSize.length ? atSize : own).length };
  };
  const ranked = [...open].sort((a, b) => score(b).rate - score(a).rate || score(b).count - score(a).count);
  const best = ranked[0]!;
  const others = ranked.slice(1);
  const note = skipped.length ? `; ${skipped.map((v) => v.name).join(', ')} skipped after ${CUT_OFF_AFTER} ${size} failures in a row` : '';
  if (others.length && random() < 1 / EXPLORE_ONE_IN) {
    const other = others[Math.floor(random() * others.length)]!;
    return { variant: other, reason: `exploring (1 in ${EXPLORE_ONE_IN}): ${other.name} at ${percent(score(other).rate)} instead of ${best.name} at ${percent(score(best).rate)}${note}` };
  }
  return { variant: best, reason: `best pass rate for ${role} at ${size}: ${percent(score(best).rate)} over ${score(best).count} results${note}` };
}
