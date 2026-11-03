// The scripted fake Agent keeps the shared Agent contract, so the contract itself is known to pass
// for a well-behaved Agent.
import { agentContract } from '@kiln/testing/agent-contract';

agentContract({
  name: 'The fake Agent',
  async install(_t, kiln, task) {
    await kiln.installFakeAgent({
      script:
        task.kind === 'answer'
          ? [
              { do: 'write', path: 'answer.txt', content: '42\n' },
              { do: 'commit', message: 'Answer' },
              { do: 'usage', model: 'fake-model', inputTokens: 10, outputTokens: 2, costUsd: 0.001 },
              { do: 'kiln_tool', name: 'write_digest', input: { decided: ['The answer is 42'], changed: ['answer.txt'], open: [] } },
              { do: 'finish' },
            ]
          : [{ do: 'permission', action: 'other_commands', detail: task.command }, { do: 'finish' }],
    });
  },
});
