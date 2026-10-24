import { randomUUID } from 'node:crypto';
import { ChatClient, LlmError } from './llm.js';
import { ToolRunner, TOOL_DEFS, READ_ONLY_KINDS, openAiTools, toolDef } from './tools.js';
import { ThoughtBuffer } from './thinking.js';
import { contentLength, contentText, promptToContent } from './content.js';
import { McpHub } from './mcp.js';
import { SessionStore, replayHistory, titleFrom } from './sessions.js';
import { SettingsStore } from './settings.js';
import { VERSION } from './version.js';
import { Redactor, scrub } from './redact.js';

const DEFAULT_HISTORY_CHARS = 400000;
const DEFAULT_TICKET_OUTPUT_TOKENS = 16384; // worst-case cost is reserved from this ceiling, then refunded

// Operation modes, named and identified like JetBrains' own Claude Agent integration so AI Chat treats them familiarly.
export const MODES = [
  { id: 'default', name: 'Manual', description: 'Ask before editing files or running commands' },
  { id: 'acceptEdits', name: 'Accept edits', description: 'Edit files freely; ask before running commands' },
  { id: 'plan', name: 'Plan', description: 'Read-only: explore the project and propose a plan, change nothing' },
  { id: 'bypassPermissions', name: 'Bypass permissions', description: 'Never ask for approval' },
];

const COMMANDS = [
  { name: 'clear', description: 'Clear the conversation context and start fresh' },
  { name: 'compact', description: 'Summarize the conversation to free up context' },
  { name: 'status', description: 'Show the model, route, privacy tier, session cost and balance' },
  { name: 'forget', description: 'Delete this chat from disk and stop saving it (/forget all deletes every saved chat)' },
];

const systemPrompt = (cwd, mode) => `You are a coding agent running inside a JetBrains IDE, working in the project at ${cwd}.
Use the provided tools to inspect and change the project. Prefer read_file/list_dir/search_files before editing, use edit_file for targeted changes, and verify with run_command when sensible.
For multi-step work, keep a short checklist visible with update_plan.
Be concise. Paths may be relative to the project root.${mode === 'plan' ? `
You are in PLAN mode: you can only read and search. Investigate, then present a clear step-by-step plan. Do not attempt to modify files or run commands.` : ''}`;

export class AcpAgent {
  constructor({ rpc, provider, config, log }) {
    this.rpc = rpc;
    this.provider = provider;
    this.config = config;
    this.log = log;
    this.llm = null;
    this.sessions = new Map();
    this.clientCaps = {};
    this.modelCache = null;
    this.usedToolIds = new Set();
    this.store = new SessionStore(provider, config.saveSessions !== false, config.sessionRetentionDays ?? 0);
    this.settings = new SettingsStore(provider);
    this.ensureClient();

    rpc.onRequest('initialize', (p) => this.initialize(p));
    rpc.onRequest('authenticate', async () => { await this.requireAuth(); return {}; });
    rpc.onRequest('session/new', (p) => this.newSession(p));
    rpc.onRequest('session/load', (p) => this.loadSession(p));
    rpc.onRequest('session/list', (p) => ({ sessions: this.store.list(p?.cwd) }));
    rpc.onRequest('session/prompt', (p) => this.prompt(p));
    rpc.onRequest('session/set_mode', (p) => this.setMode(p));
    rpc.onRequest('session/set_model', (p) => this.setModel(p));
    rpc.onRequest('session/set_config_option', (p) => this.setConfigOption(p));
    rpc.onNotification('session/cancel', (p) => this.sessions.get(p.sessionId)?.abort?.abort());
  }

  // ---- auth ---------------------------------------------------------------------------------------------

  // (Re)reads the key from env or the saved credentials file; returns true when authenticated.
  ensureClient() {
    const apiKey = this.config.loadApiKey();
    if (!apiKey) return false;
    if (!this.llm || this.llm.apiKey !== apiKey) {
      this.llm = new ChatClient({ baseUrl: this.config.baseUrl, controlUrl: this.config.controlUrl, apiKey, provider: this.provider, log: this.log, idleMs: this.config.streamIdleMs });
      this.modelCache = null;
    }
    return true;
  }

  authError() {
    const how = this.config.canShowDialog?.() === false
      ? `Run "${this.config.loginCommand ?? `${this.provider.id}-acp login`}" in a terminal to save your key`
      : 'Choose "Authenticate" for this agent';
    return Object.assign(new Error(`${this.provider.title} API key missing. ${how}, or set ${this.provider.envPrefix}_API_KEY.`), { code: -32000 });
  }

  // Asks the user for the key in a native dialog and saves it. Concurrent callers share one dialog.
  askForKey() {
    this.keyDialog ??= (async () => {
      try {
        const key = await this.config.promptForKey();
        if (key) this.config.saveApiKey(key);
      } catch (e) {
        this.log('key prompt failed:', e.message);
      } finally {
        this.keyDialog = null;
      }
      return this.ensureClient();
    })();
    return this.keyDialog;
  }

  async requireAuth() {
    if (this.ensureClient() || (await this.askForKey())) return;
    throw this.authError();
  }

  // Authentication methods offered while no key is saved. The dialog method is handled through `authenticate`; the
  // terminal method (only when the client supports it, and only where a dialog can't be shown, such as a remote
  // host) has the client run this agent with `login` appended.
  authMethods() {
    if (this.ensureClient()) return [];
    const methods = [{
      id: `${this.provider.id}-api-key`,
      name: `Enter ${this.provider.title} API key`,
      description: `Shows a dialog to paste your ${this.provider.title} API key (saved to ~/${this.provider.credentialsDir}/credentials.json).`,
    }];
    if (this.clientCaps.auth?.terminal === true && this.config.canShowDialog?.() === false) {
      methods.push({
        id: `${this.provider.id}-terminal`,
        type: 'terminal',
        name: `Log in to ${this.provider.title} in a terminal`,
        description: `Prompts for your ${this.provider.title} API key in a terminal and saves it.`,
        args: ['login'],
      });
    }
    return methods;
  }

  // ---- session setup ------------------------------------------------------------------------------------

  async initialize(p) {
    this.clientCaps = p.clientCapabilities ?? {};
    return {
      protocolVersion: 1,
      agentInfo: { name: `${this.provider.id}-acp`, title: this.provider.title, version: VERSION },
      agentCapabilities: {
        loadSession: this.store.enabled,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        mcpCapabilities: { http: true, sse: false },
        ...(this.store.enabled ? { sessionCapabilities: { list: {} } } : {}),
      },
      authMethods: this.authMethods(),
    };
  }

  async models() {
    if (this.modelCache) return this.modelCache;
    let list = [];
    try { list = await this.llm.listModels(8000, { viaControl: this.ticketMode() }); } catch (e) { this.log('model list failed:', e.message); }
    if (this.config.hideNoTools) list = list.filter((m) => m.tools !== false);
    if (!list.some((m) => m.id === this.config.model)) list.unshift({ id: this.config.model, name: this.config.model, tools: true, efforts: [] });
    return (this.modelCache = list);
  }

  // Private ticket flow in use? (Only providers that define one, i.e. Anonrouter.)
  ticketMode() {
    return !!this.provider.useTickets?.({ env: process.env, settings: this.settings.resolved() });
  }

  // Output ceiling for ticketed requests: the ticket is bound to it, so it is always set explicitly.
  withTicketLimit(extra, model) {
    if (this.ticketMode()) extra.max_tokens ??= Math.min(DEFAULT_TICKET_OUTPUT_TOKENS, model.maxOut ?? Infinity);
    return extra;
  }

  info(modelId) {
    return this.modelCache?.find((m) => m.id === modelId) ?? { id: modelId, name: modelId, tools: true, efforts: [] };
  }

  modesState(s) {
    return { currentModeId: s.mode, availableModes: MODES };
  }

  // Models the privacy floor allows (providers without a client-side floor allow all).
  visibleModels() {
    const settings = this.settings.resolved();
    return this.modelCache.filter((m) => !this.provider.allowsModel?.({ model: m, env: process.env, settings }));
  }

  modelsState(s) {
    return { currentModelId: s.model, availableModels: this.visibleModels().map((m) => ({ modelId: m.id, name: m.name })) };
  }

  // Config options are what current ACP clients show in the chat's mode / model / reasoning menus.
  configOptions(s) {
    const opts = [
      { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: s.mode,
        options: MODES.map((m) => ({ value: m.id, name: m.name, description: m.description })) },
      { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: s.model,
        options: this.visibleModels().map((m) => ({ value: m.id, name: m.name })) },
    ];
    const efforts = this.info(s.model).efforts ?? [];
    if (efforts.length) {
      opts.push({ id: 'reasoning_effort', name: 'Reasoning effort', category: 'thought_level', type: 'select',
        currentValue: s.effort && efforts.includes(s.effort) ? s.effort : 'default',
        options: [{ value: 'default', name: 'Default' }, ...efforts.map((e) => ({ value: e, name: e }))] });
    }
    // Provider-specific menus (routing, web search, ...); their choices persist in settings.json.
    for (const m of this.provider.settings ?? []) {
      opts.push({ id: m.id, name: m.name, description: m.description, category: 'model_config', type: 'select', currentValue: this.settings.get(m.id),
        options: m.options });
    }
    return opts;
  }

  sessionState(s) {
    return {
      modes: this.modesState(s),
      models: this.modelsState(s),
      ...(this.config.configOptions ? { configOptions: this.configOptions(s) } : {}),
    };
  }

  // Builds the in-memory session, restoring saved history and connecting the MCP servers the IDE passed.
  async createSession(id, cwd, mcpServers, saved) {
    await this.requireAuth();
    await this.models();
    const dir = cwd || saved?.cwd || process.cwd();
    const model = saved?.model && this.modelCache.some((m) => m.id === saved.model) ? saved.model : this.config.model;
    const mode = MODES.some((m) => m.id === saved?.mode) ? saved.mode : this.config.mode;
    const s = {
      id, cwd: dir, model, mode, effort: saved?.effort ?? null, title: saved?.title ?? null,
      messages: [{ role: 'system', content: systemPrompt(dir, mode) }, ...(saved?.messages ?? [])],
      allowed: new Set(), abort: null, running: null, gen: 0, notedNoTools: new Set(), mcp: null, noSave: false,
      redactor: new Redactor({ enabled: this.config.redactSecrets !== false, known: this.config.knownSecrets?.() ?? [] }),
    };
    s.tools = new ToolRunner({ rpc: this.rpc, sessionId: id, cwd: dir, caps: this.clientCaps, log: this.log });
    if (mcpServers?.length) s.mcp = await new McpHub(this.log).connect(mcpServers);
    this.sessions.set(id, s);
    return s;
  }

  // The client only learns the session id from the response, so these go out just after it.
  announce(s) {
    setTimeout(() => {
      this.reportUsage(s, this.info(s.model));
      this.update(s.id, { sessionUpdate: 'available_commands_update', availableCommands: COMMANDS });
      for (const f of s.mcp?.failures ?? []) this.text(s.id, 'agent_message_chunk', `_MCP server "${f.server}" is unavailable: ${f.error}_\n\n`);
    }, 0);
  }

  async newSession({ cwd, mcpServers }) {
    const s = await this.createSession(randomUUID(), cwd, mcpServers, null);
    this.announce(s);
    return { sessionId: s.id, ...this.sessionState(s) };
  }

  async loadSession({ sessionId, cwd, mcpServers }) {
    const saved = this.store.load(sessionId);
    if (!saved) throw Object.assign(new Error(`no saved session ${sessionId}`), { code: -32602 });
    const s = await this.createSession(sessionId, cwd, mcpServers, saved);
    replayHistory(this, s); // session/load must stream the whole conversation back before it responds
    this.announce(s);
    return this.sessionState(s);
  }

  session(id) {
    const s = this.sessions.get(id);
    if (!s) throw Object.assign(new Error(`unknown session ${id}`), { code: -32602 });
    return s;
  }

  async setMode({ sessionId, modeId }) {
    const s = this.session(sessionId);
    if (!MODES.some((m) => m.id === modeId)) throw Object.assign(new Error(`unknown mode ${modeId}`), { code: -32602 });
    s.mode = modeId;
    return {};
  }

  async setModel({ sessionId, modelId }) {
    const s = this.session(sessionId);
    if (!this.modelCache.some((m) => m.id === modelId)) throw Object.assign(new Error(`unknown model ${modelId}`), { code: -32602 });
    const blocked = this.provider.allowsModel?.({ model: this.info(modelId), env: process.env, settings: this.settings.resolved() });
    if (blocked) throw Object.assign(new Error(blocked), { code: -32602 });
    s.model = modelId;
    this.reportUsage(s, this.info(modelId));
    if (!(this.info(modelId).efforts ?? []).includes(s.effort)) s.effort = null;
    return {};
  }

  async setConfigOption({ sessionId, configId, value }) {
    const s = this.session(sessionId);
    if (configId === 'mode') await this.setMode({ sessionId, modeId: value });
    else if (configId === 'model') await this.setModel({ sessionId, modelId: value });
    else if (configId === 'reasoning_effort') s.effort = value === 'default' ? null : value;
    else if ((this.provider.settings ?? []).some((m) => m.id === configId)) {
      if (!this.settings.set(configId, value)) throw Object.assign(new Error(`invalid value ${value} for ${configId}`), { code: -32602 });
    } else throw Object.assign(new Error(`unknown config option ${configId}`), { code: -32602 });
    return { configOptions: this.configOptions(s) };
  }

  shutdown() {
    for (const s of this.sessions.values()) {
      s.abort?.abort();
      s.mcp?.close();
    }
  }

  // ---- notifications ------------------------------------------------------------------------------------

  update(sessionId, update) { this.rpc.notify('session/update', { sessionId, update }); }

  text(sessionId, kind, text) {
    this.update(sessionId, { sessionUpdate: kind, content: { type: 'text', text } });
  }

  kindOf(s, name) {
    return toolDef(name)?.kind ?? 'other';
  }

  // ---- the agent loop -----------------------------------------------------------------------------------

  // Prompts on one session run strictly one at a time. A new prompt cancels the running one and waits for it to
  // unwind before touching the history; if yet another arrives meanwhile, this one is dropped as superseded.
  async prompt({ sessionId, prompt }) {
    const s = this.session(sessionId);
    await this.requireAuth();
    const gen = (s.gen = (s.gen ?? 0) + 1);
    const previous = s.running;
    s.abort?.abort();
    const run = (async () => {
      await previous?.catch(() => {});
      if (gen !== s.gen) return { stopReason: 'cancelled' };
      return this.runPrompt(s, prompt);
    })();
    s.running = run;
    try {
      return await run;
    } finally {
      if (s.running === run) s.running = null;
      this.persist(s);
    }
  }

  persist(s) {
    if (!s.title) {
      const first = s.messages.find((m) => m.role === 'user');
      if (first) {
        s.title = titleFrom(contentText(first.content));
        this.update(s.id, { sessionUpdate: 'session_info_update', title: s.title, updatedAt: new Date().toISOString() });
      }
    }
    if (!s.noSave) this.store.save(s);
  }

  async runPrompt(s, prompt) {
    const sessionId = s.id;
    const abort = (s.abort = new AbortController());
    const model = this.info(s.model);
    const content = promptToContent(prompt, { vision: model.vision === true });

    const command = /^\/(clear|compact|status|forget)\b(.*)$/s.exec(contentText(content).trim());
    if (command) {
      try { return await this.runCommand(s, command[1], abort.signal, command[2].trim()); }
      finally { if (s.abort === abort) s.abort = null; }
    }
    // Privacy floor: never send to a model it disallows, even if it was chosen before the floor was raised.
    const refused = this.provider.allowsModel?.({ model, env: process.env, settings: this.settings.resolved() });
    if (refused) {
      this.text(sessionId, 'agent_message_chunk', `${refused}. Pick a model that qualifies, or change the setting.`);
      return { stopReason: 'end_turn' };
    }
    const redactedBefore = s.redactor.total;
    s.messages.push({ role: 'user', content: s.redactor.redactContent(content) });
    this.noteRedactions(s, redactedBefore);

    try {
      const limit = this.config.maxToolRounds;
      for (let i = 0; ; i++) {
        if (i > 0 && i % limit === 0 && !(await this.allowMoreRounds(s, i, limit))) break;
        s.messages[0].content = systemPrompt(s.cwd, s.mode);
        this.trimHistory(s, model);
        const defs = this.activeTools(s, model);
        const thinking = new ThoughtBuffer((t) => this.text(sessionId, 'agent_thought_chunk', t));
        const extra = this.provider.requestExtras({ effort: s.effort, env: process.env, info: model, settings: this.settings.resolved() });
        if (this.config.maxOutputTokens) extra.max_tokens = Math.min(this.config.maxOutputTokens, model.maxOut ?? Infinity);
        this.withTicketLimit(extra, model);
        const tickets = this.ticketMode();

        let turn;
        let shown = ''; // text already streamed to the IDE, kept across retries
        try {
          for (let attempt = 0; ; attempt++) {
            const messages = shown
              ? [...s.messages, { role: 'assistant', content: shown }, { role: 'user', content: 'Your previous reply was cut off. Continue exactly where it stopped, without repeating anything.' }]
              : s.messages;
            try {
              turn = await this.llm.chat({
                model: s.model, messages, tools: defs.length ? openAiTools(defs) : undefined, signal: abort.signal, extra,
                stream: model.streaming !== false, tickets,
                onText: (t) => { thinking.end(); shown += t; this.text(sessionId, 'agent_message_chunk', t); },
                onThought: (t) => thinking.add(t),
                onRetry: ({ reason, waitMs, attempt: n }) => this.text(sessionId, 'agent_thought_chunk', `${this.provider.title}: ${reason}; retrying in ${Math.ceil(waitMs / 1000)}s (attempt ${n}/3)…\n`),
              });
              break;
            } catch (e) {
              if (!e.midStream || abort.signal.aborted || attempt >= 3) throw e;
              this.log(`stream failed (${e.message}); retry ${attempt + 1}/3`);
              await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
            }
          }
        } finally {
          thinking.end();
        }
        turn.content = shown || turn.content;
        this.noteRoute(s, model, turn.headers);
        this.reportUsage(s, model, turn.usage, turn.content);

        // A reply cut off by the output limit has unusable tool arguments: run nothing and ask for smaller steps.
        if (turn.finishReason === 'length' && turn.toolCalls.length) {
          s.messages.push({ role: 'assistant', content: turn.content || null });
          s.messages.push({ role: 'user', content: 'Your last reply hit the output length limit and its tool call was cut off, so nothing was run. Retry in smaller steps (for example a targeted edit_file, or several smaller writes).' });
          continue;
        }

        const msg = { role: 'assistant', content: turn.content || null };
        if (turn.toolCalls.length) {
          msg.tool_calls = turn.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } }));
        }
        s.messages.push(msg);

        if (!turn.toolCalls.length) {
          return { stopReason: turn.finishReason === 'length' ? 'max_tokens' : 'end_turn' };
        }
        const answered = new Set();
        try {
          for (const call of turn.toolCalls) {
            if (abort.signal.aborted) return { stopReason: 'cancelled' };
            const before = s.redactor.total;
            const result = await this.runTool(s, call, abort.signal);
            s.messages.push({ role: 'tool', tool_call_id: call.id, content: s.redactor.redact(result) });
            this.noteRedactions(s, before);
            answered.add(call.id);
          }
        } finally {
          // Every tool_call needs a tool message or the next request is rejected; cancellation can skip some.
          for (const c of turn.toolCalls) {
            if (!answered.has(c.id)) s.messages.push({ role: 'tool', tool_call_id: c.id, content: 'Cancelled by the user before this ran.' });
          }
        }
      }
      this.text(sessionId, 'agent_message_chunk', '\n\n_Paused after reaching the tool-call limit for one turn. Send "continue" to resume._');
      return { stopReason: 'max_turn_requests' };
    } catch (e) {
      if (e.name === 'AbortError' || abort.signal.aborted) return { stopReason: 'cancelled' };
      if (e instanceof LlmError) {
        this.text(sessionId, 'agent_message_chunk', `\n\n**${this.provider.title} error:** ${scrub(e.message, this.config.knownSecrets?.() ?? [])}`);
        return { stopReason: 'end_turn' };
      }
      throw e;
    } finally {
      if (s.abort === abort) s.abort = null;
    }
  }

  // Slash commands advertised through available_commands_update.
  async runCommand(s, name, signal, args = '') {
    const say = (t) => this.text(s.id, 'agent_message_chunk', t);
    if (name === 'forget') {
      const all = args === 'all';
      if (all) this.store.deleteAll(); else this.store.delete(s.id);
      s.messages = [s.messages[0]];
      s.title = null;
      s.noSave = true;
      s.redactor = new Redactor({ enabled: this.config.redactSecrets !== false, known: this.config.knownSecrets?.() ?? [] });
      this.reportUsage(s, this.info(s.model));
      say(all ? 'Deleted every saved chat and cleared this one. Nothing more from this chat will be saved.' : 'Deleted this chat from disk and cleared it. Nothing more from this chat will be saved.');
      return { stopReason: 'end_turn' };
    }
    if (name === 'clear') {
      s.messages = [s.messages[0]];
      s.title = null;
      this.reportUsage(s, this.info(s.model));
      say('Conversation cleared.');
      return { stopReason: 'end_turn' };
    }
    if (name === 'status') {
      say(this.statusText(s));
      return { stopReason: 'end_turn' };
    }
    const history = s.messages.slice(1);
    if (history.length < 2) { say('Nothing to compact yet.'); return { stopReason: 'end_turn' }; }
    try {
      const summary = await this.llm.chat({
        model: s.model, signal, tickets: this.ticketMode(),
        extra: this.withTicketLimit(this.provider.requestExtras({ effort: null, env: process.env, info: this.info(s.model), settings: this.settings.resolved() }), this.info(s.model)),
        messages: [
          { role: 'system', content: 'Summarize this conversation so work can continue from the summary alone: the goal, key facts, decisions, files changed or read, and open tasks. Be concise but complete.' },
          { role: 'user', content: JSON.stringify(history.map((m) => ({ role: m.role, content: contentText(m.content), ...(m.tool_calls ? { tool_calls: m.tool_calls.map((c) => c.function.name) } : {}) }))).slice(0, this.config.compactInputChars ?? 300000) },
        ],
      });
      s.messages = [s.messages[0],
        { role: 'user', content: `Summary of the conversation so far:\n${summary.content}` },
        { role: 'assistant', content: 'Understood. I will continue from that summary.' }];
      this.reportUsage(s, this.info(s.model));
      say(`Compacted ${history.length} messages into a summary.`);
    } catch (e) {
      if (e.name === 'AbortError' || signal.aborted) return { stopReason: 'cancelled' };
      say(`Could not compact: ${e.message}`);
    }
    return { stopReason: 'end_turn' };
  }

  // Called each time a turn has used another `limit` model rounds. `onToolLimit` decides what happens next:
  // 'ask' (a native prompt; Bypass mode just continues), 'continue', or 'stop'. A hard ceiling stops runaway loops.
  async allowMoreRounds(s, rounds, limit) {
    const policy = this.config.onToolLimit;
    if (policy === 'stop' || rounds >= limit * 10) return false;
    if (policy === 'continue' || s.mode === 'bypassPermissions') return true;
    try {
      const r = await this.rpc.request('session/request_permission', {
        sessionId: s.id,
        toolCall: { toolCallId: `limit-${randomUUID()}`, title: `Used ${rounds} tool rounds this turn. Keep going?`, kind: 'other', status: 'pending' },
        options: [
          { optionId: 'allow_once', name: `Continue (${limit} more)`, kind: 'allow_once' },
          { optionId: 'reject_once', name: 'Stop here', kind: 'reject_once' },
        ],
      });
      return r.outcome?.outcome === 'selected' && r.outcome.optionId === 'allow_once';
    } catch (e) {
      this.log('continue prompt failed:', e.message);
      return false;
    }
  }

  activeTools(s, model) {
    if (model.tools === false) {
      if (!s.notedNoTools.has(model.id)) {
        s.notedNoTools.add(model.id);
        this.text(s.id, 'agent_message_chunk', `_${model.id} does not support tool calling, so it can only chat: no file access or commands._\n\n`);
      }
      return [];
    }
    if (s.mode === 'plan') return TOOL_DEFS.filter((t) => READ_ONLY_KINDS.has(t.kind)); // MCP tools are never read-only
    return [...TOOL_DEFS, ...(s.mcp?.tools ?? [])];
  }

  // ---- tools & approval ---------------------------------------------------------------------------------

  uniqueToolId(id) {
    let out = id;
    for (let n = 2; this.usedToolIds.has(out); n++) out = `${id}-${n}`;
    this.usedToolIds.add(out);
    return out;
  }

  needsApproval(s, prep) {
    if (s.mode === 'bypassPermissions') return false;
    if (prep.sensitive) return true; // credential-like files ask every time, never remembered
    // Anything touching paths outside the project asks, even reads, so secrets elsewhere on disk aren't sent to the model silently.
    if (!prep.outside) {
      if (READ_ONLY_KINDS.has(prep.kind)) return false;
      if (s.mode === 'acceptEdits' && prep.kind === 'edit') return false;
    }
    return !s.allowed.has(prep.approvalKey);
  }

  // MCP tools run in someone else's server, so they always ask (except in Bypass) and "Always allow" is per server.
  prepareMcp(s, def, args) {
    return {
      kind: 'other', title: `${def.mcp.server}: ${def.mcp.tool}`, approvalKey: `mcp:${def.mcp.server}`, approvalLabel: def.mcp.server,
      execute: async () => ({ output: await s.mcp.call(def, args) }),
    };
  }

  async runTool(s, call, signal) {
    const toolCallId = this.uniqueToolId(call.id);
    const fail = (message, extra = {}) => {
      this.update(s.id, { sessionUpdate: 'tool_call_update', toolCallId, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: message } }], ...extra });
      return `Error: ${message}`;
    };

    let args;
    try { args = call.arguments ? JSON.parse(call.arguments) : {}; }
    catch { return 'Error: tool arguments were not valid JSON. Retry with valid JSON.'; }

    // Secrets the model only ever saw as placeholders are put back before the tool runs. A placeholder this session
    // can't resolve (from a reloaded chat) must never be written anywhere, so the call is refused instead.
    args = s.redactor.restoreDeep(args);
    if (Redactor.hasPlaceholder(args)) {
      this.update(s.id, { sessionUpdate: 'tool_call', toolCallId, title: call.name, kind: toolDef(call.name)?.kind ?? 'other', status: 'pending' });
      return fail('the arguments contain a [REDACTED:...] placeholder that this chat cannot resolve. Ask the user for the real value instead of using the placeholder.');
    }

    const def = toolDef(call.name) ?? s.mcp?.find(call.name);
    if (!def) {
      this.update(s.id, { sessionUpdate: 'tool_call', toolCallId, title: call.name, kind: 'other', status: 'pending', rawInput: args });
      return fail(`unknown tool ${call.name}`);
    }
    if (s.mode === 'plan' && !READ_ONLY_KINDS.has(def.kind)) {
      this.update(s.id, { sessionUpdate: 'tool_call', toolCallId, title: call.name, kind: def.kind, status: 'pending', rawInput: args });
      return fail('Plan mode is read-only. Present the plan instead of making changes.');
    }

    let prep;
    try {
      prep = def.mcp ? this.prepareMcp(s, def, args) : await s.tools.prepare(call.name, args);
    } catch (e) {
      this.update(s.id, { sessionUpdate: 'tool_call', toolCallId, title: call.name, kind: def.kind, status: 'pending', rawInput: args });
      return fail(e.message);
    }

    const diffContent = prep.diff ? [{ type: 'diff', path: prep.diff.path, oldText: prep.diff.oldText, newText: prep.diff.newText }] : undefined;
    this.update(s.id, {
      sessionUpdate: 'tool_call', toolCallId, title: prep.title, kind: prep.kind, status: 'pending', rawInput: args,
      ...(prep.locations ? { locations: prep.locations } : {}),
      ...(diffContent ? { content: diffContent } : {}),
    });

    if (this.needsApproval(s, prep)) {
      const decision = await this.askPermission(s, toolCallId, prep, args, diffContent);
      if (decision === 'cancelled') throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
      if (decision === 'reject') {
        this.update(s.id, { sessionUpdate: 'tool_call_update', toolCallId, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'Denied by the user.' } }] });
        return 'The user denied this action. Do not retry it; ask how to proceed.';
      }
      if (decision === 'always') s.allowed.add(prep.approvalKey);
    }

    this.update(s.id, { sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress' });
    try {
      const r = await prep.execute(signal, {
        // Embedding the terminal lets the IDE show live command output.
        onTerminal: (terminalId) => this.update(s.id, { sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress', content: [{ type: 'terminal', terminalId }] }),
        onPlan: (entries) => this.update(s.id, { sessionUpdate: 'plan', entries }),
      });
      const content = diffContent
        ? diffContent
        : r.terminal || call.name === 'read_file' ? undefined : [{ type: 'content', content: { type: 'text', text: r.output } }];
      this.update(s.id, { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', rawOutput: r.output, ...(content ? { content } : {}) });
      return r.output;
    } catch (e) {
      if (e.name === 'AbortError' || signal.aborted) {
        this.update(s.id, { sessionUpdate: 'tool_call_update', toolCallId, status: 'failed' });
        throw e;
      }
      return fail(e.message);
    }
  }

  // Uses ACP's session/request_permission, which the IDE renders as its native approval prompt in AI Chat.
  async askPermission(s, toolCallId, prep, args, diffContent) {
    const alwaysName = prep.approvalLabel ? `Always allow ${prep.approvalLabel}` : 'Always allow';
    const options = [
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
      ...(prep.sensitive ? [] : [{ optionId: 'allow_always', name: alwaysName, kind: 'allow_always' }]),
      { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
    ];
    try {
      const r = await this.rpc.request('session/request_permission', {
        sessionId: s.id,
        toolCall: {
          toolCallId, title: prep.title, kind: prep.kind, status: 'pending', rawInput: args,
          ...(prep.locations ? { locations: prep.locations } : {}),
          ...(diffContent ? { content: diffContent } : {}),
        },
        options,
      });
      if (r.outcome?.outcome === 'cancelled') return 'cancelled';
      if (r.outcome?.outcome !== 'selected') return 'reject';
      return { allow_once: 'once', allow_always: 'always' }[r.outcome.optionId] ?? 'reject';
    } catch (e) {
      this.log('permission request failed:', e.message);
      return 'reject';
    }
  }

  // ---- context ------------------------------------------------------------------------------------------

  historyChars(s) {
    return s.messages.reduce((n, m) => n + contentLength(m.content) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0);
  }

  // Context meter in AI Chat (ACP usage_update). Uses the provider's token counts when it sends them,
  // otherwise estimates from history size (~4 chars per token). Skipped when the window size is unknown.
  // The cumulative session cost is an estimate from list prices (the serving provider's, when known).
  reportUsage(s, model, usage, reply = '') {
    const reported = usage?.prompt_tokens != null ? usage.prompt_tokens + (usage.completion_tokens ?? 0) : null;
    if (reported != null) {
      const price = (s.route && model.routes?.[s.route.provider]?.pricing) || model.pricing;
      if (price?.in != null) s.costUsd = (s.costUsd ?? 0) + ((usage.prompt_tokens * price.in) + ((usage.completion_tokens ?? 0) * (price.out ?? price.in))) / 1e6;
    }
    if (!model.context) return;
    const used = Math.min(reported ?? Math.ceil((this.historyChars(s) + reply.length) / 4), model.context);
    s.lastUsage = { used, size: model.context };
    this.update(s.id, {
      sessionUpdate: 'usage_update', size: model.context, used,
      ...(s.costUsd > 0 ? { cost: { amount: Math.round(s.costUsd * 1e6) / 1e6, currency: 'USD' } } : {}),
    });
  }

  // Remembers which route served the reply and mentions it when it matters: the first reply of a session,
  // a different provider than last time, or a fallback. Also tracks the account balance where the provider reports it.
  noteRoute(s, model, headers) {
    if (!headers) return;
    s.balance = this.provider.balance?.(headers) ?? s.balance;
    const route = this.provider.routeInfo?.(headers, model);
    if (!route) return;
    const previous = s.route;
    s.route = route;
    if (!previous || previous.provider !== route.provider || route.fallback) {
      this.text(s.id, 'agent_message_chunk', `\n\n_Routed via ${route.label}${route.fallback ? ' after a fallback' : ''}._\n\n`);
    }
  }

  // Tell the user when credentials were swapped for placeholders, so the privacy protection is visible.
  noteRedactions(s, before) {
    const added = s.redactor.total - before;
    if (added > 0) this.text(s.id, 'agent_thought_chunk', `Kept ${added} secret${added === 1 ? '' : 's'} out of the request (${s.redactor.summary()}); placeholders are swapped back when the model uses them in a tool call.`);
  }

  statusText(s) {
    const model = this.info(s.model);
    const lines = [`**Model:** ${model.name}`];
    if (this.ticketMode()) lines.push('**Requests:** private tickets (your key is never sent with your prompts)');
    if (s.route) lines.push(`**Last route:** ${s.route.label}${s.route.routing ? `, ${s.route.routing} routing` : ''}${s.route.fallback ? ', served by a fallback' : ''}`);
    if (s.lastUsage) lines.push(`**Context:** ${s.lastUsage.used.toLocaleString('en-US')} of ${s.lastUsage.size.toLocaleString('en-US')} tokens`);
    if (s.costUsd > 0) lines.push(`**Session cost:** about $${s.costUsd < 0.01 ? s.costUsd.toFixed(6) : s.costUsd.toFixed(2)} (list prices)`);
    if (s.balance) lines.push(`**Balance:** ${[s.balance.usd && `$${s.balance.usd}`, s.balance.diem && `${s.balance.diem} DIEM`].filter(Boolean).join(' / ')}`);
    if (s.redactor.total) lines.push(`**Secrets kept out of requests:** ${s.redactor.summary()}`);
    if (s.noSave) lines.push('**History:** not saved (forgotten)');
    const chosen = Object.entries(this.settings.resolved()).map(([k, v]) => `${k}=${v}`);
    if (chosen.length) lines.push(`**Settings:** ${chosen.join(', ')}`);
    return lines.join('\n');
  }

  // Keep the request within a rough size budget by eliding the oldest tool outputs.
  trimHistory(s, model) {
    const budget = model.context ? Math.min(600000, Math.max(100000, Math.floor(model.context * 2))) : DEFAULT_HISTORY_CHARS;
    let total = this.historyChars(s);
    for (const m of s.messages) {
      if (total <= budget) return;
      if (m.role === 'tool' && m.content.length > 500) {
        const elided = '[older tool output elided to save context]';
        total -= m.content.length - elided.length;
        m.content = elided;
      }
    }
  }
}
