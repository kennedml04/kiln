// The models the setup wizard suggests for the default Workflow's roles, from the Budgets set up in
// the Models step. A suggestion only fills a role with no model yet; the Admin can change any.
import type { BudgetInfo, RoleModel } from '@kiln/widget-sdk';

/** Roles that think more than they type: they get the strongest model. */
const HEAVY_ROLES = new Set(['griller', 'spec-writer', 'reviewer']);

interface Candidate {
  model: string;
  budget: string;
  local: boolean;
  /** 3 strongest .. 1 lightest; a model Kiln can't place counts as mid. */
  tier: number;
  order: number;
}

const tierOf = (model: string) => (/opus/i.test(model) ? 3 : /haiku/i.test(model) ? 1 : 2);

function candidates(budgets: BudgetInfo[]): Candidate[] {
  let order = 0;
  return budgets.flatMap((b) => b.models.map((model) => ({ model, budget: b.id, local: b.kind === 'local', tier: tierOf(model), order: order++ })));
}

/** Strongest first; models in a local Budget after every other, in the order the Budgets list them. */
const byStrength = (a: Candidate, b: Candidate) => Number(a.local) - Number(b.local) || b.tier - a.tier || a.order - b.order;

function pick(all: Candidate[], heavy: boolean): Candidate | undefined {
  const sorted = [...all].sort(byStrength);
  const metered = sorted.filter((c) => !c.local);
  const pool = metered.length ? metered : sorted;
  if (heavy) return pool[0];
  return pool.find((c) => c.tier === 2) ?? pool[0];
}

/** The chat role: a local model if any, else the lightest (Haiku-tier) model, else the default mid model. */
function pickChat(all: Candidate[]): Candidate | undefined {
  return all.find((c) => c.local) ?? all.find((c) => c.tier === 1) ?? pick(all, false);
}

/** A model in another Budget, else a lighter one in the same Budget, else none. */
function fallback(all: Candidate[], main: Candidate): string | undefined {
  const sorted = [...all].sort(byStrength);
  return (sorted.find((c) => c.budget !== main.budget) ?? sorted.find((c) => c.budget === main.budget && c.tier < main.tier))?.model;
}

/**
 * `current` with a suggested model (and fallback) for each of `roles` that has none, or `current`
 * itself when there is nothing to fill.
 */
export function suggestRoles(roles: string[], budgets: BudgetInfo[], current: Record<string, RoleModel>): Record<string, RoleModel> {
  const all = candidates(budgets);
  const missing = roles.filter((role) => !current[role]?.model);
  if (!all.length || !missing.length) return current;
  const next = { ...current };
  for (const role of missing) {
    const main = (role === 'chat' ? pickChat(all) : pick(all, HEAVY_ROLES.has(role)))!;
    const backup = fallback(all, main);
    next[role] = { model: main.model, ...(backup ? { fallbackModel: backup } : {}) };
  }
  return next;
}
