// Phase 2 features: capability parsing, non-streaming, truncation, images, slash commands, plan, stalls, retries.
import assert from 'node:assert/strict';
import { anonrouter } from '../src/providers/anonrouter.js';
import { say, sse, startClient, startMock, tmpDir, toolCall } from './helpers.js';

// ---- Anonrouter capability parsing (shape taken from the live /v1/models response) ----
const caps = (over = {}) => ({ embeddings: false, streaming: true, tools: true, vision: false, web: false, reasoning: { supported: false }, ...over });
const parsed = anonrouter.parseModels({
  data: [
    { id: 'a/think', model_type: 'text', context_window: 1000, max_output_tokens: 99, capabilities: caps({ vision: true, reasoning: { supported: true, effort_configurable: true, supported_efforts: ['low', 'high'], can_disable: true, always_on: false } }) },
    { id: 'a/fixed', model_type: 'text', capabilities: caps({ reasoning: { supported: true, effort_configurable: false, supported_efforts: [], always_on: true } }) },
    { id: 'a/notools', model_type: 'text', capabilities: caps({ tools: false, streaming: false }) },
    { id: 'a/img', model_type: 'image', capabilities: caps() },
  ],
});
assert.deepEqual(parsed.map((m) => m.id), ['a/think', 'a/fixed', 'a/notools']);
assert.deepEqual(parsed[0].efforts, ['none', 'low', 'high']);
assert.equal(parsed[0].vision, true);
assert.equal(parsed[0].maxOut, 99);
assert.deepEqual(parsed[1].efforts, []);
assert.equal(parsed[1].reasoning, true);
assert.equal(parsed[2].name, 'a/notools (no tools)');
assert.equal(parsed[2].tools, false);
assert.equal(parsed[2].streaming, false);
assert.deepEqual(anonrouter.requestExtras({ effort: 'high', env: {} }), { reasoning_effort: 'high', provider: { require_parameters: true } });
assert.match(anonrouter.explainError(400, { error: { code: 'reasoning_not_disableable' } }), /always reasons/);

// ---- agent behaviour against a scripted provider ----
const models = {
  data: [
    { id: 'vis', model_type: 'text', context_window: 100000, capabilities: caps({ vision: true }) },
    { id: 'novis', model_type: 'text', capabilities: caps() },
    { id: 'nostream', model_type: 'text', capabilities: caps({ streaming: false }) },
    { id: 'notools', model_type: 'text', capabilities: caps({ tools: false }) },
  ],
};
const queue = [];
let rateLimitNext = false;
const mock = await startMock({
  models,
  script: (call, body, res) => {
    if (rateLimitNext) { rateLimitNext = false; res.writeHead(429, { 'retry-after': '1', 'Content-Type': 'application/json' }); return res.end('{"error":{"message":"slow down"}}'); }
    const step = queue.shift();
    if (step === 'hang') return; // never answers: the idle timeout must catch it
    if (!body.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ message: { content: 'plain json reply' }, finish_reason: 'stop' }] }));
    }
    sse(res, step ?? say('ok'));
  },
});
const client = startClient('anonrouter-acp.js',
  { ANONROUTER_API_KEY: 'k', ANONROUTER_MODEL: 'vis', ANONROUTER_BASE_URL: mock.url, ANONROUTER_MODE: 'bypassPermissions', ACP_STREAM_IDLE_MS: '400' },
  () => undefined);
await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
const { sessionId } = await client.request('session/new', { cwd: tmpDir(), mcpServers: [] });
const prompt = (blocks) => client.request('session/prompt', { sessionId, prompt: typeof blocks === 'string' ? [{ type: 'text', text: blocks }] : blocks });
const messageText = () => client.updates.filter((u) => u.sessionUpdate === 'agent_message_chunk').map((u) => u.content.text).join('');
const reset = () => { client.updates.length = 0; };

// Slash commands are advertised and handled locally.
await new Promise((r) => setTimeout(r, 100));
assert.deepEqual(client.updates.find((u) => u.sessionUpdate === 'available_commands_update').availableCommands.map((c) => c.name), ['clear', 'compact', 'status', 'forget']);

// Images: sent as image parts to vision models, replaced by a note for others.
const png = { type: 'image', data: 'AAAA', mimeType: 'image/png' };
await prompt([{ type: 'text', text: 'what is this' }, png]);
const last = mock.bodies.at(-1).messages.at(-1);
assert.equal(last.content[0].text, 'what is this');
assert.equal(last.content[1].image_url.url, 'data:image/png;base64,AAAA');
await client.request('session/set_config_option', { sessionId, configId: 'model', value: 'novis' });
await prompt([{ type: 'text', text: 'and this' }, png]);
assert.match(mock.bodies.at(-1).messages.at(-1).content, /cannot view images/);

// Models that report streaming:false get a plain JSON request.
await client.request('session/set_config_option', { sessionId, configId: 'model', value: 'nostream' });
reset();
await prompt('hi');
assert.equal(mock.bodies.at(-1).stream, false);
assert.equal(messageText(), 'plain json reply');

// A tool call cut off by the length limit is not run; the model is told to retry smaller.
await client.request('session/set_config_option', { sessionId, configId: 'model', value: 'novis' });
queue.push([
  { choices: [{ delta: { tool_calls: [{ index: 0, id: 'cut', function: { name: 'write_file', arguments: '{"path":"x.txt","content":"abc' } }] } }] },
  { choices: [{ finish_reason: 'length', delta: {} }] },
], say('retrying smaller'));
reset();
await prompt('write a big file');
assert.ok(!client.updates.some((u) => u.sessionUpdate === 'tool_call'));
const follow = mock.bodies.at(-1).messages;
assert.match(follow.at(-1).content, /cut off, so nothing was run/);
assert.ok(follow.every((m) => !m.tool_calls)); // no dangling tool_calls in history

// A model without tools gets no tools and a note.
await client.request('session/set_config_option', { sessionId, configId: 'model', value: 'notools' });
reset();
await prompt('hi');
assert.equal(mock.bodies.at(-1).tools, undefined);
assert.match(messageText(), /does not support tool calling/);
await client.request('session/set_config_option', { sessionId, configId: 'model', value: 'novis' });

// update_plan emits an ACP plan update.
queue.push(toolCall('p1', 'update_plan', { items: [{ content: 'one', status: 'in_progress' }, { content: 'two', status: 'pending' }] }), say('ok'));
reset();
await prompt('plan it');
assert.deepEqual(client.updates.find((u) => u.sessionUpdate === 'plan').entries, [
  { content: 'one', priority: 'medium', status: 'in_progress' }, { content: 'two', priority: 'medium', status: 'pending' },
]);

// A stalled connection is aborted by the idle timeout and retried; a 429 shows a retry notice.
queue.push('hang', say('after stall'));
reset();
await prompt('stall');
assert.equal(messageText(), 'after stall');
rateLimitNext = true;
reset();
await prompt('limited');
assert.ok(client.updates.some((u) => u.sessionUpdate === 'agent_thought_chunk' && /rate limited; retrying in 1s/.test(u.content.text)));

// /compact summarizes, /clear empties.
queue.push(say('SUMMARY TEXT'));
reset();
await prompt('/compact');
assert.match(messageText(), /Compacted \d+ messages/);
await prompt('after compact');
assert.match(JSON.stringify(mock.bodies.at(-1).messages), /Summary of the conversation so far:\\nSUMMARY TEXT/);
reset();
await prompt('/clear');
assert.equal(messageText(), 'Conversation cleared.');
await prompt('fresh');
assert.equal(mock.bodies.at(-1).messages.length, 2); // system + the new user message

console.log('features OK');
client.close();
mock.close();
