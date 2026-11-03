import type { Workflow } from '@kiln/widget-sdk';

/** The Workflow a Project uses when it names none. */
export const DEFAULT_WORKFLOW: Workflow = {
  name: 'default',
  kinds: [
    {
      id: 'epic',
      name: 'Epic',
      stages: [
        // An Epic ships once every Story under it has.
        { id: 'roadmap', name: 'Roadmap', rollUp: true },
        { id: 'shipped', name: 'Shipped' },
      ],
    },
    {
      id: 'story',
      name: 'Story',
      parentKind: 'epic',
      // Each Stage works in the Story's own worktree, never the main checkout. Grill merges as soon
      // as its record is committed; Spec and Tickets merge when their Gate is approved, and a
      // rejection reworks them in place. The Story then waits for its Tickets and ships with them.
      stages: [
        // Grill and Spec only talk and write specs: they never push or open PRs.
        {
          id: 'grill',
          name: 'Grill',
          role: 'griller',
          worktree: true,
          exit: ['branch_has_commits', 'grill_record_exists'],
          mergeOnExit: true,
          rework: 'grill',
          policy: { actions: { external_writes: 'deny' } },
        },
        {
          id: 'spec',
          name: 'Spec',
          role: 'spec-writer',
          worktree: true,
          exit: ['branch_has_commits', 'spec_exists'],
          gate: true,
          rework: 'spec',
          policy: { actions: { external_writes: 'deny' } },
        },
        {
          id: 'tickets',
          name: 'Tickets',
          role: 'ticket-writer',
          worktree: true,
          exit: ['children_exist'],
          gate: true,
          rework: 'tickets',
          rollUp: true,
        },
        { id: 'shipped', name: 'Shipped' },
      ],
    },
    {
      id: 'ticket',
      name: 'Ticket',
      parentKind: 'story',
      stages: [
        {
          id: 'implementing',
          name: 'Implementing',
          role: 'implementer',
          worktree: true,
          exit: ['branch_has_commits', 'tree_clean', 'tests_pass'],
        },
        // A fresh review Session works on the Ticket's own branch and commits its findings; then the
        // Gate's Review Ask waits for a person. Approving merges the branch; rejecting sends it back.
        { id: 'review', name: 'Review', role: 'reviewer', worktree: true, exit: ['findings_exist'], gate: true, status: 'in-review' },
        { id: 'shipped', name: 'Shipped', status: 'done' },
      ],
    },
  ],
};
