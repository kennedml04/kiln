// The variant picker (local-first Ticket 07): a pure function of the results and the Ticket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TicketSize, VariantResult } from '@kiln/widget-sdk';
import { cutOff, pickVariant, seededRandom, sizeOfDiff, ticketSize, type PickerVariant } from '@kiln/core/variant-picker';

const A: PickerVariant = { id: 'a', name: 'Alpha' };
const B: PickerVariant = { id: 'b', name: 'Beta' };

let n = 0;
const result = (variantId: string, passed: boolean, size: TicketSize = 'medium', role = 'implementer'): VariantResult => ({
  id: `r${n++}`, variantId, role, size, passed, wallMs: 1000, at: '2026-11-05T00:00:00.000Z',
});
const many = (variantId: string, passes: number, fails: number, size: TicketSize = 'medium') => [
  ...Array.from({ length: passes }, () => result(variantId, true, size)),
  ...Array.from({ length: fails }, () => result(variantId, false, size)),
];
const base = { role: 'implementer', size: 'medium' as TicketSize, random: () => 0.99 };

test('a variant with fewer than 5 results goes first, with the count in the reason', () => {
  const pick = pickVariant({ ...base, variants: [A, B], results: [...many('a', 5, 0), ...many('b', 1, 1)] });
  assert.equal(pick?.variant.id, 'b');
  assert.match(pick!.reason, /new variant, 2 of 5 results/);
  assert.equal(pickVariant({ ...base, variants: [A, B], results: [] })?.variant.id, 'a', 'a tie goes to the earlier variant');
});

test('results for other roles do not count', () => {
  const results = [...many('a', 5, 0), ...Array.from({ length: 5 }, () => result('b', true, 'medium', 'reviewer'))];
  assert.equal(pickVariant({ ...base, variants: [A, B], results })?.variant.id, 'b');
});

test('with 5 results each, the best pass rate for the size wins', () => {
  const results = [...many('a', 3, 2), ...many('b', 4, 1)];
  const pick = pickVariant({ ...base, variants: [A, B], results });
  assert.equal(pick?.variant.id, 'b');
  assert.match(pick!.reason, /best pass rate for implementer at medium: 80%/);
  // The rate is read at the Ticket's size.
  const bySize = [...many('a', 5, 0, 'small'), ...many('a', 0, 5, 'large'), ...many('b', 3, 2, 'small'), ...many('b', 4, 1, 'large')];
  assert.equal(pickVariant({ ...base, size: 'small', variants: [A, B], results: bySize })?.variant.id, 'a');
  assert.equal(pickVariant({ ...base, size: 'large', variants: [A, B], results: bySize })?.variant.id, 'b');
});

test('about 1 Ticket in 5 explores another variant, from a seeded random source', () => {
  const results = [...many('a', 5, 0), ...many('b', 3, 2)];
  const run = (seed: number) => {
    const random = seededRandom(seed);
    return Array.from({ length: 1000 }, () => pickVariant({ ...base, variants: [A, B], results, random })!);
  };
  const first = run(7);
  const explored = first.filter((p) => p.variant.id === 'b');
  assert.ok(explored.length > 140 && explored.length < 260, `explored ${explored.length} of 1000`);
  assert.ok(explored.every((p) => /^exploring \(1 in 5\)/.test(p.reason)));
  assert.deepEqual(run(7).map((p) => p.variant.id), first.map((p) => p.variant.id), 'the same seed picks the same variants');
  // A fixed source: below 0.2 explores, else the best.
  assert.equal(pickVariant({ ...base, variants: [A, B], results, random: () => 0.1 })?.variant.id, 'b');
  assert.equal(pickVariant({ ...base, variants: [A, B], results, random: () => 0.2 })?.variant.id, 'a');
  // With one variant there is nothing else to explore.
  assert.equal(pickVariant({ ...base, variants: [A], results, random: () => 0 })?.variant.id, 'a');
});

test('3 failures in a row at a size cut a variant off that size only', () => {
  const results = [...many('a', 5, 0, 'small'), ...many('a', 0, 3, 'large'), ...many('b', 5, 0, 'large'), ...many('b', 0, 2, 'small')];
  assert.ok(cutOff(results.filter((r) => r.variantId === 'a'), 'large'));
  assert.ok(!cutOff(results.filter((r) => r.variantId === 'a'), 'small'));
  const large = pickVariant({ ...base, size: 'large', variants: [A, B], results });
  assert.equal(large?.variant.id, 'b');
  assert.match(large!.reason, /Alpha skipped after 3 large failures in a row/);
  assert.equal(pickVariant({ ...base, size: 'small', variants: [A, B], results })?.variant.id, 'a');
  // A pass in between ends the run.
  assert.ok(!cutOff([...many('a', 0, 2, 'large'), result('a', true, 'large'), result('a', false, 'large')], 'large'));
  // Every variant cut off: nothing local can run it.
  assert.equal(pickVariant({ ...base, variants: [A], results: many('a', 0, 3) }), undefined);
  assert.equal(pickVariant({ ...base, variants: [], results: [] }), undefined);
});

test('a pin on the Ticket or the role overrides the rules, the Ticket first', () => {
  const results = [...many('a', 5, 0), ...many('b', 0, 5)];
  assert.equal(pickVariant({ ...base, variants: [A, B], results, rolePin: 'b' })?.variant.id, 'b');
  assert.match(pickVariant({ ...base, variants: [A, B], results, rolePin: 'b' })!.reason, /pinned to the implementer role/);
  const both = pickVariant({ ...base, variants: [A, B], results, rolePin: 'a', ticketPin: 'b' });
  assert.equal(both?.variant.id, 'b');
  assert.match(both!.reason, /pinned to this Ticket/);
  // A pin is honoured even on a cut-off size, and a pin on a variant that is not enabled is ignored.
  assert.equal(pickVariant({ ...base, variants: [A, B], results, ticketPin: 'b' })?.variant.id, 'b');
  assert.equal(pickVariant({ ...base, variants: [A], results, ticketPin: 'gone' })?.variant.id, 'a');
});

test('Ticket size comes from earlier diffs, else the estimate, else medium', () => {
  assert.equal(sizeOfDiff(10, 1), 'small');
  assert.equal(sizeOfDiff(41, 1), 'medium');
  assert.equal(sizeOfDiff(10, 4), 'medium');
  assert.equal(sizeOfDiff(251, 2), 'large');
  assert.equal(sizeOfDiff(20, 9), 'large');
  assert.equal(ticketSize([{ diffLines: 10, files: 1 }, { diffLines: 300, files: 2 }], 'small'), 'large');
  assert.equal(ticketSize([], 'Small'), 'small');
  assert.equal(ticketSize([{}], 'large'), 'large');
  assert.equal(ticketSize([], 'huge'), 'medium');
  assert.equal(ticketSize([]), 'medium');
});
