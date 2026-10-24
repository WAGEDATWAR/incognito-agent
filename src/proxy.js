import http from 'node:http';
import fs from 'node:fs';

// Experimental: lets JetBrains "AI Completion → OpenAI Compatible" work against Anonrouter, which has no
// /v1/completions endpoint. Completion requests are rewritten into chat requests; everything else is forwarded.

const SYSTEM = `You are a code completion engine embedded in an IDE.
You receive the code before the cursor (PREFIX) and after the cursor (SUFFIX). Reply with ONLY the text that belongs at the cursor.
Rules: no explanations, no markdown code fences, do not repeat the prefix or the suffix, match the existing indentation and style.
Keep it short: usually the rest of the current statement or a few lines. If nothing sensible fits, reply with an empty message.`;

// Fill-in-the-middle prompt formats the IDE may emit, depending on the model's "prompt schema".
const FIM_FORMATS = [
  { re: /<\|fim_prefix\|>([\s\S]*?)<\|fim_suffix\|>([\s\S]*?)<\|fim_middle\|>/, prefix: 1, suffix: 2 },
  { re: /<fim_prefix>([\s\S]*?)<fim_suffix>([\s\S]*?)<fim_middle>/, prefix: 1, suffix: 2 },
  { re: /<｜fim▁begin｜>([\s\S]*?)<｜fim▁hole｜>([\s\S]*?)<｜fim▁end｜>/, prefix: 1, suffix: 2 },
  { re: /<PRE>([\s\S]*?)<SUF>([\s\S]*?)<MID>/, prefix: 1, suffix: 2 },
  { re: /\[SUFFIX\]([\s\S]*?)\[PREFIX\]([\s\S]*)$/, prefix: 2, suffix: 1 },
];

export function splitFim(prompt, suffixField) {
  for (const f of FIM_FORMATS) {
    const m = prompt.match(f.re);
    if (m) return { prefix: prompt.slice(0, m.index) + m[f.prefix], suffix: m[f.suffix] };
  }
  return { prefix: prompt, suffix: suffixField ?? '' };
}

export function cleanCompletion(text, stops = []) {
  let out = text.replace(/^```[\w+-]*\r?\n?/, '').replace(/\r?\n?```\s*$/, '');
  for (const s of stops) {
    const i = s ? out.indexOf(s) : -1;
    if (i >= 0) out = out.slice(0, i);
  }
  return out;
}

export function createProxy({ llm, resolveKey, debugFile, log }) {
  const debug = (...a) => { if (debugFile) fs.appendFileSync(debugFile, a.join(' ') + '\n'); };

  async function complete(body) {
    const stops = [].concat(body.stop ?? []).filter(Boolean);
    const { prefix, suffix } = splitFim(String(Array.isArray(body.prompt) ? body.prompt[0] : body.prompt ?? ''), body.suffix);
    const user = `<PREFIX>\n${prefix}\n</PREFIX>\n<SUFFIX>\n${suffix}\n</SUFFIX>\nWrite the code that goes at the cursor.`;
    const extra = { max_tokens: Math.min(body.max_tokens ?? 256, 1024), temperature: body.temperature ?? 0 };
    if (stops.length) extra.stop = stops.slice(0, 4);
    const turn = await llm().chat({
      model: body.model,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
      extra,
    });
    return cleanCompletion(turn.content, stops);
  }

  function completionResponse(model, text, stream, res) {
    const id = `cmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const choice = (finish) => ({ text, index: 0, logprobs: null, finish_reason: finish });
    if (stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(`data: ${JSON.stringify({ id, object: 'text_completion', created, model, choices: [choice(null)] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id, object: 'text_completion', created, model, choices: [{ text: '', index: 0, logprobs: null, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id, object: 'text_completion', created, model, choices: [choice('stop')], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }));
    }
  }

  async function forward(req, res, rawBody, upstreamPath) {
    const key = resolveKey() || (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const r = await fetch(`${llm().baseUrl}${upstreamPath}`, {
      method: req.method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : rawBody,
    });
    res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') ?? 'application/json' });
    if (r.body) for await (const chunk of r.body) res.write(chunk);
    res.end();
  }

  return http.createServer((req, res) => {
    // The proxy holds your saved key, so refuse requests a web page could make (CSRF / DNS rebinding).
    // The IDE's HTTP client sends neither an Origin header nor a non-local Host.
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (req.headers.origin || !['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'forbidden', type: 'proxy_error' } }));
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const urlPath = req.url.split('?')[0].replace(/^\/v1(?=\/)/, '');
      debug(`--- ${new Date().toISOString()} ${req.method} ${req.url}\n${raw.slice(0, 20000)}`);
      try {
        if (req.method === 'POST' && urlPath === '/completions') {
          const body = JSON.parse(raw);
          const text = await complete(body);
          debug(`=> ${JSON.stringify(text)}`);
          return completionResponse(body.model, text, !!body.stream, res);
        }
        await forward(req, res, raw, urlPath);
      } catch (e) {
        log('proxy error:', e.message);
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: e.message, type: 'proxy_error' } }));
      }
    });
  });
}

