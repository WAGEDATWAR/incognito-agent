// Provider settings: Anonrouter routing policy, route notes, cost and /status; Venice extras and balance.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { anonrouter } from '../src/providers/anonrouter.js';
import { venice } from '../src/providers/venice.js';
import { SettingsStore } from '../src/settings.js';
import { say, startClient, startMock, tmpDir } from './helpers.js';

// ---- Anonrouter routing policy ----
const ex = (env, settings) => anonrouter.requestExtras({ effort: null, env, settings }).provider;
assert.deepEqual(ex({}), { require_parameters: true });
assert.equal(ex({ ANONROUTER_REQUIRE_PARAMETERS: '0' }), undefined);
assert.deepEqual(ex({
  ANONROUTER_PROVIDER_ORDER: 'venice, deepinfra', ANONROUTER_PROVIDER_IGNORE: 'chutes', ANONROUTER_SORT: 'price', ANONROUTER_MIN_PRIVACY: 'private',
  ANONROUTER_MAX_PRICE_INPUT: '0.5', ANONROUTER_MAX_PRICE_OUTPUT: '1.5', ANONROUTER_MAX_ATTEMPTS: '2', ANONROUTER_ALLOW_FALLBACKS: '0',
}), {
  order: ['venice', 'deepinfra'], ignore: ['chutes'], allow_fallbacks: false, sort: 'price', minimum_privacy: 'private',
  max_price: { input: 0.5, output: 1.5 }, require_parameters: true, max_attempts: 2,
});
// Menu choices beat environment variables; invalid values are dropped rather than sent.
assert.equal(ex({ ANONROUTER_SORT: 'price' }, { sort: 'latency' }).sort, 'latency');
assert.equal(ex({ ANONROUTER_SORT: 'bogus', ANONROUTER_MAX_ATTEMPTS: '9' }).sort, undefined);
assert.equal(ex({ ANONROUTER_MAX_ATTEMPTS: '9' }).max_attempts, undefined);
assert.equal(ex({}, { fallbacks: 'off' }).allow_fallbacks, false);
assert.match(anonrouter.explainError(403, { error: { code: 'no_provider_route_meets_privacy' } }), /Minimum privacy/);

// ---- model data: privacy tags, per-provider routes and pricing ----
const parsed = anonrouter.parseModels({ data: [{
  id: 'x/m', model_type: 'text', privacy_class: 'anonymous', pricing: { input_usd_per_million_tokens: 2, output_usd_per_million_tokens: 10 }, capabilities: { tools: true },
  provider_routes: [{ provider: 'sail', privacy_class: 'private', pricing: { input_usd_per_million_tokens: 1, output_usd_per_million_tokens: 4 } }],
}] });
assert.equal(parsed[0].name, 'x/m · anonymous');
assert.deepEqual(parsed[0].routes.sail, { privacy: 'private', pricing: { in: 1, out: 4 } });
const route = anonrouter.routeInfo(new Headers({ 'x-anonrouter-selected-model': 'sail/deepseek-v4', 'x-anonrouter-routing': 'exact' }), parsed[0]);
assert.deepEqual([route.provider, route.privacy, route.label, route.fallback], ['sail', 'private', 'sail (private)', false]);
assert.equal(anonrouter.routeInfo(new Headers({}), parsed[0]), null);

// ---- Venice extras and balance ----
assert.deepEqual(venice.requestExtras({ effort: null, env: { VENICE_WEB_SCRAPING: '1', VENICE_WEB_CITATIONS: '1', VENICE_X_SEARCH: '1', VENICE_STRIP_THINKING: '1' }, settings: { web_search: 'auto' } }).venice_parameters, {
  include_venice_system_prompt: false, enable_web_search: 'auto', enable_web_scraping: true, enable_web_citations: true, enable_x_search: true, strip_thinking_response: true,
});
assert.equal(venice.requestExtras({ effort: null, env: { VENICE_WEB_SEARCH: 'bogus' } }).venice_parameters.enable_web_search, 'off');
assert.deepEqual(venice.balance(new Headers({ 'x-venice-balance-usd': '12.5', 'x-venice-balance-diem': '3' })), { usd: '12.5', diem: '3' });
assert.equal(venice.balance(new Headers({})), null);
const vm = venice.parseModels({ data: [{ id: 'v', type: 'text', model_spec: { name: 'V', privacy: 'private', pricing: { input: { usd: 0.5 }, output: { usd: 2 } }, capabilities: { supportsFunctionCalling: true } } }] });
assert.equal(vm[0].name, 'V · private');
assert.deepEqual(vm[0].pricing, { in: 0.5, out: 2 });

// ---- settings store persists choices and rejects unknown ones ----
const home = tmpDir();
process.env.USERPROFILE = home;
process.env.HOME = home;
const store = new SettingsStore(anonrouter);
assert.equal(store.get('sort'), 'default');
assert.equal(store.set('sort', 'price'), true);
assert.equal(store.set('sort', 'nonsense'), false);
assert.equal(store.set('nope', 'x'), false);
assert.deepEqual(new SettingsStore(anonrouter).resolved(), { sort: 'price' }); // survives a restart
assert.ok(fs.existsSync(path.join(home, '.anonrouter-acp', 'settings.json')));

// ---- through the agent: request body, route note, cost, /status ----
const models = { data: [{
  id: 'm', model_type: 'text', context_window: 100000, privacy_class: 'anonymous',
  pricing: { input_usd_per_million_tokens: 2, output_usd_per_million_tokens: 10 }, capabilities: { tools: true },
  provider_routes: [{ provider: 'sail', privacy_class: 'private', pricing: { input_usd_per_million_tokens: 1, output_usd_per_million_tokens: 4 } }],
}] };
let servedBy = 'sail';
const mock = await startMock({
  models,
  script: (call, body, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'x-anonrouter-selected-model': `${servedBy}/m`, 'x-anonrouter-routing': 'auto' });
    for (const o of [...say('hello'), { choices: [], usage: { prompt_tokens: 1000000, completion_tokens: 500000 } }]) res.write(`data: ${JSON.stringify(o)}\n\n`);
    res.end('data: [DONE]\n\n');
  },
});
const client = startClient('anonrouter-acp.js', { ANONROUTER_API_KEY: 'k', ANONROUTER_MODEL: 'm', ANONROUTER_BASE_URL: mock.url, ANONROUTER_MAX_ATTEMPTS: '3' }, () => undefined);
await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
const { sessionId, configOptions } = await client.request('session/new', { cwd: tmpDir(), mcpServers: [] });
assert.equal(configOptions.find((o) => o.id === 'minimum_privacy').currentValue, 'default');
const set = await client.request('session/set_config_option', { sessionId, configId: 'minimum_privacy', value: 'private' });
assert.equal(set.configOptions.find((o) => o.id === 'minimum_privacy').currentValue, 'private');
await assert.rejects(client.request('session/set_config_option', { sessionId, configId: 'sort', value: 'bogus' }), /invalid value/);

const prompt = (text) => client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
const message = () => client.updates.filter((u) => u.sessionUpdate === 'agent_message_chunk').map((u) => u.content.text).join('');
await prompt('hi');
assert.deepEqual(mock.bodies[0].provider, { minimum_privacy: 'private', require_parameters: true, max_attempts: 3 });
assert.match(message(), /hello\n\n_Routed via sail \(private\)\._/);
// sail's list price (1 in, 4 out per M): 1M in + 0.5M out = $3.00, carried on the meter as ACP cost.
assert.deepEqual(client.updates.filter((u) => u.sessionUpdate === 'usage_update').at(-1).cost, { amount: 3, currency: 'USD' });

client.updates.length = 0;
await prompt('again'); // same provider: no repeat note
assert.ok(!/Routed via/.test(message()));
assert.equal(client.updates.filter((u) => u.sessionUpdate === 'usage_update').at(-1).cost.amount, 6);
servedBy = 'deepinfra';
client.updates.length = 0;
await prompt('third'); // provider changed: noted again
assert.match(message(), /Routed via deepinfra/);

client.updates.length = 0;
await prompt('/status');
assert.match(message(), /\*\*Last route:\*\* deepinfra \(anonymous\), auto routing/);
assert.match(message(), /\*\*Session cost:\*\* about \$\d/);
assert.match(message(), /\*\*Settings:\*\* minimum_privacy=private/);

console.log('routing OK');
client.close();
mock.close();
