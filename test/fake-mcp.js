// Tiny MCP server over stdio for tests: tools "echo" and "boom".
import readline from 'node:readline';

const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const TOOLS = [
  { name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'boom', description: 'Always fails', inputSchema: { type: 'object', properties: {} } },
];

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return; // notifications
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
  else if (m.method === 'tools/list') send({ id: m.id, result: { tools: TOOLS } });
  else if (m.method === 'tools/call') {
    if (m.params.name === 'echo') send({ id: m.id, result: { content: [{ type: 'text', text: `echo:${m.params.arguments.text}` }] } });
    else send({ id: m.id, result: { isError: true, content: [{ type: 'text', text: 'it broke' }] } });
  } else send({ id: m.id, error: { code: -32601, message: 'unknown method' } });
});
