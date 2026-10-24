import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { contentText } from './content.js';

// Chat history is saved per session so AI Chat can resume conversations after an IDE restart.
// Files live in ~/<provider dir>/sessions/ and contain the conversation, including any file contents it quoted.

const MAX_SESSIONS = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

export class SessionStore {
  // `retentionDays` (0 = keep until pruned by count): chats older than this are deleted when the agent starts or saves.
  constructor(provider, enabled = true, retentionDays = 0) {
    this.dir = path.join(os.homedir(), provider.credentialsDir, 'sessions');
    this.enabled = enabled;
    this.retentionDays = retentionDays;
    if (enabled) this.prune();
  }

  file(id) { return path.join(this.dir, `${String(id).replace(/[^\w-]/g, '_')}.json`); }

  save(s) {
    if (!this.enabled) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const data = {
        id: s.id, cwd: s.cwd, model: s.model, mode: s.mode, effort: s.effort, title: s.title ?? null,
        updatedAt: new Date().toISOString(),
        messages: s.messages.slice(1), // the system prompt is rebuilt on load
      };
      const tmp = `${this.file(s.id)}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
      fs.renameSync(tmp, this.file(s.id));
      this.prune();
    } catch { /* history is best-effort; never fail a turn over it */ }
  }

  load(id) {
    try { return JSON.parse(fs.readFileSync(this.file(id), 'utf8')); } catch { return null; }
  }

  list(cwd) {
    if (!this.enabled) return [];
    let files = [];
    try { files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')); } catch { return []; }
    const out = [];
    for (const f of files) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
        if (!cwd || path.resolve(d.cwd) === path.resolve(cwd)) out.push({ sessionId: d.id, cwd: d.cwd, title: d.title, updatedAt: d.updatedAt });
      } catch { /* skip unreadable files */ }
    }
    return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  delete(id) { fs.rmSync(this.file(id), { force: true }); }

  deleteAll() {
    let files = [];
    try { files = fs.readdirSync(this.dir); } catch { return; }
    for (const f of files) if (f.endsWith('.json') || f.endsWith('.tmp')) fs.rmSync(path.join(this.dir, f), { force: true });
  }

  prune() {
    const all = this.list();
    const cutoff = this.retentionDays > 0 ? Date.now() - this.retentionDays * DAY_MS : 0;
    for (const [i, s] of all.entries()) {
      if (i >= MAX_SESSIONS || (cutoff && Date.parse(s.updatedAt) < cutoff)) this.delete(s.sessionId);
    }
  }
}

export const titleFrom = (text) => text.replace(/<file[\s\S]*?<\/file>/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'New chat';

/** Replays saved history to the client as session updates, as session/load requires. */
export function replayHistory(agent, s) {
  const id = s.id;
  const calls = new Map();
  for (const m of s.messages.slice(1)) {
    if (m.role === 'user') {
      agent.text(id, 'user_message_chunk', contentText(m.content));
    } else if (m.role === 'assistant') {
      if (m.content) agent.text(id, 'agent_message_chunk', contentText(m.content));
      for (const c of m.tool_calls ?? []) {
        let args = {};
        try { args = JSON.parse(c.function.arguments || '{}'); } catch { /* keep empty */ }
        agent.usedToolIds.add(c.id);
        calls.set(c.id, true);
        agent.update(id, { sessionUpdate: 'tool_call', toolCallId: c.id, title: c.function.name, kind: agent.kindOf(s, c.function.name), status: 'completed', rawInput: args });
      }
    } else if (m.role === 'tool' && calls.has(m.tool_call_id)) {
      agent.update(id, { sessionUpdate: 'tool_call_update', toolCallId: m.tool_call_id, status: 'completed', rawOutput: contentText(m.content) });
    }
  }
}
