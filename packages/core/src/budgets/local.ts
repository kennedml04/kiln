// The local Budget kind: models served on this machine through an OpenAI-compatible endpoint.
// No money is involved, so a turn costs one turn and the limits are turns and wall time per
// Session (subagents included). Nothing here reads the GPU or the OS: the same Budget works on a
// Windows PC with NVIDIA or an Apple Silicon laptop.
import { LOCAL_DEFAULTS, LOCAL_POOL, LOCAL_POOL_SIZE, type LocalBudgetConfig } from '@kiln/widget-sdk';
import { WorkError } from '../work/work.ts';
import { registerBudgetKind, type BudgetKind } from './kinds.ts';

const positive = (value: unknown, name: string, fallback: number): number => {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new WorkError(400, `"${name}" must be a number above zero`);
  return value;
};

export const localKind: BudgetKind<LocalBudgetConfig> = {
  id: 'local',
  configure(input) {
    const d = LOCAL_DEFAULTS.perSession;
    const perSession = (input.perSession ?? {}) as Record<string, unknown>;
    if (typeof perSession !== 'object' || perSession === null) throw new WorkError(400, '"perSession" must be {turns, minutes}');
    return {
      perSession: {
        turns: positive(perSession.turns, 'perSession.turns', d.turns),
        minutes: positive(perSession.minutes, 'perSession.minutes', d.minutes),
      },
    };
  },
  pools: () => ({ [LOCAL_POOL]: LOCAL_POOL_SIZE }),
  gauge: (_config, { running, poolSize }) => ({
    label: running === 0 ? 'No Sessions running' : `${running} Session${running === 1 ? '' : 's'} running`,
    used: running,
    cap: poolSize(LOCAL_POOL),
    unit: 'Sessions',
  }),
  unit: () => 'turns',
  turnCost: () => 1,
  limits: (config) => [
    { id: 'session-turns', name: 'Session turn limit', scope: 'session', measure: 'turns', cap: config.perSession.turns },
    { id: 'session-time', name: 'Session time limit', scope: 'session', measure: 'minutes', cap: config.perSession.minutes },
  ],
};

registerBudgetKind(localKind);
