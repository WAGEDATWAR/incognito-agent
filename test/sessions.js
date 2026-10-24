// Saved sessions: listed, loaded with the whole conversation replayed, and continued with their history.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { say, sse, startClient, startMock, tmpDir, toolCall } from './helpers.js';

const queue = [];
const mock = await startMock({ models: { data: [{ id: 'm' }] }, script: (call, body, res) => sse(res, queue.shift() ?? say('ok')) });
const env = { ANONROUTER_API_KEY: 'k', ANONROUTER_MODEL: 'm', ANONROUTER_BASE_URL: mock.url, ANONROUTER_MODE: 'bypassPermissions' };
const cwd = tmpDir();
fs.writeFileSync(`${cwd}/a.txt`, 'file body');

// First run: a conversation with a tool call.
const first = startClient('anonrouter-acp.js', env, () => undefined);
const init = await first.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
assert.equal(init.agentCapabilities.loadSession, true);
assert.deepEqual(init.agentCapabilities.sessionCapabilities, { list: {} });
const { sessionId } = await first.request('session/new', { cwd, mcpServers: [] });
queue.push(toolCall('t1', 'read_file', { path: 'a.txt' }), say('It says file body.'));
await first.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'read a.txt please' }] });
assert.ok(first.updates.some((u) => u.sessionUpdate === 'session_info_update' && u.title === 'read a.txt please'));
const home = first.home;
first.close();
await new Promise((r) => setTimeout(r, 300));

// Second run (same home): list, load, replay, continue.
const second = startClient('anonrouter-acp.js', { ...env, HOME: home, USERPROFILE: home }, () => undefined);
await second.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
const listed = await second.request('session/list', { cwd });
assert.equal(listed.sessions.length, 1);
assert.equal(listed.sessions[0].sessionId, sessionId);
assert.equal(listed.sessions[0].title, 'read a.txt please');
assert.deepEqual((await second.request('session/list', { cwd: tmpDir() })).sessions, []);

const state = await second.request('session/load', { sessionId, cwd, mcpServers: [] });
assert.equal(state.models.currentModelId, 'm');
const kinds = second.updates.map((u) => u.sessionUpdate);
assert.deepEqual(kinds.slice(0, 4), ['user_message_chunk', 'tool_call', 'tool_call_update', 'agent_message_chunk']);
assert.equal(second.updates[0].content.text, 'read a.txt please');
assert.equal(second.updates[1].toolCallId, 't1');
assert.equal(second.updates[3].content.text, 'It says file body.');

await second.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'and again?' }] });
const roles = mock.bodies.at(-1).messages.map((m) => m.role);
assert.deepEqual(roles, ['system', 'user', 'assistant', 'tool', 'assistant', 'user']);

await assert.rejects(second.request('session/load', { sessionId: 'nope', cwd, mcpServers: [] }), /no saved session/);
console.log('sessions OK');

// Turning saving off disables the capability.
const off = startClient('anonrouter-acp.js', { ...env, ANONROUTER_SAVE_SESSIONS: 'off' }, () => undefined);
assert.equal((await off.request('initialize', { protocolVersion: 1, clientCapabilities: {} })).agentCapabilities.loadSession, false);

second.close();
off.close();
mock.close();
