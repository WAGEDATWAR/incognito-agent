import { RpcPeer } from './rpc.js';
import { AcpAgent, MODES } from './agent.js';
import { loadApiKey, promptLine, saveApiKey } from './credentials.js';
import { hasGui, promptKeyDialog } from './dialog.js';
import { scrub } from './redact.js';

/** Shared entry point for every provider-specific bin script. */
export async function runAgent(provider) {
  const P = provider.envPrefix;
  const env = process.env;
  // Your own keys: always masked in logs and, with secret redaction on, in anything sent to a model.
  const knownSecrets = () => [loadApiKey(provider), env.ANONROUTER_API_KEY, env.VENICE_API_KEY].filter(Boolean);
  // stdout is the protocol channel; everything else goes to stderr, with credentials masked.
  const log = (...a) => process.stderr.write(`${scrub(`[${provider.id}-acp] ${a.map((x) => (x instanceof Error ? x.stack : typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`, knownSecrets())}\n`);

  // Running on a real terminal (stdin is a TTY) or with `login` means "save my key"; the IDE always uses a pipe.
  if (process.argv.slice(2).includes('login') || process.stdin.isTTY) {
    let code = 0;
    try {
      const key = await promptLine(`${provider.title} API key (paste, then Enter): `);
      if (!key) { console.error('No key entered.'); code = 1; }
      else console.log(`Saved to ${saveApiKey(provider, key)}. Return to the IDE and retry your message.`);
    } catch (e) {
      console.error('Login failed:', e.message);
      code = 1;
    }
    if (process.stdin.isTTY) await promptLine('Press Enter to close this window...');
    process.exit(code);
  }

  const days = Number(env[`${P}_SESSION_RETENTION_DAYS`]);
  const retentionDays = env[`${P}_SESSION_RETENTION_DAYS`] && Number.isFinite(days) && days >= 0 ? days : 30;

  // Initial operation mode; the user can change it in AI Chat.
  const mode = MODES.some((m) => m.id === env[`${P}_MODE`]) ? env[`${P}_MODE`] : 'default';

  const config = {
    baseUrl: env[`${P}_BASE_URL`] || provider.baseUrl,
    // Identity/billing origin for ticket issuance. A custom base URL serves both roles unless overridden.
    controlUrl: env[`${P}_CONTROL_URL`] || (env[`${P}_BASE_URL`] ? env[`${P}_BASE_URL`] : provider.controlUrl),
    model: env[`${P}_MODEL`] || provider.defaultModel,
    mode,
    // How many model rounds (each may call tools) one turn may use before `_ON_TOOL_LIMIT` applies.
    maxToolRounds: Math.max(1, Number(env[`${P}_MAX_TOOL_CALLS`]) || 40),
    onToolLimit: ['continue', 'stop'].includes(env[`${P}_ON_TOOL_LIMIT`]) ? env[`${P}_ON_TOOL_LIMIT`] : 'ask',
    configOptions: env[`${P}_CONFIG_OPTIONS`] !== 'off',
    saveSessions: env[`${P}_SAVE_SESSIONS`] !== 'off',
    // Chats older than this are deleted automatically (0 keeps them until the 50-chat limit pushes them out).
    sessionRetentionDays: retentionDays,
    redactSecrets: env.ACP_REDACT_SECRETS !== 'off' && env[`${P}_REDACT_SECRETS`] !== 'off',
    knownSecrets,
    hideNoTools: env[`${P}_HIDE_NO_TOOLS`] === '1',
    maxOutputTokens: Number(env[`${P}_MAX_OUTPUT_TOKENS`]) || undefined,
    streamIdleMs: Number(env.ACP_STREAM_IDLE_MS) || 120000, // a silent connection is retried after this long
    loadApiKey: () => loadApiKey(provider),
    saveApiKey: (key) => saveApiKey(provider, key),
    promptForKey: () => promptKeyDialog(provider.title),
    canShowDialog: hasGui,
    loginCommand: `npx anonrouter-venice-acp ${provider.id} login`,
  };

  const rpc = new RpcPeer(process.stdin, process.stdout, log);
  const agent = new AcpAgent({ rpc, provider, config, log });
  const quit = () => { agent.shutdown(); process.exit(0); };
  rpc.onClose = quit;
  process.on('SIGTERM', quit);
  process.on('SIGINT', quit);
  process.on('unhandledRejection', (e) => log('unhandledRejection', e));
}
