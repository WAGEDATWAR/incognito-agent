// MCP: tools from IDE-configured servers (stdio and Streamable HTTP) reach the model and run behind approval.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { say, sse, startClient, startMock, tmpDir, toolCall } from './helpers.js';
import { toolName } from '../src/mcp.js';

assert.equal(toolName('my server', 'do.it'), 'mcp__my_server__do_it');
assert.ok(toolName('s'.repeat(40), 't'.repeat(40)).length <= 64);

// An HTTP MCP server answering with plain JSON for most calls and an SSE stream for tools/call.
let sawSession = false;
const mcpHttp = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    if (req.method === 'DELETE') return res.end();
    const m = JSON.parse(b);
    if (m.id === undefined) { res.writeHead(202); return res.end(); }
    if (m.method === 'initialize') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'sess-1' });
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: {}, serverInfo: { name: 'h', version: '1' } } }));
    }
    sawSession ||= req.headers['mcp-session-id'] === 'sess-1';
    if (m.method === 'tools/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'ping', description: 'Ping', inputSchema: { type: 'object', properties: {} } }] } }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'pong' }] } })}\n\n`);
    res.end();
  });
});
await new Promise((r) => mcpHttp.listen(0, r));

const queue = [];
const mock = await startMock({ models: { data: [{ id: 'm' }] }, script: (call, body, res) => sse(res, queue.shift() ?? say('ok')) });
let answer = { outcome: 'selected', optionId: 'allow_once' };
const client = startClient('anonrouter-acp.js', { ANONROUTER_API_KEY: 'k', ANONROUTER_MODEL: 'm', ANONROUTER_BASE_URL: mock.url },
  (method) => (method === 'session/request_permission' ? { outcome: answer } : undefined));
await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });

const here = path.dirname(fileURLToPath(import.meta.url));
const { sessionId } = await client.request('session/new', {
  cwd: tmpDir(),
  mcpServers: [
    { name: 'fake', command: process.execPath, args: [path.join(here, 'fake-mcp.js')], env: [] },
    { type: 'http', name: 'web', url: `http://127.0.0.1:${mcpHttp.address().port}/mcp`, headers: [] },
    { name: 'broken', command: process.execPath, args: ['-e', 'process.exit(1)'], env: [] },
  ],
});
const ask = async (steps) => {
  queue.push(...steps);
  client.requests.length = 0;
  client.updates.length = 0;
  await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'go' }] });
  return client.requests.filter((q) => q.method === 'session/request_permission');
};

// Tools from both servers are offered; a server that fails to start is reported, not fatal.
await ask([say('hi')]);
const offered = mock.bodies.at(-1).tools.map((t) => t.function.name);
assert.ok(offered.includes('mcp__fake__echo') && offered.includes('mcp__fake__boom') && offered.includes('mcp__web__ping'));
assert.ok(client.updates.some((u) => u.sessionUpdate === 'agent_message_chunk' && /"broken" is unavailable/.test(u.content.text)));

// A stdio tool call asks first, then runs; "Always allow" is remembered per server.
answer = { outcome: 'selected', optionId: 'allow_always' };
let perm = await ask([toolCall('m1', 'mcp__fake__echo', { text: 'hi' }), say('done')]);
assert.equal(perm.length, 1);
assert.equal(perm[0].params.toolCall.title, 'fake: echo');
assert.equal(perm[0].params.options[1].name, 'Always allow fake');
assert.ok(client.updates.some((u) => u.toolCallId === 'm1' && u.status === 'completed' && u.rawOutput === 'echo:hi'));
perm = await ask([toolCall('m2', 'mcp__fake__echo', { text: 'again' }), say('done')]);
assert.equal(perm.length, 0);

// An isError result becomes a failed tool call the model can see.
await ask([toolCall('m3', 'mcp__fake__boom', {}), say('done')]);
assert.ok(client.updates.some((u) => u.toolCallId === 'm3' && u.status === 'failed'));
assert.match(mock.bodies.at(-1).messages.find((m) => m.tool_call_id === 'm3').content, /it broke/);

// HTTP transport: session id is carried, SSE responses are read.
answer = { outcome: 'selected', optionId: 'allow_once' };
await ask([toolCall('m4', 'mcp__web__ping', {}), say('done')]);
assert.ok(client.updates.some((u) => u.toolCallId === 'm4' && u.rawOutput === 'pong'));
assert.ok(sawSession);

// Plan mode offers no MCP tools at all.
await client.request('session/set_mode', { sessionId, modeId: 'plan' });
await ask([say('planning')]);
assert.ok(!mock.bodies.at(-1).tools.some((t) => t.function.name.startsWith('mcp__')));

console.log('mcp OK');
client.close();
mock.close();
mcpHttp.close();
