// Privacy and security: secret redaction, sensitive and blocked files, key protection, retention, /forget, privacy floor.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Redactor, scrub } from '../src/redact.js';
import { classifyPath, isSensitiveName } from '../src/sensitive.js';
import { chooseBackend, protect, unprotect } from '../src/keystore.js';
import { loadApiKey, saveApiKey, isKeyProtected, credentialsPath } from '../src/credentials.js';
import { anonrouter } from '../src/providers/anonrouter.js';
import { venice } from '../src/providers/venice.js';
import { say, sse, startClient, startMock, tmpDir, toolCall } from './helpers.js';

const GH = `ghp_${'a1B2c3D4e5'.repeat(4)}`; // 40 chars, GitHub token shape

// ---- Redactor ----
{
  const r = new Redactor({ known: ['my-private-vendor-key-99'] });
  const text = `token ${GH}\nvendor my-private-vendor-key-99\nDB_PASSWORD=Zz9Zz9Zz9Zz9\npassword = getPassword()\n-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\nmongodb://user:hunter2pw@db/x`;
  const out = r.redact(text);
  for (const secret of [GH, 'my-private-vendor-key-99', 'Zz9Zz9Zz9Zz9', 'hunter2pw', 'BEGIN RSA PRIVATE']) assert.ok(!out.includes(secret), `leaked ${secret}`);
  assert.ok(out.includes('password = getPassword()'), 'a function call is not a secret');
  assert.equal(r.restore(out), text, 'restore returns the original');
  assert.equal(r.redact(`again ${GH}`), `again ${out.match(/\[REDACTED:github-token:\d+\]/)[0]}`, 'same secret, same placeholder');
  assert.deepEqual(r.restoreDeep({ a: [`x ${out.match(/\[REDACTED:github-token:\d+\]/)[0]}`], b: 1 }), { a: [`x ${GH}`], b: 1 });
  assert.equal(Redactor.hasPlaceholder({ p: '[REDACTED:github-token:9]' }), true);
  assert.equal(Redactor.hasPlaceholder({ p: 'plain' }), false);
  assert.equal(new Redactor({ enabled: false }).redact(GH), GH);
  assert.ok(r.total >= 5 && /github-token ×1/.test(r.summary()));
  assert.equal(scrub(`Authorization: Bearer ${'x'.repeat(30)} and ${GH}`), 'Authorization: Bearer [bearer-token hidden] and [github-token hidden]');
}

// ---- path classification ----
{
  const home = os.homedir();
  const norm = (p) => path.join(...p.split('/'));
  assert.equal(classifyPath(path.join(home, '.anonrouter-acp', 'credentials.json')), 'blocked');
  assert.equal(classifyPath(path.join(home, '.venice-acp', 'sessions', 'x.json')), 'blocked');
  assert.equal(classifyPath(path.join(home, '.anonrouter-acp')), 'blocked');
  assert.equal(classifyPath(path.join(home, 'proj', '.env')), 'sensitive');
  assert.equal(classifyPath(path.join(home, 'proj', '.env.production')), 'sensitive');
  assert.equal(classifyPath(path.join(home, 'proj', '.env.example')), null);
  assert.equal(classifyPath(path.join(home, '.ssh', 'config')), 'sensitive');
  assert.equal(classifyPath(path.join(home, 'k', 'id_ed25519')), 'sensitive');
  assert.equal(classifyPath(path.join(home, 'k', 'id_ed25519.pub')), null);
  assert.equal(classifyPath(path.join(home, 'x', 'server.pem')), 'sensitive');
  assert.equal(classifyPath(path.join(home, '.aws', 'credentials')), 'sensitive');
  assert.equal(classifyPath(path.join(home, '.jetbrains', 'acp.json')), 'sensitive');
  assert.equal(classifyPath(path.join(home, 'proj', 'src', 'index.js')), null);
  assert.equal(classifyPath(path.join(home, 'proj', 'environment.js')), null);
  assert.ok(isSensitiveName('.env') && !isSensitiveName('.env.sample'));
  void norm;
}

// ---- key protection backends (commands checked with a fake runner; secrets never on the command line) ----
{
  const calls = [];
  const run = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { status: 0, stdout: 'ab12cd', error: undefined }; };
  assert.equal(chooseBackend({ platform: 'win32', env: {} }), 'dpapi');
  assert.equal(chooseBackend({ platform: 'darwin', env: {} }), 'file');
  assert.equal(chooseBackend({ platform: 'win32', env: { ACP_KEY_STORAGE: 'file' } }), 'file');
  assert.equal(chooseBackend({ platform: 'linux', env: {}, run }), 'secret-tool');
  assert.equal(chooseBackend({ platform: 'linux', env: {}, run: () => ({ error: new Error('ENOENT'), status: null }) }), 'file');

  calls.length = 0;
  assert.deepEqual(protect('secret-tool', anonrouter, 'ar_secret_value_123', run), { scheme: 'secret-tool' });
  assert.equal(calls[0].opts.input, 'ar_secret_value_123');
  assert.ok(!JSON.stringify(calls[0].args).includes('ar_secret_value_123'), 'secret leaked into argv');
  calls.length = 0;
  assert.deepEqual(protect('dpapi', anonrouter, 'ar_secret_value_123', run), { scheme: 'dpapi', apiKeyEncrypted: 'ab12cd' });
  assert.ok(!JSON.stringify(calls[0].args).includes('ar_secret_value_123'));
  assert.equal(calls[0].opts.env.ACP_SECRET, 'ar_secret_value_123');
  assert.equal(protect('dpapi', anonrouter, 'k', () => ({ status: 1, stdout: '' })), null); // failure falls back to plaintext
  assert.equal(unprotect({ scheme: 'secret-tool' }, anonrouter, () => ({ status: 0, stdout: 'the-key\n' })), 'the-key');
  assert.equal(unprotect({ scheme: 'dpapi', apiKeyEncrypted: 'zz' }, anonrouter, () => ({ status: 1, stdout: '' })), null);
}

// ---- saved key: protected on disk where the OS allows, migrated from plaintext, round-trips ----
{
  const home = tmpDir();
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  delete process.env.ANONROUTER_API_KEY;
  const key = 'ar_RoundTripKey1234567890abcd';
  const file = saveApiKey(anonrouter, key);
  assert.equal(loadApiKey(anonrouter), key);
  if (chooseBackend() !== 'file') {
    assert.equal(isKeyProtected(anonrouter), true);
    assert.ok(!fs.readFileSync(file, 'utf8').includes('RoundTripKey'), 'plaintext key on disk');
    fs.writeFileSync(file, JSON.stringify({ apiKey: 'ar_OldPlaintextKey1234567890' })); // an older version's file
    assert.equal(loadApiKey(anonrouter), 'ar_OldPlaintextKey1234567890');
    assert.equal(isKeyProtected(anonrouter), true, 'plaintext file was not migrated');
    assert.ok(!fs.readFileSync(credentialsPath(anonrouter), 'utf8').includes('OldPlaintext'));
  } else {
    console.log('  (no OS key protection on this machine; plaintext 0600 fallback in use)');
  }
}

// ---- the agent: redaction end to end ----
const queue = [];
const mock = await startMock({ models: { data: [{ id: 'm', model_type: 'text', context_window: 100000, capabilities: { tools: true } }] }, script: (call, body, res) => sse(res, queue.shift() ?? say('ok')) });
let answer = { outcome: 'selected', optionId: 'allow_once' };
const start = (env = {}) => startClient('anonrouter-acp.js', { ANONROUTER_API_KEY: 'ar_TestKeyForRedaction1234567890', ANONROUTER_MODEL: 'm', ANONROUTER_BASE_URL: mock.url, ...env },
  (method) => (method === 'session/request_permission' ? { outcome: answer } : undefined));
const work = tmpDir();
fs.writeFileSync(path.join(work, 'config.txt'), `host=x\ntoken=${GH}\n`);
fs.writeFileSync(path.join(work, '.env'), 'API_SECRET=Hh8Hh8Hh8Hh8\n');
fs.writeFileSync(path.join(work, 'plain.txt'), 'hello');

let client = start({ ANONROUTER_MODE: 'acceptEdits' });
await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
let { sessionId } = await client.request('session/new', { cwd: work, mcpServers: [] });
const prompt = (text) => client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
const asked = () => client.requests.filter((q) => q.method === 'session/request_permission');
const reset = () => { client.updates.length = 0; client.requests.length = 0; };
const lastBody = () => JSON.stringify(mock.bodies.at(-1).messages);

// 1. A key in the user's own prompt never reaches the provider, and the user is told.
await prompt(`Please remember my token ${GH} for later`);
assert.ok(!lastBody().includes(GH), 'token reached the provider');
assert.match(lastBody(), /\[REDACTED:github-token:1\]/);
assert.ok(client.updates.some((u) => u.sessionUpdate === 'agent_thought_chunk' && /Kept 1 secret out of the request/.test(u.content.text)));

// 2. A secret inside a file the model reads is redacted in the tool result it receives.
reset();
queue.push(toolCall('r1', 'read_file', { path: 'config.txt' }), say('read it'));
await prompt('read config.txt');
const toolMsg = mock.bodies.at(-1).messages.find((m) => m.tool_call_id === 'r1').content;
assert.ok(!toolMsg.includes(GH) && toolMsg.includes('[REDACTED:github-token:1]'));

// 3. The model uses the placeholder in a tool call: the real value is written to the file.
reset();
queue.push(toolCall('w1', 'write_file', { path: 'copy.txt', content: 'token=[REDACTED:github-token:1]\n' }), say('written'));
await prompt('copy the config');
assert.equal(fs.readFileSync(path.join(work, 'copy.txt'), 'utf8'), `token=${GH}\n`);

// 4. A placeholder this chat can't resolve is refused rather than written.
reset();
queue.push(toolCall('w2', 'write_file', { path: 'bad.txt', content: 'k=[REDACTED:api-key:42]' }), say('ok'));
await prompt('write it');
assert.ok(!fs.existsSync(path.join(work, 'bad.txt')));
assert.match(mock.bodies.at(-1).messages.find((m) => m.tool_call_id === 'w2').content, /placeholder that this chat cannot resolve/);

// 5. The saved chat on disk holds placeholders only.
await new Promise((r) => setTimeout(r, 200));
const sessDir = path.join(client.home, '.anonrouter-acp', 'sessions');
const saved = fs.readdirSync(sessDir).map((f) => fs.readFileSync(path.join(sessDir, f), 'utf8')).join('');
assert.ok(saved.includes('REDACTED:github-token'), 'session was not saved');
assert.ok(!saved.includes(GH), 'a token was saved to disk');

// 6. Sensitive files ask every time (even in Accept edits), with no "always allow"; plain files don't.
reset();
queue.push(toolCall('e1', 'read_file', { path: '.env' }), say('done'));
await prompt('read .env');
assert.equal(asked().length, 1);
assert.match(asked()[0].params.toolCall.title, /sensitive file/);
assert.deepEqual(asked()[0].params.options.map((o) => o.kind), ['allow_once', 'reject_once']);
assert.ok(!mock.bodies.at(-1).messages.find((m) => m.tool_call_id === 'e1').content.includes('Hh8Hh8Hh8Hh8'), 'secret in .env reached the model');
reset();
queue.push(toolCall('e2', 'read_file', { path: 'plain.txt' }), say('done'));
await prompt('read plain.txt');
assert.equal(asked().length, 0);

// 7. Denying a sensitive read keeps the file's contents away from the model.
reset();
answer = { outcome: 'selected', optionId: 'reject_once' };
queue.push(toolCall('e3', 'read_file', { path: '.env' }), say('done'));
await prompt('read .env again');
assert.match(mock.bodies.at(-1).messages.find((m) => m.tool_call_id === 'e3').content, /denied/);
answer = { outcome: 'selected', optionId: 'allow_once' };

// 8. This agent's own credential files are blocked outright, with no prompt, whatever the mode.
const secretFile = path.join(client.home, '.anonrouter-acp', 'credentials.json');
fs.mkdirSync(path.dirname(secretFile), { recursive: true });
fs.writeFileSync(secretFile, '{"apiKey":"ar_ShouldNeverBeRead1234567890"}');
reset();
queue.push(toolCall('b1', 'read_file', { path: secretFile }), toolCall('b2', 'write_file', { path: secretFile, content: 'x' }), say('done'));
await prompt('read your credentials');
assert.equal(asked().length, 0);
assert.match(mock.bodies.at(-1).messages.find((m) => m.tool_call_id === 'b1').content, /blocked: it holds this agent's saved credentials/);
assert.equal(fs.readFileSync(secretFile, 'utf8'), '{"apiKey":"ar_ShouldNeverBeRead1234567890"}');

// 9. Searches never scan credential files.
reset();
queue.push(toolCall('s1', 'search_files', { pattern: 'API_SECRET|token=' }), say('done'));
await prompt('search for secrets');
const found = mock.bodies.at(-1).messages.find((m) => m.tool_call_id === 's1').content;
assert.ok(!found.includes('.env'), 'search scanned a .env file');

// 10. /status counts what was kept out; /forget deletes the saved chat and stops saving.
reset();
await prompt('/status');
assert.match(client.updates.filter((u) => u.sessionUpdate === 'agent_message_chunk').map((u) => u.content.text).join(''), /Secrets kept out of requests:\*\* github-token ×1/);
assert.ok(fs.readdirSync(sessDir).some((f) => f.includes(sessionId)));
reset();
await prompt('/forget');
assert.ok(!fs.readdirSync(sessDir).some((f) => f.includes(sessionId)), 'chat file survived /forget');
await prompt('this should not be saved');
await new Promise((r) => setTimeout(r, 200));
assert.ok(!fs.readdirSync(sessDir).some((f) => f.includes(sessionId)), 'chat was saved again after /forget');
assert.equal(mock.bodies.at(-1).messages.length, 2, 'history was not cleared'); // system + the new user message
client.close();

// 11. Redaction can be switched off, and then nothing is replaced.
client = start({ ANONROUTER_REDACT_SECRETS: 'off' });
await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
sessionId = (await client.request('session/new', { cwd: work, mcpServers: [] })).sessionId;
await prompt(`token ${GH}`);
assert.ok(lastBody().includes(GH));
client.close();

// 12. Retention: an old chat is deleted at startup, a recent one kept; /forget all clears everything.
{
  const home = tmpDir();
  const dir = path.join(home, '.anonrouter-acp', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const write = (id, daysAgo) => fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, cwd: work, title: id, updatedAt: new Date(Date.now() - daysAgo * 86400000).toISOString(), messages: [] }));
  write('old', 45);
  write('recent', 2);
  const c = startClient('anonrouter-acp.js', { ANONROUTER_API_KEY: 'k', ANONROUTER_MODEL: 'm', ANONROUTER_BASE_URL: mock.url, HOME: home, USERPROFILE: home }, () => undefined);
  await c.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  assert.deepEqual(fs.readdirSync(dir), ['recent.json']);
  const ses = await c.request('session/new', { cwd: work, mcpServers: [] });
  await c.request('session/prompt', { sessionId: ses.sessionId, prompt: [{ type: 'text', text: '/forget all' }] });
  assert.deepEqual(fs.readdirSync(dir), []);
  c.close();
  // Retention can be turned off with 0.
  write('ancient', 400);
  const c2 = startClient('anonrouter-acp.js', { ANONROUTER_API_KEY: 'k', ANONROUTER_MODEL: 'm', ANONROUTER_BASE_URL: mock.url, ANONROUTER_SESSION_RETENTION_DAYS: '0', HOME: home, USERPROFILE: home }, () => undefined);
  await c2.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  assert.deepEqual(fs.readdirSync(dir), ['ancient.json']);
  c2.close();
}
mock.close();

// ---- Venice privacy floor ----
{
  const vmodel = (id, privacy) => ({ id, type: 'text', model_spec: { name: id, privacy, availableContextTokens: 100000, capabilities: { supportsFunctionCalling: true } } });
  const vmock = await startMock({ models: { data: [vmodel('open-a', 'anonymized'), vmodel('priv-b', 'private')] }, script: (call, body, res) => sse(res, say('ok')) });
  const c = startClient('venice-acp.js', { VENICE_API_KEY: 'k', VENICE_MODEL: 'open-a', VENICE_BASE_URL: vmock.url, VENICE_MODE: 'bypassPermissions' }, () => undefined);
  await c.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const ses = await c.request('session/new', { cwd: tmpDir(), mcpServers: [] });
  const options = (r) => r.configOptions.find((o) => o.id === 'model').options.map((o) => o.value);
  assert.deepEqual(options(ses), ['open-a', 'priv-b']);

  const set = await c.request('session/set_config_option', { sessionId: ses.sessionId, configId: 'minimum_privacy', value: 'private' });
  assert.deepEqual(options(set), ['priv-b'], 'anonymized model still offered');
  await assert.rejects(c.request('session/set_config_option', { sessionId: ses.sessionId, configId: 'model', value: 'open-a' }), /not a private model/);

  // The model chosen before the floor was raised is refused at send time, and nothing is sent.
  const before = vmock.calls;
  await c.request('session/prompt', { sessionId: ses.sessionId, prompt: [{ type: 'text', text: 'hi' }] });
  assert.equal(vmock.calls, before, 'a request was sent to a disallowed model');
  assert.ok(c.updates.some((u) => u.sessionUpdate === 'agent_message_chunk' && /not a private model/.test(u.content.text)));

  await c.request('session/set_config_option', { sessionId: ses.sessionId, configId: 'model', value: 'priv-b' });
  await c.request('session/prompt', { sessionId: ses.sessionId, prompt: [{ type: 'text', text: 'hi again' }] });
  assert.equal(vmock.calls, before + 1);
  assert.equal(venice.allowsModel({ model: { name: 'x', privacy: 'anonymized' }, env: { VENICE_MIN_PRIVACY: 'private' }, settings: {} }) !== null, true);
  assert.equal(venice.allowsModel({ model: { name: 'x', privacy: 'anonymized' }, env: { VENICE_MIN_PRIVACY: 'private' }, settings: { minimum_privacy: 'any' } }), null);
  c.close();
  vmock.close();
}

console.log('privacy OK');
