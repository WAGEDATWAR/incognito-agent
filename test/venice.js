// Venice adapter: model parsing, request extras, and the agent end to end against a fake Venice.
import assert from 'node:assert/strict';
import { say, sse, startClient, startMock, tmpDir } from './helpers.js';
import { venice } from '../src/providers/venice.js';

const models = {
  data: [
    { id: 'coder', type: 'text', model_spec: { name: 'Coder', availableContextTokens: 256000, capabilities: { supportsFunctionCalling: true, supportsReasoning: true, supportsReasoningEffort: true, reasoningEffortOptions: ['low', 'high'] } } },
    { id: 'plain', type: 'text', model_spec: { name: 'Plain', capabilities: { supportsFunctionCalling: false } } },
    { id: 'gone', type: 'text', model_spec: { name: 'Gone', offline: true, capabilities: {} } },
    { id: 'pic', type: 'image', model_spec: { name: 'Pic' } },
    { id: 'e2ee-glm', type: 'text', model_spec: { name: 'Encrypted', capabilities: { supportsFunctionCalling: true, supportsE2EE: true } } },
  ],
};

const parsed = venice.parseModels(models);
assert.deepEqual(parsed.map((m) => m.id), ['coder', 'plain']);
assert.equal(parsed[1].name, 'Plain (no tools)');
assert.deepEqual(parsed[0].efforts, ['low', 'high']);
assert.deepEqual(venice.requestExtras({ effort: 'high', env: {} }), {
  venice_parameters: { include_venice_system_prompt: false, enable_web_search: 'off' }, reasoning_effort: 'high',
});
assert.equal(venice.requestExtras({ effort: 'default', env: { VENICE_WEB_SEARCH: 'auto' } }).venice_parameters.enable_web_search, 'auto');
assert.equal(venice.retryAfterMs(new Headers({ 'x-ratelimit-reset-requests': String(Date.now() + 5000) })) > 3000, true);

const mock = await startMock({
  models,
  script: (call, body, res) => sse(res, [
    { choices: [{ delta: { reasoning_content: 'thinking ' } }] },
    { choices: [{ delta: { content: '<think>inline</think>Hi' } }] },
    { choices: [{ finish_reason: 'stop', delta: {} }] },
    { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 50 } },
  ]),
});
const client = startClient('venice-acp.js', { VENICE_API_KEY: 'k', VENICE_MODEL: 'coder', VENICE_BASE_URL: mock.url });
await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
const ses = await client.request('session/new', { cwd: tmpDir(), mcpServers: [] });
assert.deepEqual(ses.configOptions.map((o) => o.id), ['mode', 'model', 'reasoning_effort', 'minimum_privacy', 'web_search']);

await client.request('session/set_config_option', { sessionId: ses.sessionId, configId: 'reasoning_effort', value: 'low' });
await client.request('session/prompt', { sessionId: ses.sessionId, prompt: [{ type: 'text', text: 'hi' }] });
assert.equal(mock.bodies[0].reasoning_effort, 'low');
assert.equal(mock.bodies[0].venice_parameters.include_venice_system_prompt, false);
assert.ok(mock.bodies[0].tools.length > 0);
const thoughts = client.updates.filter((u) => u.sessionUpdate === 'agent_thought_chunk');
assert.equal(thoughts.length, 1); // batched into a single thought update
assert.equal(thoughts[0].content.text, 'thinking inline');
assert.equal(client.updates.filter((u) => u.sessionUpdate === 'agent_message_chunk').map((u) => u.content.text).join(''), 'Hi');

// Context meter: estimated at session start, then the provider's own token counts.
const meter = client.updates.filter((u) => u.sessionUpdate === 'usage_update');
assert.equal(meter[0].size, 256000);
assert.ok(meter[0].used > 0 && meter[0].used < 1000); // estimate from the system prompt
assert.deepEqual(meter.at(-1), { sessionUpdate: 'usage_update', size: 256000, used: 1050 });

// A model without tool support gets no tools and a one-time note.
await client.request('session/set_config_option', { sessionId: ses.sessionId, configId: 'model', value: 'plain' });
client.updates.length = 0;
await client.request('session/prompt', { sessionId: ses.sessionId, prompt: [{ type: 'text', text: 'hi' }] });
assert.equal(mock.bodies.at(-1).tools, undefined);
assert.match(client.updates[0].content.text, /does not support tool calling/);

console.log('venice OK');
client.close();
mock.close();
