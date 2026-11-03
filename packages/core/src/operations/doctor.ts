// `kiln doctor`, the core's half: checks only the running core can make, served at GET /api/doctor.
// The CLI adds its own (core reachable, port, data folder, git) and prints them all.
//
// Checks are pluggable. A part of Kiln registers its own with `doctor.register(check)`; a check
// registered with an id that already exists replaces it, which is how a later ticket swaps one of
// the "not configured" placeholders below (knowledge-store, budgets) for a real check.
import type { DoctorCheckResult, DoctorReport, WidgetInfo } from '@kiln/widget-sdk';

/** What a check returns: its result without the id and name, which come from the registration. */
export type DoctorOutcome = Omit<DoctorCheckResult, 'id' | 'name'>;

export interface DoctorCheck {
  /** Stable id, e.g. `budgets`. Registering the same id again replaces the check. */
  id: string;
  /** Shown to people, e.g. "Budgets". */
  name: string;
  /** Must not throw for an expected problem: return `fail` with a plain `fix` instead. */
  run(): DoctorOutcome | Promise<DoctorOutcome>;
}

export interface Doctor {
  register(check: DoctorCheck): void;
  run(): Promise<DoctorReport>;
}

export function createDoctor(): Doctor {
  const checks = new Map<string, DoctorCheck>();
  return {
    register(check) {
      checks.set(check.id, check);
    },
    async run() {
      const results = await Promise.all(
        [...checks.values()].map(async (check): Promise<DoctorCheckResult> => {
          try {
            return { id: check.id, name: check.name, ...(await check.run()) };
          } catch (err) {
            return {
              id: check.id,
              name: check.name,
              status: 'fail',
              detail: `The check itself failed: ${err instanceof Error ? err.message : String(err)}`,
              fix: 'See the core log (core.log in the data folder) and report it.',
            };
          }
        }),
      );
      return { checks: results };
    },
  };
}

/** A placeholder for a part of Kiln that isn't built or set up yet. Replace it by registering the same id. */
export const notConfigured = (id: string, name: string, detail: string): DoctorCheck => ({
  id,
  name,
  run: () => ({ status: 'not-configured', detail }),
});

/** Widget health: crashing, incompatible or waiting Widgets. */
export const widgetsCheck = (list: () => WidgetInfo[]): DoctorCheck => ({
  id: 'widgets',
  name: 'Widget health',
  run() {
    const widgets = list();
    if (widgets.length === 0) return { status: 'pass', detail: 'No Widgets are installed.' };
    const broken = widgets.filter((w) => w.state === 'unhealthy' || w.state === 'incompatible' || w.state === 'restarting');
    if (broken.length) {
      return {
        status: 'fail',
        detail: broken.map((w) => `${w.name} (${w.id}) is ${w.state}${w.problem ? `: ${w.problem}` : ''}`).join('; '),
        fix:
          'Open the Widgets page: read the Widget log (widgets/<id>/widget.log in the data folder), then update the Widget ' +
          'to a working version, or stop or remove it. An incompatible Widget needs a version made for this core.',
      };
    }
    const waiting = widgets.filter((w) => w.state === 'awaiting-approval' || w.pendingUpdate);
    if (waiting.length) {
      return {
        status: 'warn',
        detail: waiting.map((w) => `${w.name} (${w.id}) waits for an Admin to approve ${w.pendingUpdate ? 'an update' : 'it'}`).join('; '),
        fix: 'Review and approve it on the Widgets page, or remove it.',
      };
    }
    return { status: 'pass', detail: `${widgets.length} Widget(s), all healthy.` };
  },
});

/** At least one Agent ready to run a Session. */
export const agentsCheck = (list: () => WidgetInfo[]): DoctorCheck => ({
  id: 'agents',
  name: 'Agents',
  run() {
    const ready = list()
      .filter((w) => w.state === 'ready')
      .flatMap((w) => w.agents.map((a) => `${a.name} (${w.id})`));
    if (ready.length === 0) {
      return {
        status: 'fail',
        detail: 'No Agent is ready, so no Session can start.',
        fix: 'Install and approve an Agent Widget (for example the Claude Code Agent Widget) on the Widgets page, and check it is running.',
      };
    }
    return { status: 'pass', detail: `Ready: ${ready.join(', ')}.` };
  },
});
