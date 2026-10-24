import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { chooseBackend, protect, unprotect } from './keystore.js';

export const credentialsPath = (provider) => path.join(os.homedir(), provider.credentialsDir, 'credentials.json');

// Decrypting can take a moment (a PowerShell call on Windows), and the key is read on every prompt, so keep it per file version.
const cache = new Map();

function readRecord(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** Key from `<PREFIX>_API_KEY`, else the saved credentials file (decrypted when it is protected). */
export function loadApiKey(provider) {
  const fromEnv = process.env[`${provider.envPrefix}_API_KEY`];
  if (fromEnv) return fromEnv;
  const file = credentialsPath(provider);
  let mtime;
  try { mtime = fs.statSync(file).mtimeMs; } catch { cache.delete(file); return null; }
  const hit = cache.get(file);
  if (hit && hit.mtime === mtime) return hit.key;

  const record = readRecord(file);
  if (!record) return null;
  let key = null;
  if (record.apiKey) {
    key = record.apiKey;
    // A plaintext key from an older version is moved into protected storage the first time it is read.
    const backend = chooseBackend();
    if (backend !== 'file') {
      const protectedRecord = protect(backend, provider, key);
      if (protectedRecord) { writeRecord(file, protectedRecord); mtime = fs.statSync(file).mtimeMs; }
    }
  } else {
    key = unprotect(record, provider);
  }
  cache.set(file, { key, mtime });
  return key;
}

function writeRecord(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(record, null, 2), { mode: 0o600 });
}

/** Saves the key, protected by the OS where possible. Returns the credentials file path. */
export function saveApiKey(provider, apiKey) {
  const file = credentialsPath(provider);
  const backend = chooseBackend();
  const record = (backend !== 'file' && protect(backend, provider, apiKey)) || { apiKey };
  writeRecord(file, record);
  cache.delete(file);
  return file;
}

/** True when the saved key for this provider is stored protected rather than as plaintext. */
export function isKeyProtected(provider) {
  const record = readRecord(credentialsPath(provider));
  return !!record?.scheme;
}

/** Reads one line from the terminal; hides what is typed/pasted when `hidden` is set. */
export function promptLine(question, hidden = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value.trim());
      rl.close();
      if (hidden && process.stdin.isTTY) process.stdout.write('\n');
    };
    if (hidden) {
      const write = rl._writeToOutput.bind(rl);
      let prompted = false;
      rl._writeToOutput = (str) => { if (!prompted) write(str); };
      rl.question(question, finish);
      prompted = true;
    } else {
      rl.question(question, finish);
    }
    rl.on('close', () => finish(''));
  });
}
