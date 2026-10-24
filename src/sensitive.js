import os from 'node:os';
import path from 'node:path';

// Which files the agent's tools may touch. "blocked" files hold this agent's own credentials and are never readable
// or writable by the model. "sensitive" files are the usual places secrets live; touching one always asks (except in
// Bypass mode), and the contents are still redacted before reaching the model.

const BLOCKED_DIRS = ['.anonrouter-acp', '.venice-acp', '.incognito-acp'];

const SENSITIVE_NAMES = [
  /^\.env(\..+)?$/i, /^\.envrc$/i, /^\.npmrc$/i, /^\.pypirc$/i, /^\.netrc$/i, /^_netrc$/i, /^\.git-credentials$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i, /\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk)$/i,
  /^credentials(\.json)?$/i, /^secrets?\.(json|ya?ml|toml|env)$/i, /^service-account.*\.json$/i, /^kubeconfig$/i, /^acp\.json$/i,
  /^terraform\.tfstate(\.backup)?$/i, /\.tfvars$/i,
];
const SAFE_NAMES = /^\.env\.(example|sample|template|dist|defaults?)$/i; // committed templates, not secrets
const SENSITIVE_DIRS = ['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.config/gcloud'];

const norm = (p) => p.replace(/\\/g, '/');

/** Returns 'blocked', 'sensitive' or null for an absolute path. */
export function classifyPath(abs, { home = os.homedir() } = {}) {
  const p = norm(path.normalize(abs));
  const lower = p.toLowerCase();
  const h = norm(home).toLowerCase();
  const segments = lower.split('/');
  const base = path.posix.basename(p);

  if (BLOCKED_DIRS.some((d) => lower.startsWith(`${h}/${d}/`) || lower === `${h}/${d}`)) return 'blocked';
  if (segments.some((s) => BLOCKED_DIRS.includes(s)) && lower.includes('/credentials.json')) return 'blocked';

  if (SAFE_NAMES.test(base)) return null;
  if (SENSITIVE_NAMES.some((re) => re.test(base))) return 'sensitive';
  if (SENSITIVE_DIRS.some((d) => lower.includes(`/${d}/`) || lower.endsWith(`/${d}`))) return 'sensitive';
  return null;
}

/** For directory scans: should this file name be skipped entirely? */
export const isSensitiveName = (name) => !SAFE_NAMES.test(name) && SENSITIVE_NAMES.some((re) => re.test(name));
