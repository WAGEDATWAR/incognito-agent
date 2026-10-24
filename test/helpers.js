// Shared test harness: scripted fake provider server + fake ACP client driving a real agent process.
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'acp-'));

export const sse = (res, objs) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const o of objs) res.write(`data: ${JSON.stringify(o)}\n\n`);
  res.end('data: [DONE]\n\n');
};

export const toolCall = (id, name, args) => [
  { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] },
  { choices: [{ finish_reason: 'tool_calls', delta: {} }] },
];
export const say = (text) => [{ choices: [{ delta: { content: text } }] }, { choices: [{ finish_reason: 'stop', delta: {} }] }];

/** Fake provider: `models` answers GET /models, `script(call, body, res)` answers each chat request. */
export async function startMock({ models, script }) {
  const state = { calls: 0, bodies: [] };
  const server = http.createServer((req, res) => {
    if (req.url.endsWith('/models')) return res.end(JSON.stringify(models));
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      const body = JSON.parse(b);
      state.bodies.push(body);
      script(++state.calls, body, res);
    });
  });
  await new Promise((r) => server.listen(0, r));
  state.url = `http://127.0.0.1:${server.address().port}/v1`;
  state.close = () => server.close();
  return state;
}

/** Spawns bin/<bin> and speaks ACP to it. `onRequest(method, params)` answers agent->client requests. */
export function startClient(bin, env, onRequest) {
  // Isolated home so tests never touch the real credentials or saved sessions.
  const home = tmpDir();
  const proc = spawn('node', [path.join(root, 'bin', bin)], { env: { ...process.env, HOME: home, USERPROFILE: home, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const c = { updates: [], requests: [], proc, home };
  let buf = '';
  let id = 1;
  const waiting = new Map();
  const send = (m) => proc.stdin.write(JSON.stringify(m) + '\n');
  c.request = (method, params) => new Promise((resolve, reject) => {
    const i = id++;
    waiting.set(i, { resolve, reject });
    send({ jsonrpc: '2.0', id: i, method, params });
  });
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (m.method === 'session/update') c.updates.push(m.params.update);
      else if (m.method) {
        c.requests.push(m);
        Promise.resolve(onRequest?.(m.method, m.params)).then(
          (result) => send(result === undefined
            ? { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'unsupported' } }
            : { jsonrpc: '2.0', id: m.id, result }),
        );
      } else {
        const w = waiting.get(m.id);
        if (m.error) w.reject(Object.assign(new Error(m.error.message), { code: m.error.code })); else w.resolve(m.result);
      }
    }
  });
  c.close = () => proc.kill();
  return c;
}
