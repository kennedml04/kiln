// + Project → Import: what the scan found in the picked folder (docs, test commands, modules, git),
// and the person's choices from it. The scan only reads files; nothing is written until Register.
import { useEffect, useState } from 'react';
import type { ImportOptions, ProjectScan } from '@kiln/widget-sdk';
import { api } from '../store.ts';

const SCAN_DELAY_MS = 300;
/** The radio value for a test command the person types. */
const OTHER = 'other:';

/** Scans `path` (after a pause in typing) and reports the person's choices through `onChange`. */
export function ImportScan({ path, onChange }: { path: string; onChange: (options: ImportOptions) => void }) {
  const [scan, setScan] = useState<ProjectScan>();
  const [command, setCommand] = useState('');
  const [other, setOther] = useState('');
  const [modules, setModules] = useState<string[]>([]);
  const [onboard, setOnboard] = useState(false);

  useEffect(() => {
    setScan(undefined);
    const target = path.trim();
    if (!target) return;
    let live = true;
    const timer = setTimeout(() => {
      api<ProjectScan>('POST', '/api/projects/scan', { path: target }).then(
        (found) => live && setScan(found),
        // A path still being typed, or not a folder: Register says what is wrong.
        () => undefined,
      );
    }, SCAN_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [path]);

  // A new scan starts with nothing ticked.
  useEffect(() => {
    setCommand('');
    setOther('');
    setModules([]);
    setOnboard(false);
  }, [scan]);

  const missing = scan?.docs.filter((d) => !d.found) ?? [];
  const testCommand = command === OTHER ? other.trim() : command;
  const wantsOnboard = onboard && missing.length > 0;
  useEffect(() => {
    onChange({
      ...(testCommand ? { testCommand } : {}),
      ...(modules.length ? { modules } : {}),
      ...(wantsOnboard ? { onboard: true } : {}),
    });
  }, [testCommand, modules, wantsOnboard, onChange]);

  if (!scan) return null;
  const already = new Set(scan.settings.modules ?? []);
  const toggle = (id: string, on: boolean) => setModules((now) => (on ? [...now, id] : now.filter((m) => m !== id)));

  return (
    <section className="import-scan" aria-label="What Import found">
      <p className="import-git">{scan.git.message}</p>

      <h4>Docs</h4>
      <ul className="import-docs">
        {scan.docs.map((doc) => (
          <li key={doc.id}>
            {doc.name}: {doc.found ? `found${doc.paths.length > 1 ? ` (${doc.paths.join(', ')})` : ''}` : 'missing'}
          </li>
        ))}
      </ul>

      <fieldset>
        <legend>Test command</legend>
        {scan.settings.testCommand ? <p>Already set: <code>{scan.settings.testCommand}</code></p> : null}
        <label>
          <input type="radio" name="test-command" checked={command === ''} onChange={() => setCommand('')} />
          {scan.settings.testCommand ? 'Keep it' : 'None for now'}
        </label>
        {scan.testCommands.map((guess) => (
          <label key={guess.command}>
            <input type="radio" name="test-command" checked={command === guess.command} onChange={() => setCommand(guess.command)} />
            <code>{guess.command}</code> <span className="import-why">({guess.source}: {guess.why})</span>
          </label>
        ))}
        <label>
          <input type="radio" name="test-command" checked={command === OTHER} onChange={() => setCommand(OTHER)} />
          Another
        </label>
        {command === OTHER ? (
          <label>
            Your test command
            <input value={other} onChange={(e) => setOther(e.target.value)} spellCheck={false} />
          </label>
        ) : null}
      </fieldset>

      {scan.modules.length ? (
        <fieldset>
          <legend>Modules</legend>
          {scan.modules.map((m) => (
            <label key={m.id}>
              <input
                type="checkbox"
                checked={already.has(m.id) || modules.includes(m.id)}
                disabled={already.has(m.id)}
                onChange={(e) => toggle(m.id, e.target.checked)}
              />
              {m.name}
              <span className="import-why">
                {already.has(m.id) ? ' (already on)' : m.suggested ? ` (suggested: ${m.matches.join(', ')})` : ''} {m.description}
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}

      {missing.length ? (
        <label>
          <input type="checkbox" checked={onboard} onChange={(e) => setOnboard(e.target.checked)} />
          Bring it up to date: an Onboard Story writes the missing docs ({missing.map((d) => d.name).join(', ')})
        </label>
      ) : null}
    </section>
  );
}
