// Runs every suite in its own process, in order, and reports which one failed and what it printed.
// Usage: node test/run-all.js [suite-name ...]   (no names runs everything)
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SUITES = [
  'e2e', 'approval', 'toollimit', 'tools', 'serialize', 'features', 'sessions', 'mcp', 'routing', 'tickets',
  'privacy', 'icons', 'fixtures', 'venice', 'auth', 'dialog', 'proxy',
];

const dir = path.dirname(fileURLToPath(import.meta.url));
const wanted = process.argv.slice(2);
const run = wanted.length ? wanted : SUITES;
const failed = [];
const started = Date.now();

for (const name of run) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(dir, `${name}.js`)], { encoding: 'utf8', timeout: 5 * 60 * 1000 });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.status === 0) {
    console.log(`ok    ${name} (${seconds}s)`);
  } else {
    failed.push(name);
    console.log(`FAIL  ${name} (${seconds}s${r.error ? `, ${r.error.code ?? r.error.message}` : ''}${r.signal ? `, ${r.signal}` : ''})`);
    // The end of the output is where the assertion message is.
    for (const line of output.split('\n').slice(-30)) console.log(`      ${line}`);
  }
}

console.log(failed.length ? `\n${failed.length} of ${run.length} suites failed: ${failed.join(', ')}` : `\nall ${run.length} suites passed in ${((Date.now() - started) / 1000).toFixed(0)}s`);
process.exit(failed.length ? 1 : 0);
