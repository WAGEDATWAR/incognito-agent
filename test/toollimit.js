// A turn that hits the tool-round limit asks to continue; stop pauses; continue policy never asks.
import assert from 'node:assert/strict';
import { say, sse, startClient, startMock, tmpDir, toolCall } from './helpers.js';

const run = async (env, answer) => {
  let rounds = 0;
  const mock = await startMock({
    models: { data: [{ id: 'm' }] },
    script: (call, body, res) => sse(res, ++rounds <= 5 ? toolCall(`t${call}`, 'list_dir', { path: '.' }) : say('finished')),
  });
  const client = startClient('anonrouter-acp.js', { ANONROUTER_API_KEY: 'k', ANONROUTER_MODEL: 'm', ANONROUTER_BASE_URL: mock.url, ANONROUTER_MAX_TOOL_CALLS: '2', ...env },
    (method) => (method === 'session/request_permission' ? { outcome: answer } : undefined));
  await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const { sessionId } = await client.request('session/new', { cwd: tmpDir(), mcpServers: [] });
  const r = await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'go' }] });
  const asked = client.requests.filter((q) => q.method === 'session/request_permission').length;
  client.close();
  mock.close();
  return { stop: r.stopReason, asked, calls: mock.calls };
};

assert.deepEqual(await run({}, { outcome: 'selected', optionId: 'allow_once' }), { stop: 'end_turn', asked: 2, calls: 6 });
assert.deepEqual(await run({}, { outcome: 'selected', optionId: 'reject_once' }), { stop: 'max_turn_requests', asked: 1, calls: 2 });
assert.deepEqual(await run({ ANONROUTER_ON_TOOL_LIMIT: 'continue' }, undefined), { stop: 'end_turn', asked: 0, calls: 6 });
assert.deepEqual(await run({ ANONROUTER_ON_TOOL_LIMIT: 'stop' }, undefined), { stop: 'max_turn_requests', asked: 0, calls: 2 });
console.log('toollimit OK');
