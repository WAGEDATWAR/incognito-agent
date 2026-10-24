#!/usr/bin/env node
import { runAgent } from '../src/cli.js';
import { venice } from '../src/providers/venice.js';

await runAgent(venice);
