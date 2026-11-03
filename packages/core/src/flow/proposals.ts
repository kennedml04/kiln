// Applying a Project Thread Session's accepted proposal (ticket 13). The Session cannot change the
// Project itself; when a person accepts its proposal Ask, Kiln makes the change as that person and
// audits it as theirs (`proposal.apply`).
import { projectOfThread, type Actor, type ProposalOutcome } from '@kiln/widget-sdk';
import type { AuditLog } from '../audit.ts';
import type { ProposalApplier } from '../asks/ask-service.ts';
import { WorkError, type Work } from '../work/work.ts';
import type { Scheduler } from './scheduler.ts';

export function createProposalApplier({ work, scheduler, audit }: { work: Work; scheduler: Scheduler; audit: AuditLog }): ProposalApplier {
  const record = (actor: Actor, target: string, detail: Record<string, unknown>, failed?: string) =>
    audit.record({
      actor,
      action: 'proposal.apply',
      target,
      outcome: failed ? 'failed' : 'allowed',
      ...(failed ? { reason: failed } : {}),
      detail,
    });

  return async (ask, by) => {
    const projectId = projectOfThread(ask.itemId);
    if (!projectId || !work.project(projectId)) throw new WorkError(409, `The Project of "${ask.itemId}" is gone`);
    const { proposal } = ask;
    const detail = { askId: ask.id, ...(ask.raisedBy.kind === 'session' ? { sessionId: ask.raisedBy.sessionId } : {}), kind: proposal.kind };
    if (proposal.kind === 'reorder_queue') {
      const outside = proposal.order.find((id) => !id.startsWith(`${projectId}/`));
      if (outside) throw new WorkError(409, `"${outside}" is not one of this Project's Items`);
      const state = await scheduler.reorder(proposal.order);
      const outcome: ProposalOutcome = { order: state.queue.filter((e) => e.projectId === projectId).map((e) => e.itemId) };
      record(by, ask.itemId, { ...detail, ...outcome });
      return outcome;
    }
    // Items are created in order, so one may sit under an Item created before it in the same proposal
    // only by naming an Item that already exists. A failure part-way keeps what was created (audited).
    const created: string[] = [];
    for (const request of proposal.items) {
      try {
        created.push((await work.createItem(projectId, request)).id);
      } catch (err) {
        if (created.length) record(by, ask.itemId, { ...detail, created }, String(err instanceof Error ? err.message : err));
        throw err;
      }
    }
    record(by, ask.itemId, { ...detail, created });
    return { created };
  };
}
