// What a module's commands mean on this install: `{moduleDir}` is the module's folder, and
// `{tool:<name>}` the tool's path from the `toolPaths` Setting, else the bare name (found on PATH).
// See `packages/widget-sdk/src/module.ts`.
import type { Module, ModuleMcpServer } from '@kiln/widget-sdk';

const TOOL = /\{tool:([a-z0-9][a-z0-9-]*)\}/g;

export type ToolPaths = Record<string, string> | undefined;

/** A command line, argument or env value of a module with its placeholders filled in. */
export const expandModuleText = (text: string, folder: string, toolPaths: ToolPaths): string =>
  text.replaceAll('{moduleDir}', folder).replace(TOOL, (_, name: string) => toolPaths?.[name] || name);

/** An MCP server entry with its command, args and env filled in; an HTTP or SSE entry as it is. */
export function expandMcpServer(server: ModuleMcpServer, folder: string, toolPaths: ToolPaths): ModuleMcpServer {
  if (!('command' in server)) return server;
  const expand = (text: string) => expandModuleText(text, folder, toolPaths);
  return {
    ...server,
    command: expand(server.command),
    ...(server.args ? { args: server.args.map(expand) } : {}),
    ...(server.env ? { env: Object.fromEntries(Object.entries(server.env).map(([k, v]) => [k, expand(v)])) } : {}),
  };
}

/** Every tool name the modules' commands and MCP servers use, sorted. */
export function toolsOf(modules: Module[]): string[] {
  const texts = modules.flatMap((m) => [
    ...(m.exitChecks ?? []).map((c) => c.command ?? ''),
    ...Object.values(m.mcpServers ?? {}).flatMap((s) =>
      !('command' in s) ? [] : [s.command, ...(s.args ?? []), ...Object.values(s.env ?? {})],
    ),
  ]);
  return [...new Set(texts.flatMap((text) => [...text.matchAll(TOOL)].map((m) => m[1]!)))].sort();
}
