// Runs in a worker thread so a pathological regex can be terminated instead of freezing the agent.
import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs/promises';
import path from 'node:path';
import { classifyPath } from './sensitive.js';

const { root, cwd, pattern, caseSensitive, glob } = workerData;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'build', 'dist', 'out', 'target', '.gradle', '.idea', '.venv', '__pycache__']);
const MAX_HITS = 200;
const MAX_FILES = 5000;

const globToRegex = (g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\0/g, '.*').replace(/\?/g, '[^/]') + '$');
const re = new RegExp(pattern, caseSensitive ? '' : 'i');
const globRe = glob ? globToRegex(glob) : null;

const display = (abs) => {
  const rel = path.relative(cwd, abs);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : abs;
};

const hits = [];
let files = 0;

const scan = (file, text) => {
  text.split('\n').forEach((line, i) => {
    if (hits.length < MAX_HITS && re.test(line)) hits.push(`${display(file)}:${i + 1}: ${line.trim().slice(0, 200)}`);
  });
};

const walk = async (dir) => {
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (hits.length >= MAX_HITS || files > MAX_FILES) return;
    const full = path.join(dir, e.name);
    if (classifyPath(full)) continue; // credential files and this agent's own data are never scanned
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await walk(full); continue; }
    const rel = path.relative(root, full).split(path.sep).join('/');
    if (globRe && !globRe.test(rel) && !globRe.test(e.name)) continue;
    files++;
    let text;
    try {
      if ((await fs.stat(full)).size > 1_000_000) continue;
      text = await fs.readFile(full, 'utf8');
    } catch { continue; }
    if (text.slice(0, 1000).includes('\0')) continue;
    scan(full, text);
  }
};

const st = await fs.stat(root);
if (st.isDirectory()) await walk(root);
else scan(root, await fs.readFile(root, 'utf8'));

parentPort.postMessage(hits.length ? hits.join('\n') + (hits.length >= MAX_HITS ? `\n…[${MAX_HITS} match limit]` : '') : 'No matches.');
