// Tool internals: search guard, outside-project flag, and process-tree kill in the no-terminal fallback.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ToolRunner } from '../src/tools.js';
import { tmpDir } from './helpers.js';

const cwd = tmpDir();
fs.mkdirSync(path.join(cwd, 'src'));
fs.mkdirSync(path.join(cwd, 'node_modules'));
fs.writeFileSync(path.join(cwd, 'src', 'a.js'), 'const hello = 1;\nconst world = 2;\n');
fs.writeFileSync(path.join(cwd, 'node_modules', 'skip.js'), 'hello');
fs.writeFileSync(path.join(cwd, 'src', 'evil.txt'), 'a'.repeat(60) + 'b\n');
const tools = new ToolRunner({ rpc: null, sessionId: 's', cwd, caps: {}, log: () => {} });
const run = async (name, args, signal) => (await (await tools.prepare(name, args)).execute(signal)).output;

// Search finds matches, honours glob and skips build/VCS folders.
assert.equal(await run('search_files', { pattern: 'hello' }), `${path.join('src', 'a.js')}:1: const hello = 1;`);
assert.equal(await run('search_files', { pattern: 'hello', glob: '*.txt' }), 'No matches.');
await assert.rejects(tools.prepare('search_files', { pattern: '(' }), /Invalid regular expression/);

// A catastrophic regex is cut off by the time limit instead of freezing the process.
const t0 = Date.now();
const out = await run('search_files', { pattern: '^(a+)+$', path: 'src' });
assert.match(out, /Search stopped after|No matches/);
assert.ok(Date.now() - t0 < 15000);

// Outside-project calls are flagged.
const outside = await tools.prepare('read_file', { path: path.join(path.dirname(cwd), 'x.txt') });
assert.equal(outside.outside, true);
assert.equal(outside.approvalKey, 'outside:read');
assert.equal((await tools.prepare('read_file', { path: 'src/a.js' })).outside, undefined);

// Cancelling a command kills the whole process tree, not just the shell.
const marker = path.join(cwd, 'child.pid');
const script = `require('fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setTimeout(() => {}, 60000)`;
const ac = new AbortController();
const prep = await tools.prepare('run_command', { command: `node -e "${script.replace(/"/g, '\\"')}"` });
const finished = prep.execute(ac.signal);
for (let i = 0; i < 50 && !fs.existsSync(marker); i++) await new Promise((r) => setTimeout(r, 100));
const childPid = Number(fs.readFileSync(marker, 'utf8'));
ac.abort();
await finished;
await new Promise((r) => setTimeout(r, 500));
const alive = process.platform === 'win32'
  ? spawnSync('tasklist', ['/FI', `PID eq ${childPid}`, '/NH']).stdout.toString().includes(String(childPid))
  : (() => { try { process.kill(childPid, 0); return true; } catch { return false; } })();
assert.equal(alive, false, 'grandchild process survived cancel');

console.log('tools OK');
fs.rmSync(cwd, { recursive: true, force: true });
