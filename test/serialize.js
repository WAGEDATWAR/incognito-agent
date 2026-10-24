// Overlapping prompts on one session run one at a time; a prompt superseded while waiting is dropped.
import assert from 'node:assert/strict';
import { say, sse, startClient, startMock, tmpDir } from './helpers.js';

const mock = await startMock({
  models: { data: [{ id: 'm' }] },
  script: (call, body, res) => { if (body.messages.at(-1).content === 'three') sse(res, say('reply')); /* one and two hang until aborted */ },
});
const client = startClient('anonrouter-acp.js', { ANONROUTER_API_KEY: 'k', ANONROUTER_MODEL: 'm', ANONROUTER_BASE_URL: mock.url });
await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
const { sessionId } = await client.request('session/new', { cwd: tmpDir(), mcpServers: [] });
const prompt = (text) => client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });

const p1 = prompt('one');
await new Promise((r) => setTimeout(r, 300)); // let the first request reach the (hanging) provider
const p2 = prompt('two');
const p3 = prompt('three');
const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
assert.equal(r1.stopReason, 'cancelled');
assert.equal(r2.stopReason, 'cancelled'); // superseded by the third (dropped while waiting, or aborted if it had just started)
assert.equal(r3.stopReason, 'end_turn');
assert.ok(mock.calls === 2 || mock.calls === 3);
const roles = mock.bodies.at(-1).messages.map((m) => `${m.role}:${m.content}`);
assert.equal(roles.at(-1), 'user:three');
assert.ok(roles.slice(1).every((r) => r.startsWith('user:'))); // history stays well-formed, no interleaving

console.log('serialize OK');
client.close();
mock.close();
