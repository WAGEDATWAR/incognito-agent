#!/usr/bin/env node
import { runAgent } from '../src/cli.js';
import { anonrouter } from '../src/providers/anonrouter.js';

await runAgent(anonrouter);
