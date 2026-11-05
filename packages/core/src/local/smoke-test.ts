// The smoke test a variant gets when it is added or changed: the model loads, and it answers one
// short Anthropic Messages request (the format Claude Code speaks) with a tool call.
import type { SmokeTestResult } from '@kiln/widget-sdk';
import type { LocalServer, ServerReply } from './local-server.ts';

/** The one tool the smoke test offers. */
export const SMOKE_TOOL = {
  name: 'read_file',
  description: 'Read a file in the project and return its text.',
  input_schema: { type: 'object', properties: { path: { type: 'string', description: 'The file to read' } }, required: ['path'] },
};

interface MessagesReply {
  content?: { type?: string; name?: string; input?: unknown }[];
  stop_reason?: string;
  usage?: { output_tokens?: number };
  /** llama-server adds its own timings to a reply. */
  timings?: { predicted_per_second?: number };
  error?: { message?: string } | string;
}

const errorText = (reply: ServerReply) => {
  const body = reply.body as MessagesReply | string;
  if (typeof body === 'string') return body.slice(0, 200);
  const error = body?.error;
  return typeof error === 'string' ? error : (error?.message ?? JSON.stringify(body).slice(0, 200));
};

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Loads `modelId` (a one-token request, timed as the load) and then asks it to call `read_file`.
 * Passes when the reply has a `tool_use` block for that tool with an object input.
 */
export async function runSmokeTest(server: LocalServer, modelId: string, timeoutMs: number, now: () => Date): Promise<SmokeTestResult> {
  const at = now().toISOString();
  const deadline = Date.now() + timeoutMs;
  const left = () => Math.max(1_000, deadline - Date.now());
  const fail = (reason: string, extra: Partial<SmokeTestResult> = {}): SmokeTestResult => ({ at, passed: false, ...extra, reason });

  let load: ServerReply;
  try {
    load = await server.messages({ model: modelId, max_tokens: 1, messages: [{ role: 'user', content: 'Say OK.' }] }, left());
  } catch (err) {
    return fail(`The local server didn't answer: ${(err as Error).message}`);
  }
  if (load.status !== 200) return fail(`The model didn't load (HTTP ${load.status}): ${errorText(load)}`);
  const loadMs = load.ms;

  let reply: ServerReply;
  try {
    reply = await server.messages(
      {
        model: modelId,
        max_tokens: 256,
        tools: [SMOKE_TOOL],
        messages: [{ role: 'user', content: 'Use the read_file tool to read README.md. Call the tool; do not answer in text.' }],
      },
      left(),
    );
  } catch (err) {
    return fail(`The tool-call request didn't finish: ${(err as Error).message}`, { loadMs });
  }
  if (reply.status !== 200) return fail(`The tool-call request failed (HTTP ${reply.status}): ${errorText(reply)}`, { loadMs });
  const body = reply.body as MessagesReply;
  const outputTokens = body.usage?.output_tokens;
  const perSecond = body.timings?.predicted_per_second ?? (outputTokens && reply.ms > 0 ? outputTokens / (reply.ms / 1000) : undefined);
  const measured = { loadMs, ...(perSecond !== undefined ? { tokensPerSecond: round1(perSecond) } : {}) };
  const calls = (body.content ?? []).filter((block) => block?.type === 'tool_use');
  if (calls.length === 0) return fail(`It answered without calling the tool (stop_reason: ${body.stop_reason ?? 'none'})`, measured);
  const call = calls.find((c) => c.name === SMOKE_TOOL.name);
  if (!call) return fail(`It called a tool Kiln didn't offer: ${calls[0]!.name}`, measured);
  if (!call.input || typeof call.input !== 'object' || Array.isArray(call.input)) return fail('Its tool call had no input object', measured);
  return { at, passed: true, ...measured };
}
