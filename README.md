# ACP agents for JetBrains: Anonrouter and Venice

[![CI](https://github.com/WAGEDATWAR/incognito-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/WAGEDATWAR/incognito-agent/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Unofficial, zero-dependency [Agent Client Protocol](https://agentclientprotocol.com) agents that run **Anonrouter** or **Venice** models inside JetBrains AI Chat, plus an experimental local proxy for AI Completion. Needs Node 20.3 or newer. Not affiliated with Anonrouter, Venice or JetBrains.

One npm package, `anonrouter-venice-acp`, provides both agents. Pick one by name:

| Agent | Command | Env prefix | Default base URL |
|---|---|---|---|
| Anonrouter | `npx anonrouter-venice-acp anonrouter` | `ANONROUTER_` | `https://api.anonrouter.ai/v1` |
| Venice | `npx anonrouter-venice-acp venice` | `VENICE_` | `https://api.venice.ai/api/v1` |

Each agent is also available as its own command (`anonrouter-acp`, `venice-acp`) once the package is installed. Both share one core (`src/`). Each provider is a small adapter in `src/providers/` (model list parsing, request extras, rate-limit handling), so adding another OpenAI-style provider is one file plus a line in the launcher.

## Install in IntelliJ

**From the ACP registry** (once listed): open AI Chat's agent list, choose Anonrouter or Venice, and install. The IDE launches the package with `npx`.

**Manually**, in `~/.jetbrains/acp.json` (AI Chat → ⋮ → **Add Custom Agent** opens it). `command` must be an absolute path; a bare `npx` or `node` is rejected. Find yours with `which npx` or, on Windows, `(Get-Command npx).Source`.

Using the published package:

```json
{
  "agent_servers": {
    "Anonrouter": {
      "command": "/absolute/path/to/npx",
      "args": ["-y", "anonrouter-venice-acp", "anonrouter"],
      "env": { "ANONROUTER_MODEL": "anthropic/claude-sonnet-5.5" }
    },
    "Venice": {
      "command": "/absolute/path/to/npx",
      "args": ["-y", "anonrouter-venice-acp", "venice"],
      "env": { "VENICE_MODEL": "zai-org-glm-5-2" }
    }
  }
}
```

On Windows the command is the `npx.cmd` next to `node.exe`, for example `C:\\Program Files\\nodejs\\npx.cmd`.

Or from a checkout of this repository (no publishing needed), pointing Node at the launcher:

```json
{
  "agent_servers": {
    "Anonrouter": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/this/repo/bin/anonrouter-acp.js"]
    }
  }
}
```

Then pick the agent in the AI Chat selector. The `env` blocks are optional. Restart the agent session after changing them.

## Using it in AI Chat

**Modes.** The mode selector in AI Chat controls approvals (named like JetBrains' Claude Agent modes):

| Mode | Behavior |
|---|---|
| **Manual** (default) | Asks before every file edit and shell command. Reads and searches never ask. |
| **Accept edits** | Edits go through; commands still ask. |
| **Plan** | Read-only. Write and command tools are not offered; the agent investigates and proposes a plan. |
| **Bypass permissions** | Never asks. |

**Approval prompts** use the standard ACP permission request, so they appear as the IDE's own approval prompt in AI Chat. An edit's prompt carries the full diff of the proposed change. The choices are **Allow once**, **Always allow** and **Deny**. "Always allow" lasts for the session: for edits it covers all edits; for commands it covers that command name only (e.g. `npm`, `git`). Cancelling a prompt cancels the turn.

**Model and reasoning.** The model picker lists the provider's models. For Venice, models that report reasoning-effort options also get a **Reasoning effort** menu, and models without tool calling are marked "(no tools)" and run as plain chat.

**Context meter.** After every model reply the agent sends an ACP `usage_update` (tokens used and the model's context window) for AI Chat's context indicator. It uses the provider's token counts when the stream includes them, otherwise an estimate of about 4 characters per token. It is skipped for models whose context window the provider doesn't report.

**Thinking.** Reasoning is sent as one thought update, so it shows in the IDE's own thought area. Inline `<think>…</think>` text from models is routed there too.

## Authentication

If no key is found, the agent shows a native password dialog the first time you chat (or press Authenticate) and saves the key to `~/.anonrouter-acp/credentials.json` or `~/.venice-acp/credentials.json`.

Lookup order: `<PREFIX>_API_KEY` environment variable, then the credentials file. To save a key by hand, run `npx anonrouter-venice-acp anonrouter login` (or `venice login`) in a terminal. On a machine with no display, such as a remote host, IDEs that support terminal sign-in are offered a "log in in a terminal" option that does the same. The saved key is protected by your operating system where possible (see Privacy and security).

## Platforms

| | Windows | macOS | Linux |
|---|---|---|---|
| Sign-in dialog | PowerShell password box | `osascript` dialog with hidden input | `zenity`, else `kdialog`, else `yad` (needs a display) |
| Saved key protection | DPAPI (your Windows account) | login Keychain through the `security` tool | desktop keyring through `secret-tool` when installed and running, else a file readable only by you |
| Tested | by hand, and in CI | the Keychain round trip in a separate CI job; the dialog itself is untested | command construction in CI; a real keyring round trip in a separate CI job |

Where no dialog can be shown (an SSH session, a remote development host, a machine with no display or no dialog program), the agent says so and points to the terminal: run `npx anonrouter-venice-acp anonrouter login` (or `venice login`) there, or set `ANONROUTER_API_KEY` / `VENICE_API_KEY`. IDEs that support terminal sign-in are offered it as an option in that case. In IntelliJ's remote development the agent runs on the backend host, so Node and the key belong on that machine. JetBrains does not support ACP agents under WSL.

## Environment variables

Set these in the agent's `env` block in `acp.json`. `<P>` is `ANONROUTER` or `VENICE`.

| Variable | Default | Options |
|---|---|---|
| `<P>_API_KEY` | unset (dialog prompts) | Your key. Takes priority over the saved file. |
| `<P>_MODEL` | Anonrouter: `gpt-4o`; Venice: `zai-org-glm-5-2` | Any model ID from the provider's `/models`. Switchable per session in the model picker. |
| `<P>_BASE_URL` | see table above | Any OpenAI-style base URL. |
| `<P>_MODE` | `default` | Initial mode: `default` (Manual), `acceptEdits`, `plan`, `bypassPermissions`. Changeable in AI Chat. |
| `<P>_MAX_TOOL_CALLS` | `40` | Model rounds (each may call tools) one turn may use before `<P>_ON_TOOL_LIMIT` applies. |
| `<P>_ON_TOOL_LIMIT` | `ask` | `ask`: native prompt "Keep going?" (Bypass mode just continues). `continue`: always continue, up to 10× the limit. `stop`: pause the turn; send "continue" to resume. |
| `<P>_MAX_OUTPUT_TOKENS` | unset | Cap on tokens per reply (never above the model's own maximum). Unset leaves the provider's default. |
| `<P>_HIDE_NO_TOOLS` | off | `1` hides models without tool calling from the model menu. They are otherwise listed as "(no tools)". |
| `<P>_SAVE_SESSIONS` | on | `off` stops saving chats and turns off resuming them. |
| `<P>_CONFIG_OPTIONS` | on | `off` hides the config-option menus and leaves only the older modes/models fields, in case your IDE version shows duplicates. |

Removed since the first version: `<P>_THINKING`, `<P>_APPROVAL` and `<P>_AUTO_APPROVE`. Use `<P>_MODE` (for example `bypassPermissions` instead of auto-approve). The initial mode is **Manual**.

Capabilities come from each provider's model list: tool calling, streaming (a model that doesn't stream gets a plain request), vision, reasoning efforts (Anonrouter models that allow it also offer `none`), and output and context limits. Venice's end-to-end encrypted `e2ee-*` models are hidden because they need client-side encryption this agent doesn't implement.

Anonrouter only (routing; see Anonrouter's provider-routing docs). The first three also have menus in AI Chat (Minimum privacy, Provider sort, Provider fallbacks), next to Request mode; a menu choice overrides the variable and is remembered in `~/.anonrouter-acp/settings.json`. Invalid values are ignored rather than sent.

| Variable | Default | Options |
|---|---|---|
| `ANONROUTER_MIN_PRIVACY` | unset | `anonymous`, `private`, `tee`, `e2ee`: the lowest privacy tier any provider may use. If no provider for a model qualifies, the request fails with a message saying so. |
| `ANONROUTER_SORT` | unset (privacy) | `privacy`, `price`, `latency`, `throughput`. |
| `ANONROUTER_ALLOW_FALLBACKS` | on | `0` makes a single attempt with no fallback provider. |
| `ANONROUTER_PROVIDER_ORDER` | unset | Comma-separated provider IDs to try first, in order. |
| `ANONROUTER_PROVIDER_ONLY` | unset | Comma-separated provider IDs; use only these. |
| `ANONROUTER_PROVIDER_IGNORE` | unset | Comma-separated provider IDs never to use. |
| `ANONROUTER_MAX_PRICE_INPUT`, `ANONROUTER_MAX_PRICE_OUTPUT` | unset | USD per million tokens; routes above either limit are skipped. |
| `ANONROUTER_MAX_ATTEMPTS` | unset (up to 3) | `1`, `2` or `3` providers tried per request. |
| `ANONROUTER_TICKETS` | off | `1` uses the private ticket flow by default (see below); the Request mode menu overrides it. |
| `ANONROUTER_CONTROL_URL` | `https://control.anonrouter.ai/v1` | Identity and billing origin used for ticket issuance and, in ticket mode, model listing. |
| `ANONROUTER_REQUIRE_PARAMETERS` | on | `0` lets routing pick providers that don't support every request parameter (such as tools). Left on, so the agent never lands on a route that can't use its tools. |

**Private tickets (optional).** By default requests are authorized with your API key (Anonrouter's compatibility mode). With **Request mode: Private tickets** (an AI Chat menu, or `ANONROUTER_TICKETS=1`), each model call first exchanges your key at Anonrouter's control origin for a single-use ticket, then sends your prompt to the relay with only that ticket. The relay that sees your prompt never sees your key or account, which is what Anonrouter calls the unlinkable flow. The menu choice overrides the variable. Things to know:

- Each model call mints its own ticket (they expire in about 30 seconds and work once); a lapsed one is replaced automatically.
- A ticket is bound to the model, reasoning effort, routing settings and an **output ceiling**. The agent always sets that ceiling (`<P>_MAX_OUTPUT_TOKENS`, default 16384, never above the model's limit). Anonrouter reserves the worst-case cost for that ceiling from your balance and refunds the unused part, so your balance must cover it for each call.
- Model listing goes to the control origin too (it can list more models than the standard endpoint).
- It costs one extra round trip per model call. `/status` shows when tickets are on.
- You can turn off compatibility mode on a key to make it ticket-only; a key like that fails in Standard mode with a hint to switch.
- `ANONROUTER_CONTROL_URL` overrides the control origin (default `https://control.anonrouter.ai/v1`; with a custom `ANONROUTER_BASE_URL` it defaults to that URL).

The model menu shows each model's privacy tier (for example `claude-sonnet-5.5 · anonymous`). The agent also mentions the serving provider and tier after the first reply of a session, whenever the provider changes, and after a fallback. Routing-related errors come with a hint on what to change.

Venice only:

| Variable | Default | Options |
|---|---|---|
| `VENICE_WEB_SEARCH` | `off` | `off`, `on`, `auto`. Also a **Web search** menu in AI Chat, which overrides this and is remembered in `~/.venice-acp/settings.json`. |
| `VENICE_SYSTEM_PROMPT` | off | `1` lets Venice prepend its own system prompt. Off by default so a coding agent only sees ours. |
| `VENICE_WEB_SCRAPING` | off | `1` lets Venice fetch URLs mentioned in your latest message. |
| `VENICE_WEB_CITATIONS` | off | `1` asks the model to cite sources when web search is on. |
| `VENICE_X_SEARCH` | off | `1` enables xAI's native web and X search on supporting models. |
| `VENICE_STRIP_THINKING` | off | `1` asks Venice to strip `<think>` blocks from replies. |

## What it does

- **Resumable chats.** Conversations are saved to `~/.anonrouter-acp/sessions/` (or `~/.venice-acp/sessions/`) and appear in AI Chat's history; loading one replays it and continues with the full context. The newest 50 are kept. The files contain whatever the chat contained, including quoted file contents.
- **MCP servers.** MCP servers configured in the IDE (stdio or HTTP) are connected per session and their tools are offered to the model. They always ask for approval (except in Bypass mode), with "Always allow" per server, and are not offered in Plan mode. A server that fails to start is reported in the chat, not fatal.
- **Images.** Pasted or attached images are sent to models that report vision support; other models get a note instead.
- **Slash commands.** `/clear` empties the context; `/compact` summarizes the conversation into a short summary to free up space.
- **Cost and status.** The context meter also carries an estimated cumulative session cost (token counts times the provider's list prices, using the serving provider's price when known). `/status` shows the model and its privacy tier, the last route, context use, the session cost, your Venice balance (from Venice's response headers), and any provider menu choices.
- **Task checklist.** The model can show a live task list in AI Chat (ACP plan updates).
- **Resilience.** A reply cut off by the output limit is retried in smaller steps instead of running half a tool call. A connection silent for 2 minutes is aborted and retried, and rate-limit waits are shown in the chat.

- Streams `/chat/completions`. HTTP 429 and 5xx are retried before the stream starts (Venice's `x-ratelimit-reset-requests` header sets the wait). If a stream fails partway, the agent retries up to 3 times and asks the model to continue where it stopped. Errors show the provider's own details.
- Tools: `read_file`, `list_dir`, `search_files` (regex, skips build and VCS folders), `write_file`, `edit_file`, `run_command`. File access goes through the IDE, so unsaved buffers and its change review work. Commands run in an embedded IDE terminal when the client offers it. `search_files` runs in a worker thread with a 10-second limit, and cancelling a command kills its whole process tree.
- The cancel button aborts the stream and kills running commands.
- Logs go to stderr.

## Experimental: Anonrouter AI Completion proxy

Anonrouter has no `/v1/completions` endpoint, so JetBrains' AI Completion can't use it directly. This local proxy turns completion requests into chat requests (best with a coding model such as `qwen/qwen-3-coder-480b-turbo`) and forwards everything else unchanged. Expect it to be slower and less accurate than a real fill-in-the-middle model.

1. Start it and leave it running:

```bash
npx --package anonrouter-venice-acp anonrouter-completion-proxy
```

2. Settings → Tools → AI Assistant → Providers & API Keys → AI Completion:
   - Provider: **OpenAI Compatible**
   - Base URL: `http://127.0.0.1:11435/v1`
   - API key: anything (the proxy uses your saved Anonrouter key)
   - Model: `qwen/qwen-3-coder-480b-turbo`. If the model isn't recognized, pick the Qwen-coder prompt schema manually.

| Variable | Default | Options |
|---|---|---|
| `ANONROUTER_PROXY_PORT` | `11435` | Any free port. Update the Base URL to match. |
| `ANONROUTER_PROXY_DEBUG` | off | `1` writes each request and result to `~/.anonrouter-acp/proxy-debug.log`. The log contains your code; delete it when done. |
| `ANONROUTER_BASE_URL` | `https://api.anonrouter.ai/v1` | Same as for the agent. |

The proxy needs a key at startup, so authenticate once in the IDE chat first (or set `ANONROUTER_API_KEY`). Set these in the shell before launching it.

For chat models in AI Assistant (Core features, Instant helpers), no proxy is needed: use the **OpenAI-compatible** provider with the provider's base URL.

## Privacy and security

The agents talk only to the provider you configure (plus the control server in Anonrouter's ticket mode, and any MCP servers you set up in the IDE). There is no telemetry and no analytics. What follows is what they add on top of that.

**Secret redaction (on by default).** Credentials found in text headed for the model are replaced with placeholders such as `[REDACTED:github-token:1]`: in your prompts, in file contents the model reads, in command output and in MCP results. It recognizes private key blocks, AWS, GitHub, OpenAI/Anthropic-style, Slack, Google, Stripe and npm keys, JWTs, bearer tokens, passwords in URLs, `PASSWORD=`-style assignments, and always your own Anonrouter and Venice keys. The chat tells you when something was kept out. When the model then uses a placeholder in a tool call, for example to write a config file that must keep the secret, the real value is swapped back in locally just before the tool runs. A placeholder this chat can't resolve (say, from a reloaded chat) is refused rather than written into a file. Saved chats hold placeholders only, never the secrets. Turn it off with `ACP_REDACT_SECRETS=off` or `<P>_REDACT_SECRETS=off`.

**Sensitive and blocked files.** Files that usually hold credentials (`.env*` except `.env.example`, `*.pem`/`*.key`, SSH keys, `.aws`, `.npmrc`, `credentials.json`, `acp.json` and similar) always ask before the model may read or change them, in every mode except Bypass. The prompt offers Allow once or Deny only, never "always allow", and what you allow is still redacted. Searches skip these files. This agent's own saved data (`~/.anonrouter-acp`, `~/.venice-acp`) is blocked outright, so the model can never read your key file or chat history. Paths outside the project also ask, even for reads.

**Your saved API key is protected.** On Windows it is encrypted with DPAPI, tied to your Windows account; on macOS it goes in your login Keychain; on Linux it goes in the desktop keyring through `secret-tool` when that is installed and running. A copied or backed-up `credentials.json` then holds no usable key. An older plaintext file is converted the first time it is read. Elsewhere, or if the keychain or keyring is unavailable (a locked Keychain, an SSH session), and with `ACP_KEY_STORAGE=file`, the key stays in a file readable only by you. On macOS the key reaches the `security` tool through its standard input (`security -i`), never as a command-line argument another process could see. Keys given by environment variable are used as they are. Keys are masked in logs and error messages.

**Chat history.** Saved chats are deleted after 30 days (`<P>_SESSION_RETENTION_DAYS`, `0` keeps them until the 50-chat limit), live in a folder only you can read, and hold redacted text. `/forget` deletes the current chat from disk and stops saving it; `/forget all` deletes every saved chat. `<P>_SAVE_SESSIONS=off` saves nothing.

**Privacy tiers.** Model menus show each model's privacy tier. Anonrouter's **Minimum privacy** menu (or `ANONROUTER_MIN_PRIVACY`) makes Anonrouter refuse routes below a tier, and **Private tickets** keep your key apart from your prompts. Venice has the same kind of floor: the **Minimum privacy** menu (or `VENICE_MIN_PRIVACY=private`) hides models that are not zero-retention and refuses to send to one chosen earlier.

**What this does not do.**
- Redaction is pattern-based. A secret with no recognizable shape that you never configured can get through, and ordinary code and prose reach the provider as normal.
- `run_command` runs as you and can read anything you can; commands still ask first in Manual and Accept edits modes. Bypass mode skips prompts, including for sensitive files, though redaction still applies.
- MCP servers receive their tool arguments with real values restored, and they are code you chose to run.
- The provider you pick sets what happens to your data after it arrives. Choose accordingly.

| Variable | Default | Options |
|---|---|---|
| `<P>_REDACT_SECRETS` / `ACP_REDACT_SECRETS` | on | `off` sends text unredacted. |
| `<P>_SESSION_RETENTION_DAYS` | `30` | Days to keep saved chats; `0` keeps them until pushed out by the 50-chat limit. |
| `ACP_KEY_STORAGE` | auto | `file` stores the key in a 0600 file even where OS protection exists. |
| `ACP_KEYCHAIN` | unset | macOS only: path of a specific `.keychain-db` file to use instead of the session's default keychain. Needed on a Mac with no default keychain in the session (a headless machine); the CI keychain job uses it. |
| `VENICE_MIN_PRIVACY` | unset | `private`: only zero-retention Venice models. The menu overrides it. |

## Test

`npm test` runs seventeen suites against fake providers and a fake IDE: the agent loop with a retried stream failure, modes and approvals (deny, always allow, cancel, plan, bypass, outside-project reads), the tool-call limit policy, every tool (reading, listing, searching with its limits, writing and editing with diff previews, unsaved editor buffers, IDE terminals, sensitivity flags, plan updates, killing a cancelled command's process tree), overlapping prompts, capability parsing, images, slash commands, stalls and retries, saved sessions, MCP over stdio and HTTP, routing settings, route notes and cost, private tickets (key and content on separate origins), secret redaction, sensitive-file rules, key protection, retention and `/forget`, the Venice privacy floor, icon and registry-draft rules, the model-list parsers against real entries captured from both providers (`test/fixtures`), the missing-key flow, the sign-in dialog on each platform, and the completion proxy.

Three more scripts are run on demand:

- `npm run test:package` packs the project and runs the tarball through npx, as the registry launches it.
- `npm run test:keyring` and `npm run test:keychain` round-trip a key through a real Linux keyring or macOS Keychain. They only run with `ACP_TEST_KEYRING=1` / `ACP_TEST_KEYCHAIN=1` on a machine that has one; the CI `keyring` and `keychain` jobs do that.
- `npm run test:live` talks to the real Anonrouter and Venice APIs (model list, a streamed reply with the cost meter, a tool call, a reasoning effort, Anonrouter's private tickets) using your keys, and spends a few cents. A provider without a key is skipped.

## Not yet verified

- **IDE rendering.** Confirmed by the author in IntelliJ IDEA 2026.2: permission prompts, the mode selector, the context meter and thought display render natively in AI Chat. JetBrains doesn't document this for custom agents, so other IDE versions are untested.
- **Key protection and redaction in practice.** DPAPI protection was tested by hand on Windows; the Linux keyring and the macOS Keychain are exercised by CI jobs rather than on machines of the author's. macOS dialogs and Linux dialogs have not been clicked through by anyone. Redaction patterns are tuned to avoid false positives but have not been run over a large real codebase, and how the IDE shows the "sensitive file" prompt is unconfirmed.
- **Provider support.** A model without tool-calling support will chat but can't edit files. Anonrouter's docs don't say which models support tools or streaming.

## License

[MIT](LICENSE). This project is unofficial and is not affiliated with Anonrouter, Venice or JetBrains; the names belong to their owners.
