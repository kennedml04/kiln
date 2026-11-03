// The Agent lifecycle contract, run against the scripted fake Agent.
import { agentLifecycleContract, type LifecycleBehaviour } from '@kiln/testing/agent-lifecycle-contract';
import type { FakeAgentScript } from '@kiln/testing';

const commit: FakeAgentScript = [
  { do: 'write', path: 'contract.txt', content: 'done\n' },
  { do: 'commit', message: 'Contract work' },
];
const turn = { do: 'usage', inputTokens: 100, outputTokens: 20, costUsd: 0.001 } as const;

const SCRIPTS: Record<LifecycleBehaviour, FakeAgentScript> = {
  commit: [turn, ...commit],
  commit_after_feedback: [
    turn,
    { do: 'write', path: 'contract.txt', content: 'draft\n' },
    { do: 'commit', message: 'Draft' },
    { do: 'finish', message: 'Ready.' },
    turn,
    ...commit,
  ],
  // Busy tool work, not turn after turn: 8 turns with no progress is a stall (ticket 16).
  slow_commit: [turn, { do: 'tool', name: 'think', times: 40, intervalMs: 200 }, ...commit],
  run_command: [
    turn,
    { do: 'permission', action: 'other_commands', detail: 'node contract-ran.mjs' },
    { do: 'write', path: 'ran.txt', content: 'yes\n' },
    ...commit,
  ],
  subagent_commit: [turn, { do: 'usage', inputTokens: 40, outputTokens: 10, subagent: { description: 'Look around' } }, ...commit],
  digest_commit: [turn, { do: 'kiln_tool', name: 'write_digest', input: { decided: ['contract'], changed: [], open: [] } }, ...commit],
};

agentLifecycleContract({
  name: 'the fake Agent',
  async install(_t, kiln, behaviour, options) {
    await kiln.installFakeAgent({ script: SCRIPTS[behaviour], cacheLifetimeMs: options.cacheLifetimeMs });
  },
});
