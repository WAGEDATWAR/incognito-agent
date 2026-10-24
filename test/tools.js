// The tools themselves: reading, listing, searching, writing and editing (with the diff previews that approval shows),
// the IDE-backed paths (unsaved buffers, terminals), sensitivity flags, plan updates, and killing a cancelled command.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ToolRunner } from '../src/tools.js';
import { tmpDir } from './helpers.js';

const cwd = tmpDir();
const at = (...p) => path.join(cwd, ...p);
const write = (rel, text) => { fs.mkdirSync(path.dirname(at(rel)), { recursive: true }); fs.writeFileSync(at(rel), text); };
write('src/a.js', 'const hello = 1;\nconst world = 2;\nconst Hello = 3;\n');
write('src/b.txt', 'hello from text\n');
write('src/deep/c.js', 'hello deep\n');
write('node_modules/skip.js', 'hello');
write('.git/config', 'hello');
write('src/evil.txt', `${'a'.repeat(60)}b\n`);
write('lines.txt', Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n'));

const local = new ToolRunner({ rpc: null, sessionId: 's', cwd, caps: {}, log: () => {} });
const prep = (name, args, tools = local) => tools.prepare(name, args);
const run = async (name, args, signal, tools = local) => (await (await prep(name, args, tools)).execute(signal, {})).output;

// ---- read_file and list_dir ----
assert.equal(await run('read_file', { path: 'src/b.txt' }), 'hello from text\n');
assert.equal(await run('read_file', { path: 'lines.txt', line: 3, limit: 2 }), 'line 3\nline 4');
assert.equal(await run('read_file', { path: at('src', 'b.txt') }), 'hello from text\n'); // absolute works too
const readPrep = await prep('read_file', { path: 'lines.txt', line: 4 });
assert.deepEqual(readPrep.locations, [{ path: at('lines.txt'), line: 4 }]);
assert.equal(readPrep.kind, 'read');
write('big.txt', 'x'.repeat(40000));
const big = await run('read_file', { path: 'big.txt' });
assert.ok(big.length < 31000 && big.includes('[truncated 10000 chars]'), 'large files are clipped');
await assert.rejects(run('read_file', { path: 'missing.txt' }), /ENOENT/);
await assert.rejects(prep('read_file', {}), /path is required/);
assert.equal(await run('list_dir', { path: 'src' }), ['a.js', 'b.txt', 'deep/', 'evil.txt'].join('\n'));
fs.mkdirSync(at('emptydir'));
assert.equal(await run('list_dir', { path: 'emptydir' }), '(empty)');
await assert.rejects(prep('nope', {}), /unknown tool/);

// ---- search_files ----
const rel = (...p) => path.join(...p);
assert.equal(await run('search_files', { pattern: 'hello', path: 'src', glob: '*.js' }),
  [`${rel('src', 'a.js')}:1: const hello = 1;`, `${rel('src', 'a.js')}:3: const Hello = 3;`, `${rel('src', 'deep', 'c.js')}:1: hello deep`].join('\n'), 'case-insensitive by default, glob on file names');
assert.equal(await run('search_files', { pattern: 'hello', path: 'src', glob: '*.js', case_sensitive: true }),
  [`${rel('src', 'a.js')}:1: const hello = 1;`, `${rel('src', 'deep', 'c.js')}:1: hello deep`].join('\n'));
assert.equal(await run('search_files', { pattern: 'hello', glob: 'src/deep/*.js' }), `${rel('src', 'deep', 'c.js')}:1: hello deep`, 'glob on relative paths');
assert.match(await run('search_files', { pattern: 'hello', glob: '**/*.txt' }), /b\.txt:1/);
assert.equal(await run('search_files', { pattern: 'hello', glob: '*.md' }), 'No matches.');
assert.equal(await run('search_files', { pattern: 'world', path: 'src/a.js' }), `${rel('src', 'a.js')}:2: const world = 2;`, 'a single file can be the root');
const everywhere = await run('search_files', { pattern: 'hello' });
assert.ok(!everywhere.includes('node_modules') && !everywhere.includes('.git'), 'build and VCS folders are skipped');
await assert.rejects(prep('search_files', { pattern: '(' }), /Invalid regular expression/);
await assert.rejects(prep('search_files', {}), /pattern is required/);

write('many.txt', Array.from({ length: 250 }, () => 'needle').join('\n'));
const capped = await run('search_files', { pattern: 'needle', glob: 'many.txt' });
assert.equal(capped.split('\n').filter((l) => l.includes('many.txt:')).length, 200);
assert.match(capped, /200 match limit/);
write('bin.dat', `binary\0needle`);
write('huge.txt', `${'y'.repeat(1_100_000)}\nneedle\n`);
const skipped = await run('search_files', { pattern: 'needle', glob: '*.dat' });
assert.equal(skipped, 'No matches.', 'binary files are skipped');
assert.equal(await run('search_files', { pattern: 'needle', glob: 'huge.txt' }), 'No matches.', 'files over 1 MB are skipped');
write('.env', 'API_NEEDLE=1\n');
assert.ok(!(await run('search_files', { pattern: 'API_NEEDLE' })).includes('.env'), 'credential files are never searched');

// A catastrophic regex is cut off by the time limit; cancelling aborts a running search.
const t0 = Date.now();
assert.match(await run('search_files', { pattern: '^(a+)+$', path: 'src' }), /Search stopped after|No matches/);
assert.ok(Date.now() - t0 < 15000);
const ac0 = new AbortController();
const aborted = run('search_files', { pattern: '^(a+)+$', path: 'src' }, ac0.signal);
setTimeout(() => ac0.abort(), 100);
await assert.rejects(aborted, { name: 'AbortError' });

// ---- write_file: the preview is the exact change that approval shows ----
const created = await prep('write_file', { path: 'out/new.txt', content: 'fresh\n' });
assert.deepEqual(created.diff, { path: at('out', 'new.txt'), oldText: null, newText: 'fresh\n' });
assert.equal(created.title, 'Create out/new.txt'.replace('/', path.sep));
assert.equal(created.kind, 'edit');
assert.equal(fs.existsSync(at('out')), false, 'preview must not touch the disk');
await created.execute();
assert.equal(fs.readFileSync(at('out', 'new.txt'), 'utf8'), 'fresh\n'); // parent folders are created
const overwrite = await prep('write_file', { path: 'out/new.txt', content: 'second\n' });
assert.deepEqual(overwrite.diff, { path: at('out', 'new.txt'), oldText: 'fresh\n', newText: 'second\n' });
assert.match(overwrite.title, /^Write /);

// ---- edit_file ----
write('e.txt', 'alpha beta alpha\n');
const one = await prep('edit_file', { path: 'e.txt', old_string: 'beta', new_string: 'gamma' });
assert.deepEqual(one.diff, { path: at('e.txt'), oldText: 'alpha beta alpha\n', newText: 'alpha gamma alpha\n' });
assert.equal(fs.readFileSync(at('e.txt'), 'utf8'), 'alpha beta alpha\n', 'preview must not touch the file');
await one.execute();
assert.equal(fs.readFileSync(at('e.txt'), 'utf8'), 'alpha gamma alpha\n');
await assert.rejects(prep('edit_file', { path: 'e.txt', old_string: 'alpha', new_string: 'x' }), /matches 2 places/);
const all = await prep('edit_file', { path: 'e.txt', old_string: 'alpha', new_string: 'x', replace_all: true });
assert.equal(all.diff.newText, 'x gamma x\n');
assert.match((await all.execute()).output, /2 replacement/);
await assert.rejects(prep('edit_file', { path: 'e.txt', old_string: 'absent', new_string: 'x' }), /not found/);
await assert.rejects(prep('edit_file', { path: 'e.txt', old_string: '', new_string: 'x' }), /must not be empty/);
await assert.rejects(prep('edit_file', { path: 'nofile.txt', old_string: 'a', new_string: 'b' }), /ENOENT/);
write('d.txt', 'price: X\n');
assert.equal((await prep('edit_file', { path: 'd.txt', old_string: 'X', new_string: '$& and $1 and $$' })).diff.newText, 'price: $& and $1 and $$\n', 'replacement text is literal');

// ---- through the IDE: unsaved editor buffers and terminals ----
{
  const calls = [];
  const buffers = { [at('buffer.txt')]: 'unsaved edit in the editor\n' };
  const rpc = { request: async (method, p) => {
    calls.push([method, p]);
    if (method === 'fs/read_text_file') { if (p.path in buffers) return { content: buffers[p.path] }; throw new Error('not found'); }
    if (method === 'fs/write_text_file') { buffers[p.path] = p.content; return {}; }
    if (method === 'terminal/create') return { terminalId: 'term-1' };
    if (method === 'terminal/wait_for_exit') return { exitCode: 3 };
    if (method === 'terminal/output') return { output: 'ran fine', truncated: false };
    return {};
  } };
  fs.writeFileSync(at('buffer.txt'), 'older text on disk\n');
  const ide = new ToolRunner({ rpc, sessionId: 'sid', cwd, caps: { fs: { readTextFile: true, writeTextFile: true }, terminal: true }, log: () => {} });

  // Edits start from what the editor shows, not from the stale file on disk, and are written back through the IDE.
  const p = await prep('edit_file', { path: 'buffer.txt', old_string: 'unsaved', new_string: 'saved' }, ide);
  assert.equal(p.diff.oldText, 'unsaved edit in the editor\n');
  await p.execute();
  assert.equal(buffers[at('buffer.txt')], 'saved edit in the editor\n');
  assert.equal(fs.readFileSync(at('buffer.txt'), 'utf8'), 'older text on disk\n', 'the disk file is the IDE\'s to write');
  assert.deepEqual(calls.find((c) => c[0] === 'fs/write_text_file')[1], { sessionId: 'sid', path: at('buffer.txt'), content: 'saved edit in the editor\n' });

  // Line and limit go to the IDE; a file the IDE cannot read is treated as new by write_file.
  buffers[at('lines.txt')] = 'one\ntwo\nthree';
  await run('read_file', { path: 'lines.txt', line: 2, limit: 1 }, undefined, ide);
  assert.deepEqual(calls.filter((c) => c[0] === 'fs/read_text_file').at(-1)[1], { sessionId: 'sid', path: at('lines.txt'), line: 2, limit: 1 });
  assert.equal((await prep('write_file', { path: 'brand-new.txt', content: 'x' }, ide)).diff.oldText, null);

  // Commands run in an IDE terminal that is embedded in the tool call, then released.
  calls.length = 0;
  const hooks = { onTerminal: (id) => calls.push(['hook', id]) };
  const result = await (await prep('run_command', { command: 'echo hi' }, ide)).execute(undefined, hooks);
  assert.equal(result.output, 'ran fine\n[exit 3]');
  assert.equal(result.terminal, true);
  const create = calls.find((c) => c[0] === 'terminal/create')[1];
  assert.deepEqual([create.command, create.args.at(-1), create.cwd], [process.platform === 'win32' ? 'cmd.exe' : 'sh', 'echo hi', cwd]);
  assert.deepEqual(calls.find((c) => c[0] === 'hook'), ['hook', 'term-1']);
  assert.ok(calls.some((c) => c[0] === 'terminal/release'), 'terminal was not released');

  // Cancelling kills the terminal's command.
  calls.length = 0;
  // Like a real IDE terminal: the wait ends when the command is killed.
  let exited;
  const slowRpc = { request: async (method, p) => {
    calls.push([method, p]);
    if (method === 'terminal/create') return { terminalId: 't2' };
    if (method === 'terminal/wait_for_exit') return new Promise((resolve) => { exited = resolve; });
    if (method === 'terminal/kill') exited?.({ exitCode: null, signal: 'SIGKILL' });
    if (method === 'terminal/output') return { output: '', truncated: false };
    return {};
  } };
  const slow = new ToolRunner({ rpc: slowRpc, sessionId: 'sid', cwd, caps: { terminal: true }, log: () => {} });
  const ac = new AbortController();
  const pending = (await prep('run_command', { command: 'sleep 99' }, slow)).execute(ac.signal, {});
  await new Promise((r) => setTimeout(r, 50));
  ac.abort();
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(calls.some((c) => c[0] === 'terminal/kill'), 'abort did not kill the terminal command');
  assert.match((await pending).output, /\[exit SIGKILL\]/, 'the cancelled command did not finish');
}

// ---- approval metadata ----
{
  const cmd = await prep('run_command', { command: '  npm test --silent' });
  assert.deepEqual([cmd.kind, cmd.approvalKey, cmd.approvalLabel], ['execute', 'execute:npm', 'npm']);
  await assert.rejects(prep('run_command', {}), /command is required/);

  // Outside the project (including by ../), sensitive, and both.
  const out = await prep('read_file', { path: '../elsewhere.txt' });
  assert.equal(out.outside, true);
  assert.match(out.title, /\(outside project\)$/);
  assert.equal(out.approvalKey, 'outside:read');
  assert.equal((await prep('write_file', { path: path.join(os.tmpdir(), 'x-outside.txt'), content: 'x' })).approvalKey, 'outside:edit');
  assert.equal((await prep('read_file', { path: 'src/a.js' })).outside, undefined);

  const env = await prep('read_file', { path: '.env' });
  assert.equal(env.sensitive, true);
  assert.equal(env.approvalKey, `sensitive:${at('.env')}`);
  assert.match(env.title, /\(sensitive file\)$/);
  assert.equal((await prep('write_file', { path: 'sub/.env.production', content: 'K=1' })).sensitive, true);
  write('.env.example', 'KEY=\n');
  assert.equal((await prep('read_file', { path: '.env.example' })).sensitive, undefined, 'templates are not secrets');
  const both = await prep('read_file', { path: path.join(os.homedir(), '.ssh', 'config-nonexistent-test') });
  assert.equal(both.sensitive, true);
  assert.equal(both.outside, true);

  // This agent's own data is refused before anything is read, even through an IDE that would happily serve it.
  const seen = [];
  const watching = new ToolRunner({ rpc: { request: async (m) => { seen.push(m); return { content: '' }; } }, sessionId: 's', cwd, caps: { fs: { readTextFile: true } }, log: () => {} });
  await assert.rejects(prep('read_file', { path: path.join(os.homedir(), '.venice-acp', 'credentials.json') }, watching), /blocked: it holds this agent's saved credentials/);
  await assert.rejects(prep('write_file', { path: path.join(os.homedir(), '.anonrouter-acp', 'settings.json'), content: '{}' }, watching), /blocked/);
  assert.deepEqual(seen, [], 'a blocked file was read before the check');
}

// ---- update_plan ----
{
  const plan = await prep('update_plan', { items: [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'weird' }, { content: '', status: 'pending' }] });
  assert.equal(plan.kind, 'think');
  let sent;
  assert.equal((await plan.execute(undefined, { onPlan: (e) => { sent = e; } })).output, 'Plan updated.');
  assert.deepEqual(sent, [{ content: 'a', priority: 'medium', status: 'in_progress' }, { content: 'b', priority: 'medium', status: 'pending' }]);
  await assert.rejects(prep('update_plan', { items: [] }), /non-empty/);
  await assert.rejects(prep('update_plan', {}), /non-empty/);
}

// ---- without an IDE terminal, a cancelled command's whole process tree dies ----
{
  const marker = at('child.pid');
  const script = `require('fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setTimeout(() => {}, 60000)`;
  const ac = new AbortController();
  const finished = (await prep('run_command', { command: `node -e "${script.replace(/"/g, '\\"')}"` })).execute(ac.signal, {});
  for (let i = 0; i < 50 && !fs.existsSync(marker); i++) await new Promise((r) => setTimeout(r, 100));
  const childPid = Number(fs.readFileSync(marker, 'utf8'));
  ac.abort();
  await finished;
  await new Promise((r) => setTimeout(r, 500));
  const alive = process.platform === 'win32'
    ? spawnSync('tasklist', ['/FI', `PID eq ${childPid}`, '/NH']).stdout.toString().includes(String(childPid))
    : (() => { try { process.kill(childPid, 0); return true; } catch { return false; } })();
  assert.equal(alive, false, 'grandchild process survived cancel');
}

console.log('tools OK');
fs.rmSync(cwd, { recursive: true, force: true });
