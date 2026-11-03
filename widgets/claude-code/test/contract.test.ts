// The Claude Code Widget keeps the shared Agent contract: always with the fake SDK, and against real
// Claude Code only when KILN_REAL_CLAUDE=1 is set. The real run spends money (or Max plan quota):
//   KILN_REAL_CLAUDE=1 node --test --test-timeout=600000 widgets/claude-code/test/contract.test.ts
// It uses the cheapest model on a tiny Ticket, with Claude Code's own budget cap on each Session.
import { agentContract } from '@kiln/testing/agent-contract';
import { installClaudeCode, installClaudeCodeWidget } from './install.ts';

const COMMIT = { tool: 'Bash', input: { command: 'git add answer.txt && git commit -q -m "Answer"' } };

agentContract({
  name: 'Claude Code (fake SDK)',
  async install(t, kiln, task) {
    await installClaudeCode(t, kiln, {
      turns:
        task.kind === 'answer'
          ? [
              [
                { tool: 'Write', input: { file_path: 'answer.txt', content: '42\n' } },
                COMMIT,
                { assistant: { model: 'claude-haiku-5-5', usage: { input_tokens: 30, output_tokens: 5 }, costUsd: 0.001 } },
                { tool: 'mcp__kiln__write_digest', input: { decided: ['The answer is 42'], changed: ['answer.txt'], open: [] } },
                { text: 'Done.' },
              ],
            ]
          : [[{ tool: 'Bash', input: { command: task.command } }, { text: 'It was denied, so I stopped.' }]],
    });
  },
});

/** The most one real Session may spend, in dollars; Claude Code stops the Session there. */
const REAL_BUDGET_USD = 0.04;

agentContract({
  name: 'Claude Code (real, haiku)',
  skip: process.env.KILN_REAL_CLAUDE === '1' ? false : 'a paid run: set KILN_REAL_CLAUDE=1 to run it',
  timeoutMs: 240_000,
  async install(_t, kiln) {
    await installClaudeCodeWidget(kiln, { model: 'haiku', maxBudgetUsd: REAL_BUDGET_USD });
  },
});
