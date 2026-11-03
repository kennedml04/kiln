// The OS credential store: Windows Credential Locker (PasswordVault, through Windows PowerShell)
// or the macOS keychain (the `security` tool). Values never touch disk in Kiln's own files.
//
// On Windows the value travels over stdin, base64-encoded, never on a command line.
// On macOS `security add-generic-password` takes it as an argument, so it is briefly visible to
// other processes of the same user; that is the tool's limit.
import { spawn } from 'node:child_process';

export interface CredentialStore {
  /** e.g. `windows-credential-locker`. */
  kind: string;
  set(resource: string, account: string, value: string): Promise<void>;
  /** The value, or null when there is none. */
  get(resource: string, account: string): Promise<string | null>;
  remove(resource: string, account: string): Promise<void>;
}

const run = (command: string, args: string[], input?: string): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.once('error', rejectRun);
    child.once('close', (code) => resolveRun({ code, stdout, stderr }));
    child.stdin.end(input ?? '');
  });

const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]
$req = [Console]::In.ReadToEnd() | ConvertFrom-Json
$vault = New-Object Windows.Security.Credentials.PasswordVault
function Find($resource, $account) { try { return $vault.Retrieve($resource, $account) } catch { return $null } }
$out = @{ ok = $true }
$found = Find $req.resource $req.account
switch ($req.op) {
  'set' {
    if ($found) { $vault.Remove($found) }
    $value = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($req.value))
    $vault.Add((New-Object Windows.Security.Credentials.PasswordCredential($req.resource, $req.account, $value)))
  }
  'get' {
    if ($found) { $found.RetrievePassword(); $out.value = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($found.Password)) }
  }
  'remove' { if ($found) { $vault.Remove($found) } }
}
[Console]::Out.Write((ConvertTo-Json $out -Compress))
`;

function windowsStore(): CredentialStore {
  const encoded = Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64');
  const call = async (request: Record<string, string>): Promise<{ value?: string }> => {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];
    const { code, stdout, stderr } = await run('powershell.exe', args, JSON.stringify(request));
    if (code !== 0) throw new Error(`The Windows credential store failed (${request.op}): ${stderr.trim() || `exit ${code}`}`);
    return JSON.parse(stdout) as { value?: string };
  };
  return {
    kind: 'windows-credential-locker',
    async set(resource, account, value) {
      await call({ op: 'set', resource, account, value: Buffer.from(value, 'utf8').toString('base64') });
    },
    async get(resource, account) {
      const { value } = await call({ op: 'get', resource, account });
      return value === undefined ? null : Buffer.from(value, 'base64').toString('utf8');
    },
    async remove(resource, account) {
      await call({ op: 'remove', resource, account });
    },
  };
}

function macStore(): CredentialStore {
  const NOT_FOUND = 44;
  return {
    kind: 'macos-keychain',
    async set(resource, account, value) {
      const { code, stderr } = await run('security', ['add-generic-password', '-U', '-s', resource, '-a', account, '-w', value]);
      if (code !== 0) throw new Error(`The keychain failed: ${stderr.trim()}`);
    },
    async get(resource, account) {
      const { code, stdout, stderr } = await run('security', ['find-generic-password', '-s', resource, '-a', account, '-w']);
      if (code === NOT_FOUND) return null;
      if (code !== 0) throw new Error(`The keychain failed: ${stderr.trim()}`);
      return stdout.replace(/\n$/, '');
    },
    async remove(resource, account) {
      const { code, stderr } = await run('security', ['delete-generic-password', '-s', resource, '-a', account]);
      if (code !== 0 && code !== NOT_FOUND) throw new Error(`The keychain failed: ${stderr.trim()}`);
    },
  };
}

/**
 * A store that lives only in this process (`test-memory`). A test core uses it, so tests never
 * write this PC's real credential store; values die with the core.
 */
export function memoryCredentialStore(): CredentialStore {
  const values = new Map<string, string>();
  const key = (resource: string, account: string) => JSON.stringify([resource, account]);
  return {
    kind: 'test-memory',
    async set(resource, account, value) {
      values.set(key(resource, account), value);
    },
    async get(resource, account) {
      return values.get(key(resource, account)) ?? null;
    },
    async remove(resource, account) {
      values.delete(key(resource, account));
    },
  };
}

/** This machine's credential store, or null when Kiln has none for this OS. */
export function osCredentialStore(platform = process.platform): CredentialStore | null {
  if (platform === 'win32') return windowsStore();
  if (platform === 'darwin') return macStore();
  return null;
}
