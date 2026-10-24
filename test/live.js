// Live check against the real providers: model list, a streamed reply and cost meter, a tool round trip, and a reasoning
// effort. NOT part of `npm test`: it spends a few cents of real credit. Run it with `npm run test:live`.
//
// Keys come from ANONROUTER_API_KEY / VENICE_API_KEY or your saved credentials; a provider without a key is skipped.
// Override the models with ACP_LIVE_ANONROUTER_MODEL / ACP_LIVE_VENICE_MODEL.
// The agent itself runs in a throwaway home folder, so no chats or settings land in yours.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ChatClient } from '../src/llm.js';
import { loadApiKey } from '../src/credentials.js';
import { anonrouter } from '../src/providers/anonrouter.js';
import { venice } from '../src/providers/venice.js';
import { startClient, tmpDir } from './helpers.js';

const PREFERRED = { anonrouter: 'deepseek/deepseek-v4-flash', venice: 'zai-org-glm-5-2' };
const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'max'];
const cost = (m) => (m.pricing ? m.pricing.in + m.pricing.out : Infinity);
let failures = 0;
let skipped = 0;

async function checkProvider(provider, bin) {
  const name = provider.id;
  const key = loadApiKey(provider);
  if (!key) { console.log(`- ${name}: skipped (no key; set ${provider.envPrefix}_API_KEY or sign in once in the IDE)`); skipped++; return; }
  console.log(`- ${name}`);
  const step = async (label, fn) => {
    const started = Date.now();
    try { const note = await fn(); console.log(`    ok   ${label}${note ? `: ${note}` : ''} (${((Date.now() - started) / 1000).toFixed(1)}s)`); } catch (e) { failures++; console.log(`    FAIL ${label}: ${e.message.split('\n')[0]}`); }
  };

  // The model list as the provider serves it right now.
  let models = [];
  await step('model list', async () => {
    models = await new ChatClient({ baseUrl: provider.baseUrl, apiKey: key, provider }).listModels(20000);
    assert.ok(models.length > 20, `only ${models.length} models`);
    assert.ok(models.every((m) => typeof m.id === 'string' && typeof m.tools === 'boolean' && Array.isArray(m.efforts)));
    return `${models.length} models, ${models.filter((m) => m.tools).length} with tools`;
  });
  if (!models.length) return;

  const chat = process.env[`ACP_LIVE_${provider.envPrefix}_MODEL`] ?? (models.some((m) => m.id === PREFERRED[name] && m.tools) ? PREFERRED[name] : [...models].filter((m) => m.tools && m.streaming).sort((a, b) => cost(a) - cost(b))[0]?.id);
  const effortModel = [...models].filter((m) => m.tools && m.efforts.some((e) => EFFORT_ORDER.includes(e))).sort((a, b) => cost(a) - cost(b))[0];

  const open = (model, extraEnv = {}) => startClient(bin, { [`${provider.envPrefix}_API_KEY`]: key, [`${provider.envPrefix}_MODEL`]: model, [`${provider.envPrefix}_MODE`]: 'bypassPermissions', ...extraEnv }, () => undefined);
  const session = async (client, cwd) => {
    await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    return (await client.request('session/new', { cwd, mcpServers: [] })).sessionId;
  };
  const ask = async (client, sessionId, text) => {
    client.updates.length = 0;
    const r = await Promise.race([client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }), new Promise((_, rej) => setTimeout(() => rej(new Error('no answer within 90s')), 90000))]);
    return { stop: r.stopReason, text: client.updates.filter((u) => u.sessionUpdate === 'agent_message_chunk').map((u) => u.content.text).join('') };
  };
  const noError = (text) => assert.ok(!/\*\*\w+ error:\*\*/.test(text), `provider error in reply: ${text.slice(0, 200)}`);

  // 1. A streamed reply, with the context meter and a cost.
  await step(`streamed reply (${chat})`, async () => {
    const client = open(chat);
    try {
      const sid = await session(client, tmpDir());
      const { stop, text } = await ask(client, sid, 'Reply with exactly the single word: ok');
      noError(text);
      assert.equal(stop, 'end_turn');
      assert.match(text.toLowerCase(), /ok/);
      const meter = client.updates.filter((u) => u.sessionUpdate === 'usage_update').at(-1);
      assert.ok(meter && meter.used > 0 && meter.size > meter.used, 'no usable context meter');
      return `${meter.used} tokens used${meter.cost ? `, about $${meter.cost.amount}` : ''}`;
    } finally { client.close(); }
  });

  // 2. A tool round trip: the model must read a file to answer.
  await step(`tool call (${chat})`, async () => {
    const work = tmpDir();
    fs.writeFileSync(path.join(work, 'note.txt'), 'The secret word is marmalade.\n');
    const client = open(chat);
    try {
      const sid = await session(client, work);
      const { text } = await ask(client, sid, 'Use the read_file tool to read note.txt, then tell me the secret word in one sentence.');
      noError(text);
      assert.ok(client.updates.some((u) => u.sessionUpdate === 'tool_call_update' && u.status === 'completed'), 'the model never completed a tool call');
      assert.match(text.toLowerCase(), /marmalade/);
    } finally { client.close(); }
  });

  // 3. A reasoning effort the model attests to is accepted.
  if (effortModel) {
    const effort = EFFORT_ORDER.find((e) => effortModel.efforts.includes(e));
    await step(`reasoning effort "${effort}" (${effortModel.id})`, async () => {
      const client = open(effortModel.id);
      try {
        const sid = await session(client, tmpDir());
        const set = await client.request('session/set_config_option', { sessionId: sid, configId: 'reasoning_effort', value: effort });
        assert.equal(set.configOptions.find((o) => o.id === 'reasoning_effort').currentValue, effort);
        const { stop, text } = await ask(client, sid, 'What is 17 times 3? Answer with just the number.');
        noError(text);
        assert.equal(stop, 'end_turn');
        assert.match(text, /51/);
      } finally { client.close(); }
    });
  } else console.log('    --   reasoning effort: no model in the list reports configurable efforts');

  // 4. Anonrouter only: the private ticket flow, and a privacy floor that a private route satisfies.
  if (name === 'anonrouter') {
    await step(`private tickets (${chat})`, async () => {
      const client = open(chat, { ANONROUTER_TICKETS: '1' });
      try {
        const sid = await session(client, tmpDir());
        const { stop, text } = await ask(client, sid, 'Reply with exactly the single word: ok');
        noError(text);
        assert.equal(stop, 'end_turn');
        assert.match(text.toLowerCase(), /ok/);
      } finally { client.close(); }
    });
  }
}

console.log('Live provider check (spends a little real credit)');
await checkProvider(anonrouter, 'anonrouter-acp.js');
await checkProvider(venice, 'venice-acp.js');
console.log(failures ? `\n${failures} check(s) failed` : `\nlive OK${skipped ? ` (${skipped} provider(s) skipped)` : ''}`);
process.exit(failures ? 1 : 0);
