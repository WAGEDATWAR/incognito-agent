import fs from 'node:fs';

// Single source of truth for the version reported to clients and MCP servers: package.json.
export const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
