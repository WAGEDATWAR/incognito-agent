#!/usr/bin/env node
// Local OpenAI-compatible shim so JetBrains AI Completion can use Anonrouter chat models (experimental).
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { ChatClient } from '../src/llm.js';
import { createProxy } from '../src/proxy.js';
import { loadApiKey } from '../src/credentials.js';
import { anonrouter } from '../src/providers/anonrouter.js';

const log = (...a) => console.error('[completion-proxy]', ...a);
const port = Number(process.env.ANONROUTER_PROXY_PORT || 11435);
const baseUrl = process.env.ANONROUTER_BASE_URL || anonrouter.baseUrl;
const key = () => loadApiKey(anonrouter);

if (!key()) {
  log('No Anonrouter key found. Set ANONROUTER_API_KEY or authenticate once in the IDE chat first.');
  process.exit(1);
}

let debugFile = null;
if (process.env.ANONROUTER_PROXY_DEBUG === '1') {
  const dir = path.join(os.homedir(), anonrouter.credentialsDir);
  fs.mkdirSync(dir, { recursive: true });
  debugFile = path.join(dir, 'proxy-debug.log');
  log('debug log:', debugFile);
}

// Re-read the key per request so it picks up a key saved after startup.
const llm = () => new ChatClient({ baseUrl, apiKey: key() ?? '', provider: anonrouter, log });
const server = createProxy({ llm, resolveKey: key, debugFile, log });
server.listen(port, '127.0.0.1', () => log(`listening on http://127.0.0.1:${port}/v1  ->  ${baseUrl}`));
