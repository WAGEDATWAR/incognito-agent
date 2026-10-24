import { createHash } from 'node:crypto';
import { killTree, spawnServer } from './proc.js';
import { VERSION } from './version.js';

// Minimal MCP (Model Context Protocol) client: stdio and Streamable HTTP transports, tools only.
// The IDE hands us the user's configured servers in session/new; their tools are offered to the model.

const PROTOCOL_VERSION = '2025-06-18';
const CONNECT_TIMEOUT_MS = 20000;
const CALL_TIMEOUT_MS = 120000;
const MAX_OUT = 30000;

const withTimeout = (promise, ms, what) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms); }),
  ]).finally(() => clearTimeout(timer));
};

class StdioTransport {
  constructor(server, log) {
    const env = { ...process.env, ...Object.fromEntries((server.env ?? []).map((e) => [e.name, e.value])) };
    this.child = spawnServer(server.command, server.args ?? [], { cwd: process.cwd(), env });
    this.pending = new Map();
    this.nextId = 1;
    this.log = log;
    let buf = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const p = msg.id !== undefined && !msg.method ? this.pending.get(msg.id) : null;
        if (!p) continue; // server-initiated requests and notifications are not needed for tools
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message ?? 'MCP error')); else p.resolve(msg.result);
      }
    });
    this.child.stderr.on('data', (d) => log(`[mcp ${server.name}]`, String(d).trim().slice(0, 300)));
    const fail = (e) => { for (const p of this.pending.values()) p.reject(e); this.pending.clear(); };
    this.child.on('error', fail);
    this.child.on('exit', () => fail(new Error('MCP server exited')));
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  close() { killTree(this.child); }
}

class HttpTransport {
  constructor(server) {
    this.url = server.url;
    this.headers = Object.fromEntries((server.headers ?? []).map((h) => [h.name, h.value]));
    this.sessionId = null;
    this.nextId = 1;
  }

  async post(body, expectId) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...this.headers };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    if (this.ready) headers['MCP-Protocol-Version'] = PROTOCOL_VERSION;
    const res = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify(body) });
    this.sessionId ??= res.headers.get('mcp-session-id');
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}`);
    if (expectId === undefined) { await res.arrayBuffer(); return undefined; }
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('text/event-stream')) return this.readEvents(res, expectId);
    return this.unwrap(await res.json(), expectId);
  }

  unwrap(msg, id) {
    if (msg.id !== id) return undefined;
    if (msg.error) throw new Error(msg.error.message ?? 'MCP error');
    return msg.result;
  }

  async readEvents(res, id) {
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const event = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = event.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
        if (!data) continue;
        let msg;
        try { msg = JSON.parse(data); } catch { continue; }
        const out = this.unwrap(msg, id);
        if (out !== undefined || msg.id === id) return out;
      }
    }
    throw new Error('MCP stream ended without a response');
  }

  request(method, params) {
    const id = this.nextId++;
    return this.post({ jsonrpc: '2.0', id, method, params }, id).then((r) => {
      if (method === 'initialize') this.ready = true;
      return r;
    });
  }

  notify(method, params) {
    return this.post({ jsonrpc: '2.0', method, params });
  }

  close() {
    if (this.sessionId) fetch(this.url, { method: 'DELETE', headers: { ...this.headers, 'Mcp-Session-Id': this.sessionId } }).catch(() => {});
  }
}

const safe = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '_');

// OpenAI function names are limited to 64 characters of [a-zA-Z0-9_-].
export function toolName(server, tool) {
  const full = `mcp__${safe(server)}__${safe(tool)}`;
  if (full.length <= 64) return full;
  return `${full.slice(0, 55)}_${createHash('sha1').update(full).digest('hex').slice(0, 8)}`;
}

export function resultText(result) {
  const parts = (result?.content ?? []).map((c) => (c.type === 'text' ? c.text : `[${c.type} content omitted]`));
  const text = parts.join('\n') || (result?.structuredContent ? JSON.stringify(result.structuredContent) : '');
  return text.length > MAX_OUT ? `${text.slice(0, MAX_OUT)}\n…[truncated ${text.length - MAX_OUT} chars]` : text;
}

export class McpHub {
  constructor(log) {
    this.log = log;
    this.clients = new Map(); // server name -> transport
    this.tools = []; // { name, kind, description, parameters, mcp: { server, tool } }
    this.failures = []; // { server, error }
  }

  /** Connects to every server in parallel; one failing server never blocks the others. */
  async connect(servers = []) {
    await Promise.all(servers.map((s) => this.connectOne(s)));
    return this;
  }

  async connectOne(server) {
    let transport;
    try {
      transport = server.type === 'http' || (server.url && !server.command) ? new HttpTransport(server) : new StdioTransport(server, this.log);
      if (server.type === 'sse') throw new Error('SSE transport is not supported (use stdio or HTTP)');
      await withTimeout((async () => {
        await transport.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'acp-agent', version: VERSION } });
        await transport.notify('notifications/initialized', {});
        let cursor;
        do {
          const page = await transport.request('tools/list', cursor ? { cursor } : {});
          for (const t of page.tools ?? []) this.addTool(server.name, t);
          cursor = page.nextCursor;
        } while (cursor);
      })(), CONNECT_TIMEOUT_MS, `connecting to ${server.name}`);
      this.clients.set(server.name, transport);
    } catch (e) {
      transport?.close();
      this.failures.push({ server: server.name, error: e.message });
      this.log(`MCP server "${server.name}" unavailable:`, e.message);
    }
  }

  addTool(server, t) {
    const schema = t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} };
    this.tools.push({
      name: toolName(server, t.name),
      kind: 'other',
      description: `[${server}] ${t.description ?? t.title ?? t.name}`.slice(0, 1000),
      parameters: { type: 'object', properties: {}, ...schema },
      mcp: { server, tool: t.name },
    });
  }

  find(name) { return this.tools.find((t) => t.name === name); }

  async call(def, args) {
    const client = this.clients.get(def.mcp.server);
    if (!client) throw new Error(`MCP server "${def.mcp.server}" is not connected`);
    const result = await withTimeout(client.request('tools/call', { name: def.mcp.tool, arguments: args }), CALL_TIMEOUT_MS, `${def.mcp.tool}`);
    const text = resultText(result);
    if (result?.isError) throw new Error(text || 'tool reported an error');
    return text || '(no output)';
  }

  close() {
    for (const c of this.clients.values()) c.close();
    this.clients.clear();
  }
}
