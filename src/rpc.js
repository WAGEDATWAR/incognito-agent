// Minimal newline-delimited JSON-RPC 2.0 peer over stdio (the ACP transport).
export class RpcPeer {
  constructor(input, output, log) {
    this.output = output;
    this.log = log;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.notifHandlers = new Map();
    let buf = '';
    input.setEncoding('utf8');
    input.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) this.#onLine(line);
      }
    });
    input.on('end', () => {
      for (const p of this.pending.values()) p.reject(new Error('connection closed'));
      this.pending.clear();
      this.onClose?.();
    });
  }

  onRequest(method, fn) { this.handlers.set(method, fn); }
  onNotification(method, fn) { this.notifHandlers.set(method, fn); }

  #send(msg) { this.output.write(JSON.stringify(msg) + '\n'); }

  notify(method, params) { this.#send({ jsonrpc: '2.0', method, params }); }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.#send({ jsonrpc: '2.0', id, method, params });
    });
  }

  async #onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { this.log('bad json:', line.slice(0, 200)); return; }
    if (msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        const e = new Error(msg.error.message || 'rpc error');
        e.code = msg.error.code; e.data = msg.error.data;
        p.reject(e);
      } else p.resolve(msg.result);
      return;
    }
    if (msg.id === undefined) {
      try { await this.notifHandlers.get(msg.method)?.(msg.params); }
      catch (e) { this.log('notification error', msg.method, e); }
      return;
    }
    const h = this.handlers.get(msg.method);
    if (!h) {
      this.#send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
      return;
    }
    try {
      const result = await h(msg.params ?? {});
      this.#send({ jsonrpc: '2.0', id: msg.id, result: result ?? {} });
    } catch (e) {
      this.log('handler error', msg.method, e);
      this.#send({ jsonrpc: '2.0', id: msg.id, error: { code: e.code ?? -32603, message: e.message || String(e) } });
    }
  }
}
