// End-to-end: fake Anonrouter server + fake ACP client driving the real agent process.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { say, sse, startClient, startMock, tmpDir, toolCall } from './helpers.js';

const work = tmpDir();
fs.writeFileSync(path.join(work, 'a.txt'), 'hello world');

const mock = await startMock({
  models: { data: [{ id: 'test-model' }, { id: 'other' }] },
  script: (call, body, res) => {
    if (call === 1) sse(res, [{ error: { message: 'Stream failed', code: 'upstream' } }]); // transient: agent retries
    else if (call === 2) {
      // tool call arguments split across chunks
      sse(res, [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'edit_file', arguments: '{"path":"a.txt","old_str' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ing":"world","new_string":"ACP"}' } }] } }] },
        { choices: [{ finish_reason: 'tool_calls', delta: {} }] },
      ]);
    } else {
      assert.equal(body.messages.at(-1).role, 'tool');
      sse(res, say('Done'));
    }
  },
});

const client = startClient('anonrouter-acp.js',
  { ANONROUTER_API_KEY: 'k', ANONROUTER_MODEL: 'test-model', ANONROUTER_BASE_URL: mock.url },
  (method) => (method === 'session/request_permission' ? { outcome: { outcome: 'selected', optionId: 'allow_once' } } : undefined));

const init = await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
assert.equal(init.protocolVersion, 1);
const ses = await client.request('session/new', { cwd: work, mcpServers: [] });
assert.deepEqual(ses.models.availableModels.map((m) => m.modelId), ['test-model', 'other']);
assert.equal(ses.modes.currentModeId, 'default');
assert.deepEqual(ses.configOptions.map((o) => o.id), ['mode', 'model', 'minimum_privacy', 'sort', 'request_mode', 'fallbacks']);

const r = await client.request('session/prompt', { sessionId: ses.sessionId, prompt: [{ type: 'text', text: 'edit it' }] });
assert.equal(r.stopReason, 'end_turn');
assert.equal(fs.readFileSync(path.join(work, 'a.txt'), 'utf8'), 'hello ACP');
assert.equal(mock.calls, 3); // failed attempt + tool call + final answer
const perm = client.requests.filter((q) => q.method === 'session/request_permission');
assert.equal(perm.length, 1); // Manual mode asks before edits
assert.equal(perm[0].params.toolCall.kind, 'edit');
assert.deepEqual(perm[0].params.toolCall.content[0], { type: 'diff', path: path.join(work, 'a.txt'), oldText: 'hello world', newText: 'hello ACP' });
assert.deepEqual(perm[0].params.options.map((o) => o.kind), ['allow_once', 'allow_always', 'reject_once']);
assert.ok(client.updates.some((u) => u.sessionUpdate === 'tool_call_update' && u.status === 'completed'));
assert.ok(client.updates.some((u) => u.sessionUpdate === 'agent_message_chunk' && u.content.text === 'Done'));
console.log('e2e OK');
client.close();
mock.close();
fs.rmSync(work, { recursive: true, force: true });
