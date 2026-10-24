// Missing-key flow: the agent asks for the key via promptForKey, saves it, then proceeds.
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { RpcPeer } from '../src/rpc.js';
import { AcpAgent } from '../src/agent.js';
import { venice } from '../src/providers/venice.js';

let saved = null;
let prompts = 0;
const config = {
  baseUrl: 'http://127.0.0.1:1/v1', model: 'm', mode: 'default', configOptions: true,
  loadApiKey: () => saved,
  saveApiKey: (k) => { saved = k; },
  promptForKey: async () => { prompts++; return prompts === 1 ? null : 'sk-from-dialog'; },
};
const rpc = new RpcPeer(new PassThrough(), new PassThrough(), () => {});
const agent = new AcpAgent({ rpc, provider: venice, config, log: () => {} });

const methods = (await agent.initialize({})).authMethods;
assert.equal(methods.length, 1);
assert.match(methods[0].name, /Venice/);
await assert.rejects(agent.requireAuth(), /Venice API key missing/); // user cancelled the dialog
await Promise.all([agent.requireAuth(), agent.requireAuth()]); // second try succeeds; callers share one dialog
assert.equal(saved, 'sk-from-dialog');
assert.equal(prompts, 2);
assert.equal((await agent.initialize({})).authMethods.length, 0);

// Terminal auth is offered only to clients that support it, and only where a dialog can't be shown.
saved = null;
agent.llm = null;
agent.config.canShowDialog = () => false;
agent.clientCaps = { auth: { terminal: true } };
const headless = (await agent.initialize({ clientCapabilities: { auth: { terminal: true } } })).authMethods;
assert.deepEqual(headless.map((m) => m.type ?? 'agent'), ['agent', 'terminal']);
assert.deepEqual(headless[1].args, ['login']);
assert.match(agent.authError().message, /Run "npx anonrouter-venice-acp venice login"|Run "venice-acp login"/);
agent.clientCaps = {};
assert.equal(agent.authMethods().length, 1); // client can't do terminal auth
agent.config.canShowDialog = () => true;
agent.clientCaps = { auth: { terminal: true } };
assert.equal(agent.authMethods().length, 1); // a dialog works, so no terminal method
console.log('auth OK');
