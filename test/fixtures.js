// The model-list parsers against real entries captured from each provider's live API (test/fixtures), so the tests
// do not rest only on hand-made data shaped the way the code expects. Refresh the fixtures if a provider changes shape.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { anonrouter } from '../src/providers/anonrouter.js';
import { venice } from '../src/providers/venice.js';
import { root } from './helpers.js';

const load = (name) => JSON.parse(fs.readFileSync(path.join(root, 'test', 'fixtures', name), 'utf8'));
const byId = (list) => Object.fromEntries(list.map((m) => [m.id, m]));

// What every parsed model must satisfy, whatever the provider.
function checkInvariants(models, label) {
  assert.ok(models.length > 0, `${label}: nothing parsed`);
  for (const m of models) {
    const at = `${label} ${m.id}`;
    assert.equal(typeof m.id, 'string', at);
    for (const flag of ['tools', 'streaming', 'vision', 'reasoning']) assert.equal(typeof m[flag], 'boolean', `${at}: ${flag}`);
    assert.ok(Array.isArray(m.efforts) && m.efforts.every((e) => typeof e === 'string'), `${at}: efforts`);
    if (m.efforts.length) assert.ok(m.reasoning, `${at}: efforts on a model that does not reason`);
    assert.ok(Number.isFinite(m.context) && m.context > 0, `${at}: context`);
    assert.ok(Number.isFinite(m.maxOut) && m.maxOut > 0, `${at}: maxOut`);
    assert.ok(m.pricing && Number.isFinite(m.pricing.in) && Number.isFinite(m.pricing.out), `${at}: pricing`);
    assert.equal(m.name.includes('(no tools)'), !m.tools, `${at}: "(no tools)" label`);
    if (m.privacy) assert.ok(m.name.includes(` · ${m.privacy}`), `${at}: privacy tag`);
  }
}

// ---- Anonrouter ----
{
  const raw = load('anonrouter-models.json');
  const parsed = anonrouter.parseModels(raw);
  assert.equal(parsed.length, raw.data.length, 'text models were dropped');
  checkInvariants(parsed, 'anonrouter');
  const m = byId(parsed);

  // A model whose effort is configurable and can be switched off offers "none" plus its own levels.
  assert.deepEqual(m['abliteration-ai/abliterated-model'].efforts, ['none', 'low', 'medium', 'high']);
  // Configurable but not switchable: only its own levels.
  assert.deepEqual(m['abliteration-ai/abliterated-large-v2'].efforts, ['low', 'medium', 'high']);
  // Reasoning that cannot be configured gets no effort menu.
  assert.equal(m['deepseek/deepseek-v4-pro-0813'].reasoning, true);
  assert.deepEqual(m['deepseek/deepseek-v4-pro-0813'].efforts, []);
  // No tools, plus the privacy tier and per-provider routes of a model served by several providers.
  assert.equal(m['deepseek/deepseek-v4.1-flash'].tools, false);
  assert.equal(m['deepseek/deepseek-v4.1-flash'].privacy, 'private');
  assert.equal(Object.keys(m['deepseek/deepseek-v4.1-flash'].routes).length, 7);
  assert.equal(m['deepseek/deepseek-v4-flash-0731'].privacy, 'tee');
  // Vision, big output ceilings and free models.
  assert.equal(m['moonshotai/kimi-k3'].vision, true);
  assert.equal(m['moonshotai/kimi-k3'].maxOut, 1048576);
  assert.deepEqual(m['google/gemma-4-26b-a4b-it:free'].pricing, { in: 0, out: 0 });
  assert.equal(m['google/gemma-4-26b-a4b-it:free'].privacy, 'anonymous');
  // Each route carries its own privacy tier and price, which is what route notes and cost use.
  for (const info of parsed) for (const route of Object.values(info.routes)) assert.ok(route.privacy && route.pricing, `${info.id}: route data`);
}

// ---- Venice ----
{
  const raw = load('venice-models.json');
  const parsed = venice.parseModels(raw);
  assert.equal(parsed.length, raw.data.length - 1, 'exactly the end-to-end encrypted model should be dropped');
  assert.ok(raw.data.some((x) => x.id.startsWith('e2ee-')) && !parsed.some((x) => x.id.startsWith('e2ee-')));
  checkInvariants(parsed, 'venice');
  const m = byId(parsed);

  assert.deepEqual(m['zai-org-glm-5-2'].efforts, ['none', 'high', 'max']);
  assert.equal(m['z-ai-glm-5-3'].reasoning, true);
  assert.deepEqual(m['z-ai-glm-5-3'].efforts, []);
  assert.equal(m['grok-4-20-multi-agent'].tools, false);
  assert.equal(m['gemini-4-argon'].privacy, 'anonymized');
  assert.equal(m['gemini-4-argon'].vision, true);
  assert.equal(m['venice-uncensored-1-2'].reasoning, false);
  assert.deepEqual(m['gemini-4-argon'].pricing, { in: 2.5, out: 12.5 });

  // The privacy floor keeps exactly the private models.
  const floor = (model) => venice.allowsModel({ model, env: {}, settings: { minimum_privacy: 'private' } });
  assert.deepEqual(parsed.filter((x) => floor(x) === null).map((x) => x.privacy), parsed.filter((x) => x.privacy === 'private').map((x) => x.privacy));
  assert.ok(parsed.some((x) => x.privacy === 'anonymized' && floor(x) !== null));
}

console.log('fixtures OK');
