// Secret redaction: credentials found in text headed for the model are replaced with placeholders like
// [REDACTED:github-token:1], so they never leave the machine or reach saved chat history. When the model later uses
// a placeholder in a tool call (to keep a secret in a file it edits), the original is put back before the tool runs.

// High-precision shapes only; a false positive costs the model some context, a miss leaks a credential.
const PATTERNS = [
  ['private-key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g],
  ['aws-access-key', /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{16}\b/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{50,255})\b/g],
  ['api-key', /\bsk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{20,}\b/g],
  ['anonrouter-key', /\bar[m]?_[A-Za-z0-9]{20,}\b/g],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['stripe-key', /\b[sr]k_(?:live|test)_[0-9a-zA-Z]{20,}\b/g],
  ['npm-token', /\bnpm_[A-Za-z0-9]{36}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g],
  ['bearer-token', /(?<=\bBearer )[A-Za-z0-9._~+/=-]{20,}/g],
  ['url-credentials', /(?<=\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]{3,}(?=@)/gi],
];

// `password = "hunter2xyz"`-style assignments: only the value is replaced, and only if it looks like a literal
// (no spaces, no code punctuation) rather than a call or template.
const ASSIGNMENT = /(?<![A-Za-z])(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)[A-Za-z0-9_]*(["']?\s*[:=]\s*["']?)([^\s"'`,;(){}<>$]{8,})(?![^\s"'`,;(){}<>$]|\()/gi;
const looksLiteral = (v) => /\d/.test(v) || (/[a-z]/.test(v) && /[A-Z]/.test(v)) || /[^A-Za-z0-9_.-]/.test(v);

const PLACEHOLDER = /\[REDACTED:[a-z0-9-]+:\d+\]/g;
const HAS_PLACEHOLDER = /\[REDACTED:[a-z0-9-]+:\d+\]/; // non-global, so .test() keeps no state

export class Redactor {
  /** `known` are exact secrets to always catch (your own API keys), whatever they look like. */
  constructor({ enabled = true, known = [] } = {}) {
    this.enabled = enabled;
    this.known = known.filter((k) => typeof k === 'string' && k.length >= 8);
    this.byPlaceholder = new Map();
    this.bySecret = new Map();
    this.counts = new Map(); // kind -> number of distinct secrets
  }

  get total() { return this.bySecret.size; }

  placeholder(kind, secret) {
    let p = this.bySecret.get(secret);
    if (!p) {
      const n = (this.counts.get(kind) ?? 0) + 1;
      this.counts.set(kind, n);
      p = `[REDACTED:${kind}:${n}]`;
      this.bySecret.set(secret, p);
      this.byPlaceholder.set(p, secret);
    }
    return p;
  }

  /** Returns text with secrets replaced. Same secret, same placeholder. */
  redact(text) {
    if (!this.enabled || typeof text !== 'string' || !text) return text;
    let out = text;
    for (const k of this.known) if (out.includes(k)) out = out.split(k).join(this.placeholder('api-key', k));
    for (const [kind, re] of PATTERNS) out = out.replace(re, (m) => this.placeholder(kind, m));
    out = out.replace(ASSIGNMENT, (m, sep, value) => (value.includes('[REDACTED:') || !looksLiteral(value) ? m : m.slice(0, m.length - value.length) + this.placeholder('secret', value)));
    return out;
  }

  /** Redacts the text parts of message content (a string, or an array of content parts). */
  redactContent(content) {
    if (typeof content === 'string') return this.redact(content);
    if (Array.isArray(content)) return content.map((p) => (p.type === 'text' ? { ...p, text: this.redact(p.text) } : p));
    return content;
  }

  /** Puts originals back into model-written text. Unknown placeholders are left as they are. */
  restore(text) {
    if (typeof text !== 'string' || !this.byPlaceholder.size) return text;
    return text.replace(PLACEHOLDER, (p) => this.byPlaceholder.get(p) ?? p);
  }

  restoreDeep(value) {
    if (typeof value === 'string') return this.restore(value);
    if (Array.isArray(value)) return value.map((v) => this.restoreDeep(v));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.restoreDeep(v)]));
    return value;
  }

  /** A placeholder this session cannot resolve (for example from a reloaded chat) must never be written anywhere. */
  static hasPlaceholder(value) {
    return HAS_PLACEHOLDER.test(JSON.stringify(value));
  }

  summary() {
    return [...this.counts.entries()].map(([k, n]) => `${k} ×${n}`).join(', ');
  }
}

/** Masks secrets in a log or error line: your own keys, bearer tokens and anything that looks like a credential. */
export function scrub(text, known = []) {
  return new Redactor({ known }).redact(String(text)).replace(/\[REDACTED:([a-z0-9-]+):\d+\]/g, '[$1 hidden]');
}
