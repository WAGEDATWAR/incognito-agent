// Anonrouter private ticket flow: key goes only to the control origin; content carries only a single-use ticket.
import assert from 'node:assert/strict';
import http from 'node:http';
import { anonrouter } from '../src/providers/anonrouter.js';
import { sse, say, startClient, tmpDir } from './helpers.js';

// ---- provider pieces ----
assert.equal(anonrouter.useTickets({ env: {}, settings: {} }), false);
assert.equal(anonrouter.useTickets({ env: { ANONROUTER_TICKETS: '1' }, settings: {} }), true);
assert.equal(anonrouter.useTickets({ env: { ANONROUTER_TICKETS: '1' }, settings: { request_mode: 'key' } }), false);
assert.equal(anonrouter.useTickets({ env: {}, settings: { request_mode: 'tickets' } }), true);
assert.deepEqual(anonrouter.ticketBody({ model: 'm', extra: { max_tokens: 99, reasoning_effort: 'low', provider: { sort: 'price' } } }),
  { model: 'm', provider: { sort: 'price' }, max_completion_tokens: 99, reasoning_effort: 'low' });
assert.deepEqual(anonrouter.ticketBody({ model: 'm', extra: { max_tokens: 5 } }), { model: 'm', max_completion_tokens: 5 });
assert.match(anonrouter.explainError(401, { error: { type: 'ticket_required' } }), /Private tickets/);

// ---- fake control plane and relay on separate origins ----
const KEY = 'ar_secret';
const models = { data: [{ id: 'm', model_type: 'text', context_window: 100000, max_output_tokens: 50000,
  capabilities: { tools: true, streaming: true, reasoning: { supported: true, effort_configurable: true, supported_efforts: ['low', 'high'] } } }] };
const control = { requests: [], tickets: new Map(), n: 0 };
const relay = { requests: [], failNextWith: null };
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const read = (req) => new Promise((r) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => r(b ? JSON.parse(b) : null)); });

const controlServer = http.createServer(async (req, res) => {
  const body = await read(req);
  control.requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
  if (req.headers.authorization !== `Bearer ${KEY}`) return json(res, 401, { error: { message: 'bad key' } });
  if (req.url === '/v1/models') return json(res, 200, models);
  if (req.url === '/v1/inference/tickets') {
    const ticket = `ticket-${++control.n}`;
    control.tickets.set(ticket, { ...body, used: false });
    return json(res, 200, { ticket, expires_in: 30 });
  }
  json(res, 404, { error: { message: 'no' } });
});
const relayServer = http.createServer(async (req, res) => {
  const body = await read(req);
  const ticket = req.headers['x-anonrouter-ticket'];
  relay.requests.push({ url: req.url, auth: req.headers.authorization, ticket, body });
  if (relay.failNextWith) { const f = relay.failNextWith; relay.failNextWith = null; return json(res, f.status, { error: { type: f.type, message: f.type } }); }
  if (ticket) {
    const t = control.tickets.get(ticket);
    if (!t || t.used) return json(res, 401, { error: { type: 'invalid_ticket', message: 'invalid ticket' } });
    t.used = true; // single use
    if (body.model !== t.model || body.max_tokens !== t.max_completion_tokens || body.reasoning_effort !== t.reasoning_effort
      || JSON.stringify(body.provider) !== JSON.stringify(t.provider)) return json(res, 409, { error: { type: 'ticket_model_mismatch', message: 'ticket does not match request' } });
  } else if (req.headers.authorization !== `Bearer ${KEY}`) return json(res, 401, { error: { type: 'ticket_required', message: 'ticket required' } });
  res.writeHead(200, { 'x-anonrouter-selected-model': 'sail/m', 'x-anonrouter-routing': 'exact', 'Content-Type': 'text/event-stream' });
  for (const o of say('ok')) res.write(`data: ${JSON.stringify(o)}\n\n`);
  res.end('data: [DONE]\n\n');
});
await new Promise((r) => controlServer.listen(0, r));
await new Promise((r) => relayServer.listen(0, r));
const controlUrl = `http://127.0.0.1:${controlServer.address().port}/v1`;
const relayUrl = `http://127.0.0.1:${relayServer.address().port}/v1`;

const client = startClient('anonrouter-acp.js', {
  ANONROUTER_API_KEY: KEY, ANONROUTER_MODEL: 'm', ANONROUTER_BASE_URL: relayUrl, ANONROUTER_CONTROL_URL: controlUrl,
  ANONROUTER_TICKETS: '1', ANONROUTER_MODE: 'bypassPermissions',
}, () => undefined);
await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
const { sessionId, configOptions } = await client.request('session/new', { cwd: tmpDir(), mcpServers: [] });
const prompt = (text) => client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
const message = () => client.updates.filter((u) => u.sessionUpdate === 'agent_message_chunk').map((u) => u.content.text).join('');
const contentRequests = () => relay.requests.filter((r) => r.url === '/v1/chat/completions');

// Ticket mode lists models from the control origin with the key; the relay is never contacted for it.
assert.ok(configOptions.find((o) => o.id === 'request_mode'));
assert.deepEqual(control.requests.map((r) => `${r.method} ${r.url}`), ['GET /v1/models']);
assert.equal(control.requests[0].auth, `Bearer ${KEY}`);
assert.equal(relay.requests.length, 0);

// One prompt: one ticket minted with the bound parameters; content carries the ticket and no key.
await prompt('hello');
const mints = control.requests.filter((r) => r.url === '/v1/inference/tickets');
assert.equal(mints.length, 1);
assert.equal(mints[0].auth, `Bearer ${KEY}`);
assert.deepEqual(mints[0].body, { model: 'm', provider: { require_parameters: true }, max_completion_tokens: 16384 });
assert.equal(contentRequests().length, 1);
assert.equal(contentRequests()[0].auth, undefined);
assert.equal(contentRequests()[0].ticket, 'ticket-1');
assert.equal(contentRequests()[0].body.max_tokens, 16384);
assert.match(message(), /^ok/);

// Reasoning effort is part of the ticket and must match the completion.
await client.request('session/set_config_option', { sessionId, configId: 'reasoning_effort', value: 'high' });
await prompt('think');
assert.equal(control.tickets.get('ticket-2').reasoning_effort, 'high');
assert.equal(contentRequests().at(-1).body.reasoning_effort, 'high');

// A ticket that went stale is replaced with a fresh one and the call succeeds.
relay.failNextWith = { status: 401, type: 'invalid_ticket' };
client.updates.length = 0;
const mintsBefore = control.n;
await prompt('retry me');
assert.equal(control.n - mintsBefore, 2); // the stale ticket plus its replacement
assert.match(message(), /^ok/);
assert.ok(client.updates.some((u) => u.sessionUpdate === 'agent_thought_chunk' && /ticket expired/.test(u.content.text)));

// /status says so, and the output ceiling can be lowered.
client.updates.length = 0;
await prompt('/status');
assert.match(message(), /\*\*Requests:\*\* private tickets/);

// Switching the menu to Standard sends the key to the relay and mints nothing.
const set = await client.request('session/set_config_option', { sessionId, configId: 'request_mode', value: 'key' });
assert.equal(set.configOptions.find((o) => o.id === 'request_mode').currentValue, 'key');
const mintsNow = control.n;
await prompt('standard');
assert.equal(control.n, mintsNow);
const last = contentRequests().at(-1);
assert.equal(last.auth, `Bearer ${KEY}`);
assert.equal(last.ticket, undefined);

// A key that can't be used directly gets a pointer to the right setting.
relay.failNextWith = { status: 401, type: 'ticket_required' };
client.updates.length = 0;
await prompt('direct');
assert.match(message(), /Private tickets/);

console.log('tickets OK');
client.close();
controlServer.close();
relayServer.close();
