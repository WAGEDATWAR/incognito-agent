#!/usr/bin/env node
// One package, two agents: `npx anonrouter-venice-acp anonrouter` or `npx anonrouter-venice-acp venice`.
// Registry entries pass the provider name as the first argument; `login` after it saves an API key from a terminal.
import { runAgent } from '../src/cli.js';
import { promptLine } from '../src/credentials.js';
import { anonrouter } from '../src/providers/anonrouter.js';
import { venice } from '../src/providers/venice.js';
import { VERSION } from '../src/version.js';

const providers = { anonrouter, venice };
const args = process.argv.slice(2);

if (args[0] === '--version' || args[0] === '-v') {
  console.log(VERSION);
  process.exit(0);
}

let name = args[0];
if (!providers[name]) {
  // `login` with no provider (a client that replaces our arguments for terminal auth): ask, if someone is there to answer.
  if (args.includes('login') && process.stdin.isTTY) {
    name = (await promptLine('Which provider? (anonrouter / venice): ')).toLowerCase();
    process.argv.splice(2, 0, name);
  }
  if (!providers[name]) {
    console.error(`Usage: anonrouter-venice-acp <${Object.keys(providers).join('|')}> [login]`);
    process.exit(2);
  }
}

process.argv.splice(2, 1); // runAgent only sees the arguments after the provider name
await runAgent(providers[name]);
