// Operation modes and approval flow, as the IDE's AI Chat drives them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { say, sse, startClient, startMock, tmpDir, toolCall } from './helpers.js';

const work = tmpDir();
const file = path.join(work, 'a.txt');
fs.writeFileSync(file, 'one');

let queue = [];
const mock = await startMock({
  models: { data: [{ id: 'm' }] },
  script: (call, body, res) => sse(res, queue.shift() ?? say('ok')),
});

let answer = { outcome: 'selected', optionId: 'allow_once' };
const client = startClient('anonrouter-acp.js', { ANONROUTER_API_KEY: 'k', ANONROUTER_MODEL: 'm', ANONROUTER_BASE_URL: mock.url },
  (method) => (method === 'session/request_permission' ? { outcome: answer } : undefined));
await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
const { sessionId } = await client.request('session/new', { cwd: work, mcpServers: [] });

const ask = async (steps) => {
  queue = steps;
  client.requests.length = 0;
  client.updates.length = 0;
  await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'go' }] });
  return client.requests.filter((q) => q.method === 'session/request_permission');
};
const edit = (id, to) => [toolCall(id, 'edit_file', { path: 'a.txt', old_string: fs.readFileSync(file, 'utf8'), new_string: to }), say('done')];

// Manual: deny blocks the write and tells the model.
answer = { outcome: 'selected', optionId: 'reject_once' };
assert.equal((await ask(edit('e1', 'two'))).length, 1);
assert.equal(fs.readFileSync(file, 'utf8'), 'one');
assert.ok(client.updates.some((u) => u.toolCallId === 'e1' && u.status === 'failed'));

// "Always allow" is remembered for edits in this session.
answer = { outcome: 'selected', optionId: 'allow_always' };
assert.equal((await ask(edit('e2', 'two'))).length, 1);
assert.equal(fs.readFileSync(file, 'utf8'), 'two');
assert.equal((await ask(edit('e3', 'three'))).length, 0);
assert.equal(fs.readFileSync(file, 'utf8'), 'three');

// Switch to Accept edits via config option: edits free, commands still ask.
const set = await client.request('session/set_config_option', { sessionId, configId: 'mode', value: 'acceptEdits' });
assert.equal(set.configOptions.find((o) => o.id === 'mode').currentValue, 'acceptEdits');
const run = [toolCall('r1', 'run_command', { command: 'echo hi' }), say('done')];
const runPerm = await ask(run);
assert.equal(runPerm.length, 1);
assert.equal(runPerm[0].params.toolCall.kind, 'execute');
assert.match(runPerm[0].params.options[1].name, /Always allow echo/);

// Cancelled permission prompt ends the turn as cancelled.
answer = { outcome: 'cancelled' };
queue = [toolCall('r2', 'run_command', { command: 'ls' })];
const cancelled = await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'go' }] });
assert.equal(cancelled.stopReason, 'cancelled');

// History stays valid after a cancelled turn: the interrupted tool call got a tool message.
answer = { outcome: 'selected', optionId: 'allow_once' };
await ask([say('after cancel')]);
const sent = mock.bodies.at(-1).messages;
for (const m of sent.filter((x) => x.tool_calls)) {
  for (const c of m.tool_calls) assert.ok(sent.some((x) => x.role === 'tool' && x.tool_call_id === c.id), `unanswered ${c.id}`);
}

// Reads outside the project ask, even though reads inside never do.
const outside = path.join(path.dirname(work), 'outside-secret.txt');
fs.writeFileSync(outside, 'secret');
const outPerm = await ask([toolCall('o1', 'read_file', { path: outside }), say('done')]);
assert.equal(outPerm.length, 1);
assert.match(outPerm[0].params.toolCall.title, /outside project/);
assert.equal((await ask([toolCall('o2', 'read_file', { path: 'a.txt' }), say('done')])).length, 0);
fs.rmSync(outside);

// Plan mode is read-only: write tools are not offered and calls are refused without prompting.
await client.request('session/set_mode', { sessionId, modeId: 'plan' });
answer = { outcome: 'selected', optionId: 'allow_once' };
assert.equal((await ask(edit('e4', 'four'))).length, 0);
assert.equal(fs.readFileSync(file, 'utf8'), 'three');
assert.ok(!mock.bodies.at(-1).tools.some((t) => ['edit_file', 'write_file', 'run_command'].includes(t.function.name)));

// Bypass: nothing asks.
await client.request('session/set_mode', { sessionId, modeId: 'bypassPermissions' });
assert.equal((await ask([toolCall('r3', 'run_command', { command: 'echo x' }), say('done')])).length, 0);

console.log('approval OK');
client.close();
mock.close();
fs.rmSync(work, { recursive: true, force: true });
