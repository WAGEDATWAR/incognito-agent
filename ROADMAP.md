# Roadmap (final)

This is the complete plan from here to a public release and beyond. What has already been built and why lives in [docs/ROADMAP-ARCHIVE.md](docs/ROADMAP-ARCHIVE.md); the changelog records releases.

**Where things stand (v0.2.1, tagged locally).** Anonrouter and Venice agents with modes and native approvals, routing and privacy settings, private tickets, MCP, images, resumable chats, slash commands, secret redaction, sensitive-file rules, OS-protected key storage, retention and `/forget`. 17 test suites plus packaging, real-keyring, real-Keychain (new), and live-provider checks. CI green on Windows, macOS and Linux. Not yet published anywhere.

**How to read it**
- Sizes: **S** a few hours, **M** a day or two, **L** a week or more.
- `[decision]` needs your call before work starts. `[suggestion]` is my addition and may not be what you want; cut freely. `[plugin]` is configuration that is painful without a settings page; each has an interim form (file, chat command or AI Chat menu) so it is not blocked on the plugin.
- Within each section, items are in the order I would do them.

---

## 1. Before release

The gate for the first public listing. Nothing here is optional except where marked.

### Identity and distribution

**B1. Rebrand to Incognito: Privacy-first multi-agent ACP** (M) `[decision]`. Do this first: the npm name, repository name, registry ids, data folders and icons all follow from it, and they are hard to change after listing.
- Names: `incognito-acp`, `incognito-agents`, `acp-incognito` and `incognito-ai` were free on npm when checked. Pick one and reserve it by publishing early (see B4).
- "Incognito" is also Chrome's private-mode name: run a trademark and search check, avoid Chrome-like iconography, keep the descriptive subtitle and the "unofficial" notice.
- Registry ids and display names, for example `incognito-anonrouter` and `incognito-venice`, shown as "Incognito (Anonrouter)" and "Incognito (Venice)". Rename the GitHub repository only if it changes (the current one is already `incognito-agent`).
- Keep the `ANONROUTER_` and `VENICE_` variable prefixes; add a shared `INCOGNITO_` prefix for cross-provider settings (redaction, retention, network boundary). Accept the old names for one release.
- Move saved data from `~/.anonrouter-acp` and `~/.venice-acp` to one `~/.incognito-acp/` folder with a one-time migration, including the Keychain, keyring and DPAPI entries and the `sessions/` folder. The blocked-paths list in `src/sensitive.js` already includes `.incognito-acp`.
- Update the README title, package name and bins, launcher usage text, registry drafts, test expectations and the changelog.

**B2. Brand-mark permission or a neutral icon** (S) `[decision]`. The Anonrouter and Venice marks are their owners' trademarks. Either get a clear OK from both, or use a neutral Incognito mark for the listing and keep the provider names in text only. A neutral mark also removes any suggestion of endorsement. The icon pipeline and `test/icons.js` already handle either choice.

**B3. Registry submission** (S–M). Copy `registry/<id>/` into a fork of `agentclientprotocol/registry`, run its validator (`uv run --with jsonschema .github/workflows/build_registry.py`) and its auth check (`python3 .github/workflows/verify_agents.py --auth-check --agent <id>`), then open the pull request. Needs B1, B2 and B4 done first, because the pinned npm version must already exist. After the first merge the registry follows new npm versions on its own.

**B4. npm publishing and the release process** (M).
- Create the npm account with two-factor authentication, reserve the package name, and add `publishConfig` with public access.
- Publish from CI with provenance: a release workflow that runs on a version tag, runs every test, then `npm publish --provenance` using GitHub's trusted publishing (no long-lived npm token stored in the repository), and creates the GitHub release from the changelog entry.
- Branch protection on `main` (require the CI jobs), signed tags `[suggestion]`, and a software bill of materials attached to each release `[suggestion]` (small, because there are no runtime dependencies).
- First public version `[decision]`: `1.0.0` signals stability to strangers; `0.3.0` is more honest about how little has run on other people's machines. I lean to `0.3.0` for the first listing and `1.0.0` after B18 has been exercised by a few outside users.

**B5. Docs for strangers** (S–M). Rewrite the README around the three things a newcomer needs: install from the registry, paste your key, what it does with your data. Move the long reference (every variable, the proxy, the test notes) below that or into `docs/`. Add: a short "what is sent where" table; advice to use the sign-in dialog or the keychain rather than putting a key in `acp.json`'s `env` block (where it sits in plain text); a troubleshooting section (Node missing, key dialog not showing, models not listed, tool calls not working on a model); CONTRIBUTING and issue templates `[suggestion]`; screenshots of the mode menu, a diff approval and the context meter `[suggestion]`.

**B6. Repository settings** (S). Turn on private vulnerability reporting (so `SECURITY.md`'s link works), GitHub secret scanning with push protection, Dependabot alerts and security updates, and require CI before merging. Confirm the copyright line in `LICENSE` (it says "WAGEDATWAR"; use your legal name if you prefer).

**B7. Decide the completion proxy's fate** (S) `[decision]`. It works but depends on a model that can improvise fill-in-the-middle through chat, must be started by hand, and is Anonrouter-only. Options: ship it as a clearly experimental extra (current state); move it to its own small package so it never confuses the agent's listing; or drop it until the plugin can manage it. Whatever you choose, mark it experimental in the README.

### Security and correctness fixes from the final review

These are real gaps I found reading the code again. Each is small, and each should have a test.

**B8. Resolve symlinks and Windows aliases before checking paths** (S). The sensitive, blocked and outside-project checks compare the path as written. A symlink inside the project that points at `~/.ssh/id_rsa` or at this agent's credentials passes every check, and so do Windows short names (`PROGRA~1`) and trailing-dot names. Resolve with `fs.realpath` (native on Windows) before classifying, for reads and for the directory of a file that does not exist yet.

**B9. Keep the agent's own keys out of child processes** (S). Commands run by the no-terminal fallback and every MCP server inherit the agent's environment, including `ANONROUTER_API_KEY` and `VENICE_API_KEY` when they come from `acp.json`. A third-party MCP server would receive them. Strip our provider keys (and `ACP_SECRET`) from the environment handed to children, unless an MCP server's own `env` entry sets them.

**B10. Never overwrite a file that changed after the preview** (S). `edit_file` and `write_file` write the content computed when the preview was made. If you keep typing in the file while the approval prompt is open (or the model's earlier step touched it), the write replaces your newer text. Re-read at write time and refuse, with a clear message, if the file is no longer what was previewed.

**B11. File size and binary guards** (S). `read_file` loads whole files and returns binary data as text. Refuse binary files (NUL bytes) and files over a few megabytes unless a line range is given; read ranges by streaming; suggest the right tool in the error.

**B12. Tell the model its environment** (S). The system prompt names the project folder but not the operating system, shell, today's date or whether the folder is a git repository. On Windows the agent runs commands through `cmd.exe`, while models write bash. Add those facts to the prompt, add a `<P>_SHELL` setting (cmd, PowerShell, or an explicit path) `[plugin]` with the setting as an environment variable or menu until then, and use the IDE terminal's shell when the client reports it.

**B13. Survive a full context window** (M). Today the agent only drops old tool outputs. A long chat eventually gets the provider's "context length exceeded" error and stops. Detect that error for both providers, compact automatically (reusing `/compact`) and retry; start compacting early (around 80% of the window) with a short note; and calibrate the characters-per-token estimate from the provider's reported usage.

**B14. Risky-command guard** (S–M). Ask before obviously destructive or exfiltrating commands even in Accept edits and Bypass modes: recursive deletes, `git push --force` and `git reset --hard`, `curl ... | sh`, `sudo`, writes to system folders, disk formatting. A setting turns it off for people who want a truly hands-off Bypass. Show why the prompt appeared.

**B15. `logout` and `purge` commands** (S). Counterparts to `login`: `logout` removes the saved key (including the Keychain, keyring or DPAPI entry), `purge` also deletes chats and settings. A privacy-first tool should be able to remove everything it stored, from a terminal, in one step.

**B16. Secret scanning in CI and a pre-commit hook** (S). Run the project's own redactor (and optionally gitleaks) over staged and pushed files so a real key never lands in the repository; allow-list the deliberate fake keys in tests.

**B17. Atomic writes and multi-window safety** (S). `settings.json` and `credentials.json` are written in place; two IDE windows (two agent processes) can interleave. Write to a temporary file and rename, as the chat files already do, and re-read settings when they change.

### Verification

**B18. Hands-on pass before announcing** (M). Things CI cannot confirm, to check by hand and record in the README's "Not yet verified" section: install from a clean machine through the registry, including that JetBrains provisions Node for npx agents and whether it appends or replaces terminal-auth arguments; how the "sensitive file" prompt, the mode menus, the cost in the context meter and `/forget` look in the IDE; the macOS Keychain and dialogs on a real Mac, and the Linux dialogs and keyring on a real desktop; behavior over SSH and in remote development; a long session near the context limit; and cancelling during each kind of tool call.

---

## 2. After release

### Everyday use

**N1. Project instructions** (M). Read `AGENTS.md` from the project root (the convention most ACP agents follow) and an optional user-level file, and add them to the system prompt, after redaction. Treat a repository's instructions as untrusted input: the first time a project's file is used, show it and ask; never let it change approvals or settings.

**N2. `doctor` command and a debug log** (S–M). `npx <package> doctor` prints what support needs: Node version, platform, whether a key is found and how it is protected, which dialog program exists, whether each provider answers and how many models it lists, terminal-auth capability. A `<P>_DEBUG=1` switch writes a scrubbed protocol log to a file for bug reports (note: tool-call updates carry restored values, so the log is scrubbed again on write).

**N3. Loop guard and tolerant tool arguments** (S). Stop (or ask) when the model repeats an identical failing call several times. Repair near-miss JSON arguments (trailing commas, single quotes, unescaped newlines) before giving up.

**N4. Better file tools** (M). A `find_files` tool (by name pattern); search and listing that respect `.gitignore`; `delete_file`, `move_file` and `create_dir` tools with the proper ACP kinds and approvals; an optional multi-edit and patch tool to save round trips; line numbers in `read_file` output when asked.

**N5. Additional directories** (S). Honor `additionalDirectories` from the IDE's session setup (multi-root projects) as "inside the project", so files there are not flagged as outside.

**N6. Custom OpenAI-compatible provider** (M). A third built-in adapter configured by URL and key (environment or settings file), covering local servers such as Ollama and LM Studio, which suits the "Incognito" name best: nothing leaves the machine. This is what "leaves room for more agents" means in practice; adding well-known hosted providers after that is one adapter each.

**N7. Fast startup** (S). Decrypting the saved key on Windows takes over a second (a PowerShell call) and blocks the first reply to the IDE. Check only that a protected key exists at startup and decrypt on first use.

**N8. Spending guard** (S–M). A per-session (and optional daily) cost limit using the cost estimate already computed: warn at a threshold, ask before going past it, stop at a hard cap.

**N9. Model menu usability** (S–M). Group the 100-plus models (by family or privacy tier, using ACP's grouped options), and add a `<P>_MODELS` allow-list or favorites setting `[plugin]` to keep the menu short. Optionally pin sensible defaults per provider.

**N10. MCP lifecycle** (M). Close MCP servers of chats that went idle, reconnect a server that died, refresh tool lists when a server announces a change, support the SSE transport, and show per-server status in `/status`.

**N11. Parallel read-only tool calls** (S). Run independent reads and searches from one model turn concurrently, keeping results in order.

**N12. Session niceties** (S). Titles written by the model after the first exchange, pagination for long session lists, and `session/close` if the protocol gains it.

**N13. Protocol conformance test** (M). Validate every message the agent sends against the official ACP JSON schema (a development-only dependency or a small hand-written checker), so a spec change or an editing slip cannot silently break the IDE.

**N14. Plan-mode hand-off and questions** (S–M) `[suggestion]`. When a plan is ready, propose switching to Accept edits through a prompt (ACP's `switch_mode` kind); an `ask_user` tool that uses the protocol's elicitation request, where the IDE supports it, for clarifying questions with options.

### Trust and privacy

All of these were accepted. Items marked `[plugin]` need a settings page to be pleasant; the interim form is listed so they can ship first.

**P1. Per-project rules** (M) `[plugin]`. Remember approvals across sessions: "always allow `npm test` here", "never touch `infra/`". Design constraint: rules must never come from the repository itself, or a cloned project could pre-approve its own attack; they live in the user's data folder keyed by project path, and any rule that would allow more than reads is shown for confirmation when created. Interim: a user-level rules file plus a `/rules` chat command to list, add and remove entries; the plugin later gives it an editor.

**P2. Network boundary** (M) `[plugin]`. Enforce that the agent talks only to an allow-list of hosts: by default the configured provider, the control origin and the MCP servers the IDE passed, plus anything the user adds. Implemented by routing every outbound request through one guarded function, with a clear message when something is blocked and the active list shown in `/status`. Interim: an environment variable or settings-file list; the plugin later gives it a table editor. (Commands run by the model are outside this boundary and still need approval.)

**P3. Encrypt saved chats at rest** (M). Keep a per-user key in the OS store (DPAPI, Keychain or keyring) and encrypt the chat files, for people who keep history but do not want it readable by backup tools or other accounts. Off by default if it makes migration or support harder; on by default if it proves transparent.

**P4. Prompt-injection hygiene** (M). Wrap file, search, web and MCP output in clear delimiters and tell the model it is untrusted data; ask before acting on an instruction that appeared only in tool output (for example a file telling the model to run a command); never let tool output change a mode or setting.

**P5. Transparency log** (M) `[suggestion]`. A local record per chat of what was sent where: provider, route and privacy tier, how many secrets were redacted, token counts, and which files were read. Shown through `/log` and exportable. This makes the "privacy-first" claim checkable instead of just stated.

**P6. Custom redaction patterns and allow-list** (S–M) `[plugin]`. Let users add their own secret patterns (internal token formats) and exempt known-safe strings that look like secrets. Interim: a small JSON file.

**P7. Confidential routes** (L) `[suggestion]`. Verify TEE attestation and support end-to-end encrypted models for both providers (Anonrouter's `e2ee` class, Venice's `e2ee-*` models, currently hidden). Needs client-side cryptography, probably the providers' own SDKs, which conflicts with the no-dependencies rule, so it may belong in an optional companion package.

**P8. Release integrity extras** (S) `[suggestion]`. Reproducible package contents check in CI, a documented way to verify a download against its provenance, and pinning of every GitHub Action stays enforced by Dependabot (already in place).

**P9. Log hygiene** (S). The IDE's own ACP logs can contain tool-call updates, which carry real values after secrets are restored for local display. Document how to redact before sharing logs, and consider sending placeholders instead of restored values in titles and raw inputs where the IDE does not need them.

### The plugin (only if you still want it after release)

A Kotlin plugin on the Marketplace, built after the agent has users. It needs a vendor account, signing, an IDE build range and a review, then upkeep with each IDE release. It can write the agent entries into `~/.jetbrains/acp.json` (there is no documented API for registering agents) and give these a real home:

- **PL1.** Settings → Tools page for every environment variable (key, default model, mode, tool-call limit, routing, privacy floors, retention, shell).
- **PL2.** Editor for per-project rules (P1) and the network boundary (P2).
- **PL3.** Key management: sign in, sign out, see where the key is stored, and run `purge`.
- **PL4.** Editor for custom redaction patterns (P6).
- **PL5.** Completion proxy manager: start, stop, show status (B7).
- **PL6.** Status-bar widget showing provider, privacy tier and session cost `[suggestion]`.
- **PL7.** Transparency log viewer (P5) `[suggestion]`.

---

## 3. Suggestions (cut freely)

Things I think are worth considering but that you may not want:

- **Web fetch tool** `[suggestion]`: let the model read a URL, off by default, asking per domain, with its output treated as untrusted (P4). Venice and Anonrouter already offer provider-side web search.
- **Custom slash commands** from markdown files in the user's data folder.
- **Prompted tools** for the roughly 10% of models without native tool calling (wrapping tool use in plain text). It widens the model list but is less reliable; "(no tools)" models are honest about their limits today.
- **Prompt caching** where a provider supports it (Venice lists cached-input pricing), to cut cost on long chats.
- **Background commands** for dev servers and watchers, with a way to list and stop them.
- **Anonrouter balance** through a management key (`arm_`) in `/status`.
- **Sampling settings** (temperature, top-p) per model.
- **Notebook files** and other structured editors; **image files** as tool results for vision models.
- **Localization** of the agent's own messages and dialogs.
- **A documentation site** (GitHub Pages) once the README outgrows one page.

---

## 4. Known limits (documented, not planned)

- Redaction is pattern-based; a secret with no recognizable shape that was never configured can get through, and images are sent as they are.
- `run_command` runs as you and can read anything you can; approvals, the risky-command guard and the sensitive-file rules reduce the risk but are not a sandbox.
- MCP servers are code you chose to run, and receive their tool arguments with real values restored.
- The provider you choose decides what happens to your data after it arrives; the privacy tier shown is the provider's claim.
- The agent makes no network calls of its own besides the provider, ticket control server and MCP servers, and never checks for updates; users update through the registry or npm.
- JetBrains does not support ACP agents under WSL.

---

## 5. Decisions needed from you

1. **Name** (B1): which package name and registry ids, and whether to keep the existing repository name.
2. **Marks** (B2): ask the owners, or use a neutral icon.
3. **First version** (B4): `0.3.0` or `1.0.0`.
4. **Completion proxy** (B7): keep, split out, or drop.
5. **Copyright holder** (B6): handle or legal name.
6. **Plugin** (section 2): go or no-go, decided after real users exist.
7. **Contributions** (B5): accept outside pull requests (a CONTRIBUTING file and maybe a DCO), or keep the project closed.
