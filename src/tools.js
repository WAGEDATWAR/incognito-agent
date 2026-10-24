import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { killTree } from './proc.js';
import { classifyPath } from './sensitive.js';

const MAX_OUT = 30000;
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const clip = (s) => (s.length > MAX_OUT ? s.slice(0, MAX_OUT) + `\n…[truncated ${s.length - MAX_OUT} chars]` : s);
const SEARCH_TIMEOUT_MS = 10000;
const PATH_TOOLS = new Set(['read_file', 'list_dir', 'search_files', 'write_file', 'edit_file']);

// `kind` follows ACP's ToolKind so the IDE picks the right icon and approval behavior.
export const TOOL_DEFS = [
  { name: 'read_file', kind: 'read', description: 'Read a text file. Optional 1-based line and limit.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, line: { type: 'integer' }, limit: { type: 'integer' } }, required: ['path'] } },
  { name: 'list_dir', kind: 'read', description: 'List entries of a directory (directories end with /).',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'search_files', kind: 'search', description: 'Regex search file contents under a directory (skips build/VCS folders). Optional glob like "*.js".',
    parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' }, case_sensitive: { type: 'boolean' } }, required: ['pattern'] } },
  { name: 'write_file', kind: 'edit', description: 'Create or overwrite a file with full content.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'edit_file', kind: 'edit', description: 'Replace one exact occurrence of old_string with new_string in a file. old_string must be unique unless replace_all is true.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['path', 'old_string', 'new_string'] } },
  { name: 'update_plan', kind: 'think', description: 'Show the user a task checklist for multi-step work. Send the full list each time; mark exactly one item in_progress while working.',
    parameters: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { content: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } }, required: ['content', 'status'] } } }, required: ['items'] } },
  { name: 'run_command', kind: 'execute', description: 'Run a shell command in the project directory and return its output.',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
];

export const READ_ONLY_KINDS = new Set(['read', 'search', 'think']);
export const toolDef = (name) => TOOL_DEFS.find((t) => t.name === name);
export const openAiTools = (defs = TOOL_DEFS) => defs.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));


/**
 * Prepares and executes tools for one session, going through the IDE (client) when it offers fs/terminal.
 * prepare() does the read-only work up front (validation, diff preview) so approval can show the real change.
 */
export class ToolRunner {
  constructor({ rpc, sessionId, cwd, caps, log }) {
    Object.assign(this, { rpc, sessionId, cwd, caps, log });
  }

  resolve(p) {
    if (typeof p !== 'string' || !p) throw new Error('path is required');
    return path.isAbsolute(p) ? path.normalize(p) : path.resolve(this.cwd, p);
  }

  display(abs) {
    const rel = path.relative(this.cwd, abs);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : abs;
  }

  async readText(abs, line, limit) {
    if (this.caps.fs?.readTextFile) {
      const r = await this.rpc.request('fs/read_text_file', { sessionId: this.sessionId, path: abs, ...(line ? { line } : {}), ...(limit ? { limit } : {}) });
      return r.content;
    }
    const text = await fs.readFile(abs, 'utf8');
    if (!line && !limit) return text;
    const start = (line ?? 1) - 1;
    return text.split('\n').slice(start, limit ? start + limit : undefined).join('\n');
  }

  async writeText(abs, content) {
    if (this.caps.fs?.writeTextFile) {
      await this.rpc.request('fs/write_text_file', { sessionId: this.sessionId, path: abs, content });
    } else {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, 'utf8');
    }
  }

  inside(abs) {
    const rel = path.relative(this.cwd, abs);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
  }

  /**
   * Returns { title, kind, locations?, diff?, approvalKey, outside?, execute(signal, hooks) }.
   * `execute` resolves to { output, terminal? }; throws on failure. `prepare` throws if the call is invalid.
   * Calls that touch paths outside the project are flagged so approval can treat them separately.
   */
  async prepare(name, args) {
    // Decide before touching the file: this agent's own credential files are off limits, even to read.
    let target = null;
    if (PATH_TOOLS.has(name)) { try { target = this.resolve(args.path || '.'); } catch { /* build() reports the bad path */ } }
    const sensitivity = target ? classifyPath(target) : null;
    if (sensitivity === 'blocked') throw new Error(`${this.display(target)} is blocked: it holds this agent's saved credentials`);

    let prep = await this.build(name, args);
    const abs = prep.locations?.[0]?.path;
    if (abs && !this.inside(abs)) {
      prep = { ...prep, outside: true, approvalKey: `outside:${prep.kind}`, approvalLabel: undefined, title: `${prep.title} (outside project)` };
    }
    // Credential-like files (.env, keys, ...) ask every time, whatever the mode, and are never "always allowed".
    if (sensitivity === 'sensitive') {
      prep = { ...prep, sensitive: true, approvalKey: `sensitive:${target}`, approvalLabel: undefined, title: `${prep.title} (sensitive file)` };
    }
    return prep;
  }

  async build(name, args) {
    const def = toolDef(name);
    if (!def) throw new Error(`unknown tool: ${name}`);
    const base = { kind: def.kind, approvalKey: def.kind };
    switch (name) {
      case 'read_file': {
        const abs = this.resolve(args.path);
        return { ...base, title: `Read ${this.display(abs)}`, locations: [{ path: abs, line: args.line ?? 1 }],
          execute: async () => ({ output: clip(await this.readText(abs, args.line, args.limit)) }) };
      }
      case 'list_dir': {
        const abs = this.resolve(args.path);
        return { ...base, title: `List ${this.display(abs)}`, locations: [{ path: abs }],
          execute: async () => {
            const ents = await fs.readdir(abs, { withFileTypes: true });
            return { output: ents.map((e) => e.name + (e.isDirectory() ? '/' : '')).sort().join('\n') || '(empty)' };
          } };
      }
      case 'search_files': {
        const abs = this.resolve(args.path || '.');
        if (typeof args.pattern !== 'string' || !args.pattern) throw new Error('pattern is required');
        new RegExp(args.pattern); // reject an invalid pattern up front, before approval and before the worker starts
        return { ...base, title: `Search "${args.pattern}" in ${this.display(abs)}`, locations: [{ path: abs }],
          execute: async (signal) => ({ output: await this.search(abs, args, signal) }) };
      }
      case 'write_file': {
        const abs = this.resolve(args.path);
        let old = null;
        try { old = await this.readText(abs); } catch { /* new file */ }
        const next = args.content ?? '';
        return { ...base, title: `${old === null ? 'Create' : 'Write'} ${this.display(abs)}`, locations: [{ path: abs }],
          diff: { path: abs, oldText: old, newText: next },
          execute: async () => { await this.writeText(abs, next); return { output: `Wrote ${abs}` }; } };
      }
      case 'edit_file': {
        const abs = this.resolve(args.path);
        const old = await this.readText(abs);
        const a = args.old_string;
        if (!a) throw new Error('old_string must not be empty');
        const count = old.split(a).length - 1;
        if (count === 0) throw new Error('old_string not found in file');
        if (count > 1 && !args.replace_all) throw new Error(`old_string matches ${count} places; add context or set replace_all`);
        const next = args.replace_all ? old.split(a).join(args.new_string) : old.replace(a, () => args.new_string);
        return { ...base, title: `Edit ${this.display(abs)}`, locations: [{ path: abs }],
          diff: { path: abs, oldText: old, newText: next },
          execute: async () => { await this.writeText(abs, next); return { output: `Edited ${abs} (${args.replace_all ? count : 1} replacement)` }; } };
      }
      case 'update_plan': {
        const entries = (Array.isArray(args.items) ? args.items : []).map((i) => ({
          content: String(i.content ?? ''), priority: 'medium', status: ['pending', 'in_progress', 'completed'].includes(i.status) ? i.status : 'pending',
        })).filter((e) => e.content);
        if (!entries.length) throw new Error('items must be a non-empty list');
        return { ...base, title: 'Update plan', execute: async (signal, hooks) => { hooks?.onPlan?.(entries); return { output: 'Plan updated.' }; } };
      }
      case 'run_command': {
        if (!args.command) throw new Error('command is required');
        const first = args.command.trim().split(/\s+/)[0];
        return { ...base, title: `Run: ${args.command}`, approvalKey: `execute:${first}`, approvalLabel: first,
          execute: (signal, hooks) => this.exec(args.command, signal, hooks) };
      }
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }

  // The scan runs in a worker thread with a time limit, so a catastrophic regex can't freeze the agent.
  search(root, args, signal) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./search-worker.js', import.meta.url), {
        workerData: { root, cwd: this.cwd, pattern: args.pattern, caseSensitive: !!args.case_sensitive, glob: args.glob },
      });
      const done = (fn, value) => { clearTimeout(timer); worker.terminate(); fn(value); };
      const timer = setTimeout(() => done(resolve, `Search stopped after ${SEARCH_TIMEOUT_MS / 1000}s (pattern too expensive or too many files). Try a simpler pattern or a narrower path.`), SEARCH_TIMEOUT_MS);
      signal?.addEventListener('abort', () => done(reject, new DOMException('aborted', 'AbortError')), { once: true });
      worker.on('message', (out) => done(resolve, out));
      worker.on('error', (e) => done(reject, e));
    });
  }

  async exec(command, signal, hooks = {}) {
    if (!this.caps.terminal) {
      return new Promise((resolve) => {
        const p = spawn(command, { cwd: this.cwd, shell: true, detached: process.platform !== 'win32' });
        let out = '';
        const add = (d) => { out += d; };
        p.stdout.on('data', add);
        p.stderr.on('data', add);
        signal?.addEventListener('abort', () => killTree(p), { once: true });
        const timer = setTimeout(() => killTree(p), COMMAND_TIMEOUT_MS);
        p.on('close', (code) => { clearTimeout(timer); resolve({ output: clip(out) + `\n[exit ${code}]` }); });
        p.on('error', (e) => { clearTimeout(timer); resolve({ output: `spawn error: ${e.message}` }); });
      });
    }
    const isWin = process.platform === 'win32';
    const { terminalId } = await this.rpc.request('terminal/create', {
      sessionId: this.sessionId,
      command: isWin ? 'cmd.exe' : 'sh',
      args: isWin ? ['/c', command] : ['-c', command],
      cwd: this.cwd,
      outputByteLimit: 200000,
    });
    hooks.onTerminal?.(terminalId);
    const onAbort = () => this.rpc.request('terminal/kill', { sessionId: this.sessionId, terminalId }).catch(() => {});
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(onAbort, COMMAND_TIMEOUT_MS); // a hung or interactive command must not stall the turn forever
    try {
      const exit = await this.rpc.request('terminal/wait_for_exit', { sessionId: this.sessionId, terminalId });
      const out = await this.rpc.request('terminal/output', { sessionId: this.sessionId, terminalId });
      return { output: clip(out.output) + `\n[exit ${exit.exitCode ?? exit.signal}]`, terminal: true };
    } finally {
      clearTimeout(timer);
      // The IDE keeps showing the embedded output after release.
      this.rpc.request('terminal/release', { sessionId: this.sessionId, terminalId }).catch(() => {});
    }
  }
}
