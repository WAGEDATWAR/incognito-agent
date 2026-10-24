// Client for OpenAI-style /chat/completions backends (Anonrouter, Venice): streaming, retries, stall detection.
const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('aborted', 'AbortError')); }, { once: true });
});

export class LlmError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

const midStream = (message) => Object.assign(new LlmError(message), { midStream: true });

// Some models inline their reasoning as <think>…</think> in the content stream; route it to onThought.
class ThinkSplitter {
  constructor(onText, onThought) {
    Object.assign(this, { onText, onThought, buf: '', inThink: false });
  }

  static partialSuffix(s, tag) {
    for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) if (tag.startsWith(s.slice(-n))) return n;
    return 0;
  }

  push(chunk) {
    this.buf += chunk;
    for (;;) {
      const tag = this.inThink ? '</think>' : '<think>';
      const i = this.buf.indexOf(tag);
      const emit = this.inThink ? this.onThought : this.onText;
      if (i >= 0) {
        if (i) emit(this.buf.slice(0, i));
        this.buf = this.buf.slice(i + tag.length);
        if (this.inThink) this.buf = this.buf.replace(/^\n+/, '');
        this.inThink = !this.inThink;
        continue;
      }
      const keep = ThinkSplitter.partialSuffix(this.buf, tag);
      if (this.buf.length > keep) emit(this.buf.slice(0, this.buf.length - keep));
      this.buf = this.buf.slice(this.buf.length - keep);
      return;
    }
  }

  flush() {
    if (this.buf) (this.inThink ? this.onThought : this.onText)(this.buf);
    this.buf = '';
  }
}

export class ChatClient {
  // `controlUrl` is the identity/billing origin used for model listing and ticket issuance in ticket mode.
  constructor({ baseUrl, controlUrl, apiKey, provider, log, idleMs = 120000 }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.controlUrl = (controlUrl ?? baseUrl).replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.provider = provider;
    this.log = log;
    this.idleMs = idleMs;
  }

  headers() {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` };
  }

  // In ticket mode the key goes only to the control origin; the content origin never sees it.
  async listModels(timeoutMs = 8000, { viaControl = false } = {}) {
    const res = await fetch(`${viaControl ? this.controlUrl : this.baseUrl}/models`, { headers: this.headers(), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new LlmError(`models: HTTP ${res.status}`, res.status);
    return this.provider.parseModels(await res.json());
  }

  /**
   * Runs one assistant turn. Callbacks: onText(str), onThought(str), onRetry({reason, waitMs, attempt}).
   * `stream: false` is for models that don't stream. A connection that goes silent for `idleMs` is aborted and
   * reported as a mid-stream failure so the caller can retry it.
   * `tickets: true` uses the private two-step flow: each attempt exchanges the API key at the control origin for a
   * single-use ticket (bound to the model, output ceiling = `extra.max_tokens`, reasoning and provider policy), then
   * sends the content with only the ticket, never the key.
   * Returns { content, toolCalls: [{id,name,arguments}], finishReason, usage, headers }.
   */
  async chat({ model, messages, tools, signal, onText, onThought, onRetry, extra = {}, stream = true, tickets = false }) {
    const body = { model, messages, stream, ...extra };
    if (tools?.length) { body.tools = tools; body.tool_choice = 'auto'; }
    if (tickets && !this.provider.ticketBody) throw new LlmError(`${this.provider.title} has no ticket flow`);
    if (tickets && !extra.max_tokens) throw new LlmError('ticket mode needs an output limit (max_tokens)');

    // Returns the content response, or the control plane's error response if no ticket could be issued.
    const send = async (sig) => {
      const json = { 'Content-Type': 'application/json' };
      if (!tickets) return fetch(`${this.baseUrl}/chat/completions`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: sig });
      const minted = await fetch(`${this.controlUrl}/inference/tickets`, {
        method: 'POST', headers: this.headers(), signal: sig, body: JSON.stringify(this.provider.ticketBody({ model, extra })),
      });
      if (!minted.ok) return minted;
      const { ticket } = await minted.json();
      if (typeof ticket !== 'string' || !ticket) throw new LlmError(`${this.provider.title} returned an invalid inference ticket`);
      return fetch(`${this.baseUrl}/chat/completions`, { method: 'POST', headers: { ...json, 'x-anonrouter-ticket': ticket }, body: JSON.stringify(body), signal: sig });
    };

    let res;
    let idle;
    let timer;
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => idle.abort(new Error('idle')), this.idleMs); };
    const stalled = () => idle.signal.aborted && !signal?.aborted;

    for (let attempt = 0; ; attempt++) {
      idle = new AbortController();
      const sig = signal ? AbortSignal.any([signal, idle.signal]) : idle.signal;
      arm();
      try {
        res = await send(sig);
      } catch (e) {
        if (e instanceof LlmError) { clearTimeout(timer); throw e; }
        clearTimeout(timer);
        if (signal?.aborted) throw e;
        const reason = stalled() ? `no response for ${this.idleMs / 1000}s` : `network error: ${e.cause?.message ?? e.message}`;
        if (attempt < 3) {
          const waitMs = 1000 * 2 ** attempt;
          onRetry?.({ reason, waitMs, attempt: attempt + 1 });
          await sleep(waitMs, signal);
          continue;
        }
        throw new LlmError(reason);
      }
      if (res.ok) break;
      clearTimeout(timer);
      const text = await res.text().catch(() => '');
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* not JSON */ }
      // A ticket can lapse (about 30 s) or be spent between minting and use; the retry mints a fresh one.
      const staleTicket = tickets && res.status === 401 && parsed?.error?.type === 'invalid_ticket';
      const retriable = res.status === 429 || res.status >= 500 || staleTicket;
      if (retriable && attempt < 3) {
        const ra = Number(res.headers.get('retry-after'));
        const waitMs = staleTicket ? 0 : this.provider.retryAfterMs?.(res.headers) ?? (ra > 0 ? Math.min(ra, 30) * 1000 : 1000 * 2 ** attempt);
        onRetry?.({ reason: res.status === 429 ? 'rate limited' : staleTicket ? 'ticket expired' : `HTTP ${res.status}`, waitMs, attempt: attempt + 1 });
        await sleep(waitMs, signal);
        continue;
      }
      let detail = parsed?.error?.message ?? (typeof parsed?.error === 'string' ? parsed.error : null) ?? text.slice(0, 500);
      const hint = this.provider.explainError?.(res.status, parsed);
      if (hint) detail = `${detail} (${hint})`;
      throw new LlmError(`HTTP ${res.status}: ${detail}`, res.status);
    }

    let content = '';
    let finishReason = null;
    let usage = null;
    let sawOutput = false;
    const calls = new Map();
    const splitter = new ThinkSplitter((t) => { content += t; onText?.(t); }, (t) => onThought?.(t));

    const addToolCall = (tc, n) => {
      const idx = tc.index ?? n;
      const c = calls.get(idx) ?? { id: '', name: '', arguments: '' };
      if (tc.id) c.id = tc.id;
      if (tc.function?.name) c.name += tc.function.name;
      if (tc.function?.arguments) c.arguments += tc.function.arguments;
      calls.set(idx, c);
    };

    const handleChunk = (j) => {
      if (j.error) {
        const { message, ...rest } = typeof j.error === 'object' ? j.error : { message: String(j.error) };
        throw midStream(`stream error: ${message ?? 'unknown'}${Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : ''}`);
      }
      if (j.usage) usage = j.usage; // providers that report it send it on the last chunk, often with empty choices
      const choice = j.choices?.[0];
      if (!choice) return;
      const d = stream ? choice.delta ?? {} : choice.message ?? {};
      const thought = d.reasoning_content ?? d.reasoning;
      if (thought) { sawOutput = true; onThought?.(thought); }
      if (d.content) { sawOutput = true; splitter.push(d.content); }
      (d.tool_calls ?? []).forEach((tc, n) => { sawOutput = true; addToolCall(tc, n); });
      if (choice.finish_reason) finishReason = choice.finish_reason;
    };

    try {
      if (!stream) {
        handleChunk(await res.json());
      } else {
        const decoder = new TextDecoder();
        let buf = '';
        const handleLine = (line) => {
          if (!line.startsWith('data:')) return;
          const data = line.slice(5).trim();
          if (data === '[DONE]') return;
          let j;
          try { j = JSON.parse(data); } catch { return; }
          handleChunk(j);
        };
        for await (const chunk of res.body) {
          arm();
          buf += decoder.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            handleLine(buf.slice(0, i).replace(/\r$/, ''));
            buf = buf.slice(i + 1);
          }
        }
        handleLine(buf);
      }
    } catch (e) {
      if (signal?.aborted || e.midStream) throw e;
      if (stalled()) throw midStream(`stream stalled (no data for ${this.idleMs / 1000}s)`);
      if (e.name === 'AbortError') throw e;
      throw midStream(`stream interrupted: ${e.cause?.message ?? e.message}`);
    } finally {
      clearTimeout(timer);
    }
    splitter.flush();
    if (!finishReason && !sawOutput) throw midStream('stream ended without any output');

    const toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c], n) => ({
      id: c.id || `call_${Date.now()}_${n}`, name: c.name, arguments: c.arguments,
    }));
    return { content, toolCalls, finishReason, usage, headers: res.headers };
  }
}
