// The shared Agent contracts, unchanged, against the OpenCode Widget driving a fake `opencode`.
import { agentContract } from '@kiln/testing/agent-contract';
import { agentLifecycleContract, type LifecycleBehaviour } from '@kiln/testing/agent-lifecycle-contract';
import { commitSteps, fakeOpenCode, installOpenCode, type FakeStep } from './support.ts';

agentContract({
  name: 'OpenCode (fake opencode)',
  async install(t, kiln, task) {
    const steps: FakeStep[] =
      task.kind === 'answer'
        ? [
            { do: 'edit', path: 'answer.txt', content: '42\n' },
            { do: 'bash', command: 'git add answer.txt' },
            { do: 'bash', command: 'git commit -q -m "Answer"' },
            { do: 'usage', input: 30, output: 5, cost: 0.001 },
            { do: 'mcp', tool: 'write_digest', args: { decided: ['The answer is 42'], changed: ['answer.txt'], open: [] } },
          ]
        : [{ do: 'bash', command: task.command }, { do: 'usage', input: 30, output: 5, cost: 0.001 }];
    const opencode = fakeOpenCode(t, { steps });
    await installOpenCode(t, kiln, { opencode: opencode.command, model: 'fakeai/cheap-1' });
  },
});

const turn: FakeStep = { do: 'usage', input: 1200, output: 80, cacheRead: 300, cost: 0.002 };

const SCENARIOS: Record<LifecycleBehaviour, FakeStep[]> = {
  commit: [turn, ...commitSteps(), turn],
  commit_after_feedback: [turn, ...commitSteps('draft'), { do: 'end_turn' }, turn, ...commitSteps(), turn],
  slow_commit: [turn, { do: 'wait', ms: 4000 }, ...commitSteps(), turn],
  run_command: [turn, { do: 'bash', command: 'node contract-ran.mjs' }, ...commitSteps(), turn],
  subagent_commit: [turn, { do: 'subagent', description: 'List the files', steps: [{ do: 'usage', input: 400, output: 30, cost: 0.001 }] }, ...commitSteps(), turn],
  digest_commit: [turn, { do: 'mcp', tool: 'write_digest', args: { decided: ['contract'], changed: [], open: [] } }, ...commitSteps(), turn],
};

agentLifecycleContract({
  name: 'OpenCode, faked',
  async install(t, kiln, behaviour, options) {
    const opencode = fakeOpenCode(t, { steps: SCENARIOS[behaviour] });
    await installOpenCode(t, kiln, { opencode: opencode.command, model: 'fakeai/cheap-1', cacheLifetimeMs: options.cacheLifetimeMs });
  },
});
