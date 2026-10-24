import { spawnSync } from 'node:child_process';

// Protects the saved API key with the operating system where one is available, so a copied or backed-up
// credentials file does not contain a usable key:
//   win32  DPAPI (tied to your Windows user account), through PowerShell
//   linux  the desktop keyring, through `secret-tool` (libsecret), when present
//   other  no protection beyond file permissions (0600); macOS Keychain is not used because its command line
//          takes the secret as an argument, which other processes of the same user could see briefly
// Secrets are handed to child processes through the environment or stdin, never on a command line.

const POWERSHELL = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];
const DPAPI_PROTECT = '$s = ConvertTo-SecureString $env:ACP_SECRET -AsPlainText -Force; ConvertFrom-SecureString $s';
const DPAPI_UNPROTECT = "$s = ConvertTo-SecureString $env:ACP_SECRET; [System.Net.NetworkCredential]::new('', $s).Password";

const ps = (run, script, secret) => run('powershell.exe', [...POWERSHELL, script], {
  encoding: 'utf8', windowsHide: true, timeout: 20000, env: { ...process.env, ACP_SECRET: secret },
});
const attrs = (provider) => ['service', 'incognito-acp', 'provider', provider.id];

/** Which protection to use: 'dpapi', 'secret-tool' or 'file' (nothing). `ACP_KEY_STORAGE=file` turns protection off. */
export function chooseBackend({ platform = process.platform, env = process.env, run = spawnSync } = {}) {
  if (env.ACP_KEY_STORAGE === 'file') return 'file';
  if (platform === 'win32') return 'dpapi';
  if (platform === 'linux') {
    const probe = run('secret-tool', ['--version'], { encoding: 'utf8', timeout: 5000 });
    return probe.error || probe.status === null ? 'file' : 'secret-tool';
  }
  return 'file';
}

/** Returns the record to store in credentials.json in place of the plaintext key, or null if protection failed. */
export function protect(backend, provider, key, run = spawnSync) {
  try {
    if (backend === 'dpapi') {
      const r = ps(run, DPAPI_PROTECT, key);
      const blob = String(r.stdout ?? '').trim();
      return r.status === 0 && /^[0-9a-f]+$/i.test(blob) ? { scheme: 'dpapi', apiKeyEncrypted: blob } : null;
    }
    if (backend === 'secret-tool') {
      const r = run('secret-tool', ['store', `--label=Incognito ACP (${provider.title})`, ...attrs(provider)], { input: key, encoding: 'utf8', timeout: 20000 });
      return r.status === 0 ? { scheme: 'secret-tool' } : null;
    }
  } catch { /* fall through to unprotected storage */ }
  return null;
}

/** Recovers the key from a stored record; null when it can't be decrypted (another user or machine, no keyring). */
export function unprotect(record, provider, run = spawnSync) {
  try {
    if (record.scheme === 'dpapi' && record.apiKeyEncrypted) {
      const r = ps(run, DPAPI_UNPROTECT, record.apiKeyEncrypted);
      const key = String(r.stdout ?? '').replace(/\r?\n$/, '');
      return r.status === 0 && key ? key : null;
    }
    if (record.scheme === 'secret-tool') {
      const r = run('secret-tool', ['lookup', ...attrs(provider)], { encoding: 'utf8', timeout: 20000 });
      const key = String(r.stdout ?? '').replace(/\r?\n$/, '');
      return r.status === 0 && key ? key : null;
    }
  } catch { /* treated as "no key" */ }
  return null;
}
