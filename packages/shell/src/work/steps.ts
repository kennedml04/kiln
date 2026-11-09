// Reads a session.progress payload as a one-line step and its detail fields.
export type StepDetail = { label: string; value: string; pre?: boolean };

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const lines = (s: string | undefined) => (s === undefined ? 0 : s.split('\n').length);
const firstLine = (s: string) => s.split('\n').find((l) => l.trim() !== '') ?? '';
const record = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

function firstString(input: Record<string, unknown>): string | undefined {
  for (const v of Object.values(input)) if (typeof v === 'string' && v !== '') return firstLine(v);
  return undefined;
}

function relative(path: string, worktree?: string | null): string {
  if (!worktree) return path;
  const norm = (s: string) => s.replaceAll('\\', '/');
  const root = norm(worktree).replace(/\/$/, '') + '/';
  const p = norm(path);
  return p.toLowerCase().startsWith(root.toLowerCase()) ? p.slice(root.length) : path;
}

export function stepLine(payload: unknown, worktree?: string | null): string {
  const p = record(payload);
  const tool = record(p.tool);
  const name = str(tool.name);
  if (!name) {
    const text = str(p.text);
    return text ? firstLine(text) : 'Working';
  }
  const input = record(tool.input);
  const path = (v: unknown) => {
    const s = str(v);
    return s ? relative(s, worktree) : '';
  };
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  switch (name) {
    case 'Read': {
      const o = typeof input.offset === 'number' ? input.offset : undefined;
      const l = typeof input.limit === 'number' ? input.limit : undefined;
      return `Read ${path(input.file_path)}${o !== undefined && l !== undefined ? `, lines ${o}–${o + l - 1}` : ''}`.trim();
    }
    case 'Write':
      return `Wrote ${path(input.file_path)} (+${lines(str(input.content))} lines)`;
    case 'Edit':
      return `Edited ${path(input.file_path)} (-${lines(str(input.old_string))}/+${lines(str(input.new_string))})`;
    case 'MultiEdit': {
      const n = Array.isArray(input.edits) ? input.edits.length : 0;
      return `Edited ${path(input.file_path)} (${n} edits)`;
    }
    case 'NotebookEdit':
      return `Edited ${path(input.notebook_path)}`;
    case 'Bash':
    case 'PowerShell':
      return `Ran ${firstLine(str(input.command) ?? '')}`.trim();
    case 'Grep':
      return `Searched "${str(input.pattern) ?? ''}"${str(input.path) ? ` in ${path(input.path)}` : ''}`;
    case 'Glob':
      return `Listed ${str(input.pattern) ?? ''}`.trim();
    case 'Task':
    case 'Agent':
      return `Started subagent: ${str(input.description) ?? ''}`.trim();
    case 'WebFetch':
      return `Fetched ${str(input.url) ?? ''}`.trim();
    case 'WebSearch':
      return `Searched the web for "${str(input.query) ?? ''}"`;
    case 'TodoWrite':
      return 'Updated the to-do list';
  }
  const first = firstString(input);
  const label = mcp ? `${mcp[1]}: ${mcp[2]}` : name;
  return first ? `${label} "${first}"` : label;
}

export function stepDetail(payload: unknown, worktree?: string | null): StepDetail[] {
  void worktree;
  const p = record(payload);
  const tool = record(p.tool);
  const name = str(tool.name);
  if (!name) {
    const text = str(p.text);
    return text ? [{ label: 'Note', value: text, pre: true }] : [];
  }
  const input = record(tool.input);
  const out: StepDetail[] = [];
  const add = (label: string, v: unknown, pre = false) => {
    const s = typeof v === 'number' ? String(v) : str(v);
    if (s !== undefined) out.push({ label, value: s, pre });
  };
  switch (name) {
    case 'Read':
      add('Path', input.file_path);
      add('Offset', input.offset);
      add('Limit', input.limit);
      break;
    case 'Write':
      add('Path', input.file_path);
      add('Size', `+${lines(str(input.content))} lines`);
      break;
    case 'Edit':
      add('Path', input.file_path);
      add('Change', `-${lines(str(input.old_string))}/+${lines(str(input.new_string))}`);
      if (input.replace_all === true) add('Scope', 'all occurrences');
      break;
    case 'MultiEdit': {
      add('Path', input.file_path);
      const edits = Array.isArray(input.edits) ? input.edits.map(record) : [];
      add('Edits', `${edits.length} edits`);
      add('Change', `-${edits.reduce((n, e) => n + lines(str(e.old_string)), 0)}/+${edits.reduce((n, e) => n + lines(str(e.new_string)), 0)}`);
      break;
    }
    case 'NotebookEdit':
      add('Path', input.notebook_path);
      add('Cell', input.cell_id);
      add('Mode', input.edit_mode);
      break;
    case 'Bash':
    case 'PowerShell':
      add('Command', input.command, true);
      add('Description', input.description);
      if (input.run_in_background === true) add('Run', 'in background');
      break;
    case 'Grep':
      add('Pattern', input.pattern);
      add('Path', input.path);
      add('Glob', input.glob);
      add('Type', input.type);
      break;
    case 'Glob':
      add('Pattern', input.pattern);
      add('Path', input.path);
      break;
    case 'Task':
    case 'Agent':
      add('Description', input.description);
      add('Subagent type', input.subagent_type);
      add('Prompt', input.prompt, true);
      break;
    case 'WebFetch':
      add('URL', input.url);
      add('Prompt', input.prompt, true);
      break;
    case 'WebSearch':
      add('Query', input.query);
      break;
    case 'TodoWrite':
      if (Array.isArray(input.todos)) {
        for (const t of input.todos.map(record)) add(str(t.status) ?? 'todo', str(t.content) ?? str(t.text));
      }
      break;
    default:
      for (const [k, v] of Object.entries(input)) if (typeof v === 'string') add(k, v, v.includes('\n') || v.length > 80);
  }
  return out;
}

/** Whether opening the step shows more than its line does. */
export function hasDetail(payload: unknown, worktree?: string | null): boolean {
  const p = record(payload);
  if (!record(p.tool).name) {
    const text = str(p.text);
    return !!text && (text.includes('\n') || text.length > 100);
  }
  return stepDetail(payload, worktree).length > 0;
}
