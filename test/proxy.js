import http from 'node:http';
import assert from 'node:assert/strict';
import { ChatClient } from '../src/llm.js';
import { createProxy, splitFim, cleanCompletion } from '../src/proxy.js';

assert.deepEqual(splitFim('<|fim_prefix|>a(<|fim_suffix|>)<|fim_middle|>'), { prefix: 'a(', suffix: ')' });
assert.deepEqual(splitFim('<PRE> x <SUF> y <MID>'), { prefix: ' x ', suffix: ' y ' });
assert.deepEqual(splitFim('[SUFFIX]end[PREFIX]start'), { prefix: 'start', suffix: 'end' });
assert.deepEqual(splitFim('plain', 'tail'), { prefix: 'plain', suffix: 'tail' });
assert.equal(cleanCompletion('```js\nfoo()\n```'), 'foo()');
assert.equal(cleanCompletion('abc;STOPdef', ['STOP']), 'abc;');

let seen;
const upstream = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'm' }] }));
    seen = JSON.parse(b);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '```\nname + 1);\n```' } }] })}\n\ndata: [DONE]\n\n`);
    res.end();
  });
});
await new Promise((r) => upstream.listen(0, r));
const base = `http://127.0.0.1:${upstream.address().port}/v1`;
const llm = () => new ChatClient({ baseUrl: base, apiKey: 'k', provider: { parseModels: () => [] } });
const proxy = createProxy({ llm, resolveKey: () => 'k', log: () => {} });
await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
const p = `http://127.0.0.1:${proxy.address().port}/v1`;

const r = await fetch(`${p}/completions`, { method: 'POST', body: JSON.stringify({ model: 'qwen/x', prompt: '<|fim_prefix|>print(<|fim_suffix|><|fim_middle|>', max_tokens: 32 }) });
const j = await r.json();
assert.equal(j.choices[0].text, 'name + 1);');
assert.match(seen.messages[1].content, /<PREFIX>\nprint\(\n<\/PREFIX>/);
assert.equal(seen.max_tokens, 32);

const s = await (await fetch(`${p}/completions`, { method: 'POST', body: JSON.stringify({ model: 'q', prompt: 'x', stream: true }) })).text();
assert.match(s, /name \+ 1\);/);
assert.match(s, /\[DONE\]/);

assert.deepEqual(await (await fetch(`${p}/models`)).json(), { data: [{ id: 'm' }] });
// Browser-style requests (Origin header) and rebinding hosts are refused.
const status = (headers) => new Promise((resolve) => {
  http.get({ host: '127.0.0.1', port: proxy.address().port, path: '/v1/models', headers }, (res) => { res.resume(); resolve(res.statusCode); });
});
assert.equal(await status({ Origin: 'https://evil.example' }), 403);
assert.equal(await status({ Host: 'evil.example' }), 403);
assert.equal(await status({}), 200);
console.log('proxy OK');
proxy.close();
upstream.close();
