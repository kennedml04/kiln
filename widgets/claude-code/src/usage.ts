// Turns Claude Code's stream into Kiln usage events: after each turn (each `result`), one event for
// the main thread and one for each subagent that ran, per model.
//
// Tokens are what the API returned on each assistant message (deduplicated by message id, since
// Claude Code streams one message's content blocks as separate SDK messages). Claude Code reports
// cost only per model, cumulatively, on `result.modelUsage`; the turn's cost per model is the rise
// since the last result. When the main thread and a subagent share a model, that measured cost is
// split between them by their tokens at the API's relative rates (cache read 0.1, cache write 1.25,
// output 5, against uncached input 1). The parts add up to the cost Claude Code measured.
import type { AgentEvent } from '@kiln/widget-sdk';

type UsageEvent = Extract<AgentEvent, { kind: 'usage' }>;

interface ApiUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

interface Call {
  model: string;
  usage: ApiUsage;
  /** The Agent tool call a subagent's message runs under; null on the main thread. */
  parent: string | null;
}

interface ModelTotals {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
  contextWindow?: number;
}

const n = (value: number | null | undefined) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const weight = (u: ApiUsage) => n(u.input_tokens) + 1.25 * n(u.cache_creation_input_tokens) + 0.1 * n(u.cache_read_input_tokens) + 5 * n(u.output_tokens);

export function createUsageTracker() {
  const calls = new Map<string, Call>();
  /** Agent tool_use id -> the subagent's description. */
  const descriptions = new Map<string, string>();
  const seenTotals = new Map<string, Required<Omit<ModelTotals, 'contextWindow'>>>();
  let turn = 0;

  return {
    /** Feed every SDK message through here. */
    see(message: Record<string, unknown>) {
      if (message.type === 'assistant') {
        const m = message.message as { id?: string; model?: string; usage?: ApiUsage; content?: unknown[] } | undefined;
        if (!m) return;
        for (const block of (m.content ?? []) as { type?: string; id?: string; name?: string; input?: { description?: unknown } }[]) {
          if (block.type === 'tool_use' && (block.name === 'Agent' || block.name === 'Task') && block.id && typeof block.input?.description === 'string') {
            descriptions.set(block.id, block.input.description);
          }
        }
        if (m.id && m.usage && m.model && m.model !== '<synthetic>' && weight(m.usage) > 0) {
          calls.set(m.id, { model: m.model, usage: m.usage, parent: (message.parent_tool_use_id as string | null | undefined) ?? null });
        }
      } else if (message.type === 'system' && message.subtype === 'task_started') {
        if (typeof message.tool_use_id === 'string' && typeof message.description === 'string' && !descriptions.has(message.tool_use_id)) {
          descriptions.set(message.tool_use_id, message.description);
        }
      }
    },

    /** The usage events for the turn a `result` message ends. */
    settle(result: Record<string, unknown>): UsageEvent[] {
      const modelUsage = (result.modelUsage ?? {}) as Record<string, ModelTotals>;
      const pending = [...calls.values()];
      calls.clear();
      const models = new Set([...pending.map((c) => c.model), ...Object.keys(modelUsage)]);
      const events: UsageEvent[] = [];
      for (const model of models) {
        const totals = modelUsage[model];
        const before = seenTotals.get(model) ?? { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0 };
        const now = totals
          ? {
              inputTokens: n(totals.inputTokens),
              outputTokens: n(totals.outputTokens),
              cacheReadInputTokens: n(totals.cacheReadInputTokens),
              cacheCreationInputTokens: n(totals.cacheCreationInputTokens),
              costUSD: n(totals.costUSD),
            }
          : before;
        seenTotals.set(model, now);
        const cost = totals ? Math.max(0, now.costUSD - before.costUSD) : undefined;
        // The model's context window, for Kiln's context alarm.
        const window = n(totals?.contextWindow) > 0 ? { contextWindow: totals!.contextWindow! } : {};
        const mine = pending.filter((c) => c.model === model);
        if (!mine.length) {
          // Usage Claude Code counted without a message we saw: report it on the main thread.
          const input = now.inputTokens - before.inputTokens;
          const output = now.outputTokens - before.outputTokens;
          if (input <= 0 && output <= 0 && !cost) continue;
          events.push({
            kind: 'usage',
            turn: ++turn,
            model,
            inputTokens: Math.max(0, input),
            outputTokens: Math.max(0, output),
            cacheReadTokens: Math.max(0, now.cacheReadInputTokens - before.cacheReadInputTokens),
            cacheWriteTokens: Math.max(0, now.cacheCreationInputTokens - before.cacheCreationInputTokens),
            ...(cost === undefined ? {} : { costUsd: cost }),
            ...window,
          });
          continue;
        }
        const groups = new Map<string | null, Call[]>();
        for (const call of mine) groups.set(call.parent, [...(groups.get(call.parent) ?? []), call]);
        const allWeight = mine.reduce((sum, c) => sum + weight(c.usage), 0);
        for (const [parent, group] of groups) {
          const sum = (pick: (u: ApiUsage) => number | null | undefined) => group.reduce((s, c) => s + n(pick(c.usage)), 0);
          const last = group[group.length - 1]!.usage;
          const share = allWeight > 0 ? group.reduce((s, c) => s + weight(c.usage), 0) / allWeight : 1 / groups.size;
          events.push({
            kind: 'usage',
            turn: ++turn,
            model,
            inputTokens: sum((u) => u.input_tokens),
            outputTokens: sum((u) => u.output_tokens),
            cacheReadTokens: sum((u) => u.cache_read_input_tokens),
            cacheWriteTokens: sum((u) => u.cache_creation_input_tokens),
            contextTokens: n(last.input_tokens) + n(last.cache_read_input_tokens) + n(last.cache_creation_input_tokens),
            ...(cost === undefined ? {} : { costUsd: cost * share }),
            ...window,
            ...(parent ? { subagent: { id: parent, description: descriptions.get(parent) ?? 'subagent' } } : {}),
          });
        }
      }
      return events;
    },
  };
}
