// Packaging: `npm pack` contains exactly what a user needs, and the tarball runs through npx the way the ACP
// registry will launch it (`npx <package> <provider>`), with `login` appended for terminal auth.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { root, tmpDir } from './helpers.js';

// Unit tests must never write to a developer's real Keychain or keyring (the service and account names are the real ones).
// Windows DPAPI only writes into the throwaway home folder, so it stays on; test/keyring.js and test/keychain.js are the gated real-store checks.
if (process.platform !== 'win32') process.env.ACP_KEY_STORAGE = 'file';

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const dest = tmpDir();
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32', ...opts });

// ---- what gets published ----
const packed = run(npm, ['pack', '--json', '--pack-destination', dest], { cwd: root });
assert.equal(packed.status, 0, packed.stderr);
const info = JSON.parse(packed.stdout)[0];
const files = info.files.map((f) => f.path.replace(/\\/g, '/'));
for (const must of ['package.json', 'README.md', 'LICENSE', 'src/redact.js', 'src/sensitive.js', 'src/keystore.js', 'bin/anonrouter-venice-acp.js', 'bin/anonrouter-acp.js', 'bin/venice-acp.js', 'src/agent.js', 'src/search-worker.js', 'src/providers/venice.js', 'src/providers/anonrouter.js']) {
  assert.ok(files.includes(must), `missing from package: ${must}`);
}
assert.ok(!files.some((f) => f.startsWith('test/') || f.startsWith('node_modules/') || f.includes('.tmp')), 'tests or junk packed');
assert.ok(info.size < 200 * 1024, `package unexpectedly large: ${info.size} bytes`);
const tarball = path.join(dest, info.filename);

// Every bin points at a real packed file, and the package-named bin exists so npx can pick it without -p.
for (const target of Object.values(pkg.bin)) assert.ok(files.includes(target), `bin target not packed: ${target}`);
assert.ok(pkg.bin[pkg.name], 'a bin named like the package is needed for `npx <package>`');

// ---- run it through npx, as the registry does ----
const home = tmpDir();
const work = tmpDir(); // run from an unrelated folder, as a user's IDE would
const env = { ...process.env, HOME: home, USERPROFILE: home, ANONROUTER_API_KEY: '', VENICE_API_KEY: '' };
const npx = (args, extra = {}) => spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--yes', `--package=${tarball}`, '--', pkg.name, ...args],
  { cwd: work, env: { ...env, ...extra }, shell: process.platform === 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
const collect = (p) => new Promise((resolve) => { let out = ''; let err = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d)); p.on('close', (code) => resolve({ code, out, err })); });

// `--version` reports the package version.
const v = await collect(npx(['--version']));
assert.equal(v.out.trim(), pkg.version, v.err);

// No provider name: usage and a non-zero exit.
const bad = await collect(npx([]));
assert.notEqual(bad.code, 0);
assert.match(bad.err, /Usage: anonrouter-venice-acp/);

// An ACP handshake through npx for each provider (no key set, so an auth method is offered).
for (const [name, title] of [['anonrouter', 'Anonrouter'], ['venice', 'Venice']]) {
  const p = npx([name]);
  const done = collect(p);
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: { auth: { terminal: true } } } }) + '\n');
  await new Promise((r) => setTimeout(r, 4000));
  p.stdin.end();
  const { out } = await done;
  const reply = JSON.parse(out.split('\n').find((l) => l.includes('"id":1')));
  assert.equal(reply.result.agentInfo.name, `${name}-acp`);
  assert.equal(reply.result.agentInfo.title, title);
  assert.equal(reply.result.agentInfo.version, pkg.version);
  assert.ok(reply.result.authMethods.length >= 1, 'registry CI requires an auth method');
  assert.ok(reply.result.authMethods.every((m) => !m.type || m.type === 'agent' || m.type === 'terminal'));
}

// `<provider> login` appended after the provider name saves a key (piped here; a terminal in the IDE).
const login = npx(['venice', 'login']);
const loginDone = collect(login);
login.stdin.write('sk-from-npx\n');
login.stdin.end();
const l = await loginDone;
assert.equal(l.code, 0, l.err);
// The key is stored protected where the OS allows it, so read it back the way the agent does.
process.env.USERPROFILE = home;
process.env.HOME = home;
const { loadApiKey } = await import('../src/credentials.js');
const { venice } = await import('../src/providers/venice.js');
delete process.env.VENICE_API_KEY;
assert.equal(loadApiKey(venice), 'sk-from-npx');

console.log('package OK');
fs.rmSync(dest, { recursive: true, force: true });
