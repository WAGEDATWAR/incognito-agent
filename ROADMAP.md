# Roadmap to a public release

Ordered by dependency and payoff: do earlier items first. Sizes are relative effort: **S** is a few hours, **M** about a day or two, **L** a week or more. Items marked ✅ are already done.

## The publishing decision (decided: ACP Registry only)

You chose the registry route. The Marketplace plugin (Phase 6) stays an optional upgrade for later.

"The JetBrains marketplace" is two different things, and they have very different costs.

| Route | What it is | Effort | What it gets you |
|---|---|---|---|
| **A. ACP Registry** (recommended) | Pull request to [agentclientprotocol/registry](https://github.com/agentclientprotocol/registry). Users install from AI Assistant's agent list (IDE 2025.3.2+). | **S–M** | Listing with icon in the agent dropdown, one-click install, automatic version updates from npm. No IDE plugin. |
| **B. Marketplace plugin** | A Kotlin/Gradle IntelliJ Platform plugin on plugins.jetbrains.com. | **L** | A Settings → Tools page. Ongoing compatibility work for each IDE release. |

Settings → Tools can only come from route B. The registry route has no settings UI, but items 13–14 give most of the benefit inside AI Chat's own menus, which the IDE already renders for these agents. Recommendation: ship route A first; build B only if you still want the settings page afterwards.

**Registry requirements** (from the registry's CONTRIBUTING and FORMAT docs):
- A folder `<id>/` with `agent.json` and a required `icon.svg`.
- `agent.json` needs `id`, `name`, `version` (plain `X.Y.Z`), `description`, `license_url` and a `distribution`.
- Distribution is `npx` (pinned npm version, no `@latest`), `uvx`, or `binary` archives.
- Icon must be exactly **16×16, square, monochrome**: `fill` and `stroke` may only be `currentColor`, `none` or `inherit`. Full-colour brand logos are rejected.
- CI starts the agent and requires `authMethods` from `initialize` with at least one of type `agent` or `terminal`. We already return one when no key is saved. Environment-variable auth is not accepted.
- An hourly job picks up new versions from npm and GitHub Releases, so after the first PR, releases are automatic.

---

## Phase 0: landed this session

1. ✅ **Tool-call limit no longer dead-ends a turn.** At the limit (`<P>_MAX_TOOL_CALLS`, default 40 rounds) the agent now asks "Used N tool rounds. Keep going?" through the native approval prompt. `<P>_ON_TOOL_LIMIT` sets the behaviour: `ask` (default), `continue` (auto, with a hard ceiling of 10× the limit) or `stop`. Bypass mode continues without asking. Covered by `test/toollimit.js`.

## Phase 1: cleanup (S)

2. ✅ **Remove `<P>_THINKING` and its code.** Delete the `card` mode: `ThinkingCard`, `wrapForCard`, the `thinking` config key, and the README rows. Keep `ThoughtBuffer`, since it is what makes thoughts render correctly. Update the tests that touch it.
3. ✅ **Remove `<P>_AUTO_APPROVE` and `<P>_APPROVAL`.** Drop the legacy mapping in `src/cli.js` and the README rows. `<P>_MODE` remains the single switch. This is a breaking change, so bump the minor version and note it in the changelog.
4. ✅ **Fix the three skipped review findings** (all small): kill the whole process tree on Windows for the no-terminal command fallback; guard `search_files` against catastrophic regexes (run with a time budget); serialize prompts per session.

## Phase 2: correctness gaps found in the API research (S–M)

5. ✅ **Read Anonrouter's capability flags properly.** This answers your streaming/tool-calling question: both are in `GET /v1/models` under `capabilities` (`streaming`, `tools`, plus `vision`, `max_images`, `web`, `embeddings`). The same data appears camelCased (`supportsStreaming`, `supportsTools`) in the response's `routing_catalog`. Live numbers for your account: 205 text models, all stream; 186 support tools and 19 don't. We already mark tool-less models via `tools`, but should also (a) label them "(no tools)" in the picker like Venice, (b) fall back to non-streaming if a model ever reports `streaming: false`, and (c) optionally hide tool-less models by default.
6. ✅ **Anonrouter reasoning efforts are currently ignored.** `capabilities.reasoning` is an object (`supported`, `effort_configurable`, `supported_efforts`, `can_disable`, `always_on`), but `parseModels` treats it as a boolean, so Anonrouter models never get the Reasoning effort menu Venice has. Parse it, send `reasoning_effort` (docs also accept `reasoning: {enabled, effort}`), offer `none` only when `can_disable`, and map the 400 errors (`reasoning_not_disableable` and friends) to plain messages.
7. ✅ **Venice end-to-end encrypted models.** The Venice list includes `e2ee-*` models. They likely need client-side encryption we don't implement and will fail. Verify, then hide them until supported.
8. ✅ **Use `max_output_tokens` and context data.** Cap `max_tokens` per model, and use Anonrouter's `context_admission` data for the context meter instead of an estimate.
9. ✅ **Sessions that survive a restart.** Implement `loadSession` and session listing so chats resume after the IDE restarts. Persist history to `~/.<provider>-acp/sessions/`. Also persist "Always allow" choices per project if wanted.
10. ✅ **MCP support.** JetBrains passes configured MCP servers (and optionally the IntelliJ MCP server) in `session/new`; we ignore them and advertise no MCP capability. Implement an MCP stdio client that exposes those tools to the model. This is the biggest functional gap against other registry agents.
11. ✅ **Image input.** Vision models report `vision`; set `promptCapabilities.image` per model and pass attached images as `image_url` parts.
12. ✅ **Smaller ACP features.** `plan` updates (the checklist UI), `available_commands_update` (slash commands such as `/clear`), and a visible rate-limit retry notice plus stalled-stream timeout. You declined the last two earlier; I would revisit them before a public release, since strangers will hit provider rate limits.

## Phase 3: provider-specific settings (M), done

Built as AI Chat menus plus environment variables, persisted to `~/.<provider>-acp/settings.json`. Findings from the live API: streaming responses only carry `x-anonrouter-selected-model` and `x-anonrouter-routing` (the documented provider, privacy and fallback headers did not appear), so the serving provider is read from the model ID and its privacy tier from the model list; and `usage` arrives in the stream without asking for it.

These only matter if the settings have a home. Without a settings page, expose them as AI Chat config-option menus (the Model, Mode and Reasoning menus already work this way), persisted to `~/.<provider>-acp/settings.json`.

13. ✅ **Anonrouter routing settings: justified.** The chat endpoint takes a `provider` object that changes cost, privacy and reliability: `minimum_privacy` (`anonymous`, `private`, `tee`, `e2ee`), `order`, `only`, `ignore`, `allow_fallbacks`, `sort` (`privacy`, `price`, `latency`, `throughput`), `max_price` (USD per million tokens, input and output), `require_parameters` and `max_attempts` (1–3). Suggested variables: `ANONROUTER_MIN_PRIVACY`, `ANONROUTER_PROVIDER_ORDER`/`_ONLY`/`_IGNORE` (comma lists), `ANONROUTER_ALLOW_FALLBACKS`, `ANONROUTER_SORT`, `ANONROUTER_MAX_PRICE_INPUT`/`_OUTPUT`, `ANONROUTER_MAX_ATTEMPTS`. **Default `require_parameters` to true**, since an agent needs tool support and Auto routing may otherwise pick a route without it. The menus should be at least Minimum privacy and Sort.
14. ✅ **Surface what Anonrouter did.** Responses carry `x-anonrouter-selected-model`, `-provider`, `-privacy-class`, `-provider-fallback` and `-provider-attempts`. Show the provider and privacy class in a short note or the usage panel. Add privacy class to model names in the picker. Translate routing errors (`no_provider_route_meets_privacy`, `no_provider_route_meets_price`, `provider_fallback_exhausted`) into plain advice. Report per-model pricing as the `cost` field of `usage_update`.
15. ✅ **Venice extras.** Beyond the existing web search and system prompt variables: `enable_web_scraping`, `enable_x_search`, `enable_web_citations`, `strip_thinking_response`, and showing the `x-venice-balance-usd` / `-diem` headers. Done: all four switches are environment variables, web search also has a menu, and the balance shows in `/status`.
16. ✅ **Anonrouter inference tickets (stretch).** The documented privacy-preserving flow (`POST /v1/inference/tickets`, then `x-anonrouter-ticket`). Done as the Request mode menu and `ANONROUTER_TICKETS`; the SDK's own client source documented the exact fields (ticket body: `model`, `provider`, `max_completion_tokens`, `reasoning_effort`; completion carries only the ticket header, no key). Checked live, including a tool-call round trip.

## Phase 4: branding and packaging (S–M)

17. ✅ **Icons.** Done: your two SVGs are normalized to plain 16x16 monochrome icons in `registry/anonrouter/icon.svg` and `registry/venice/icon.svg` (details in `registry/README.md`), with draft `agent.json` files and `test/icons.js` to keep them valid. Still open: permission from the owners of the two marks (or switch to the neutral mark planned in 17a), and replacing `OWNER/REPO` in the drafts once the repository exists.
17a. **Rebrand to Incognito: Privacy-first multi-agent ACP.** A clearer name than listing providers, it fits one package bundling several agents (and leaves room for more), and it would carry over as the name of a Marketplace plugin. Do it before the GitHub repository is created and before the registry PR, because the npm name, repo name and registry ids are hard to change afterwards. Checklist: (1) npm names `incognito-acp`, `incognito-agents`, `acp-incognito` and `incognito-ai` were all free when checked; (2) "Incognito" is also the name of Chrome's private browsing mode, so run a trademark and search check, avoid Chrome-like iconography, and keep the descriptive subtitle and the "unofficial" notice; (3) registry ids and display names, for example `incognito-anonrouter` / `incognito-venice` shown as "Incognito (Anonrouter)" and "Incognito (Venice)"; (4) keep the `ANONROUTER_` and `VENICE_` variable prefixes, and consider a shared `INCOGNITO_` prefix for cross-provider settings (secret redaction, retention); (5) move saved data from `~/.anonrouter-acp` and `~/.venice-acp` to one `~/.incognito-acp/` folder, with a one-time migration; (6) use a generic privacy mark for the icon instead of the providers' brand logos, which also removes the logo-permission question in item 17; (7) update the README title, package name and bins, the launcher usage text, and the repo name and description.
18. ✅ **Make it installable with npx** (done except the checks marked below). One package, `anonrouter-venice-acp` (free on npm when checked; rename in `package.json` if you prefer a scope), with a bin named like the package so `npx anonrouter-venice-acp anonrouter` and `... venice` work with no `-p` flag; registry entries use `args: ["anonrouter"]` and `args: ["venice"]`. Also exposes `anonrouter-acp`, `venice-acp` and the completion proxy. `files` ships only `bin`, `src`, the README and the LICENSE; the version reported to clients comes from `package.json`; the README no longer contains machine paths. `npm run test:package` packs the project and runs the tarball through npx: contents, handshake for both providers, `--version`, the usage error and `login`. Terminal auth: the ACP schema says terminal-auth `args` are *appended* to the configured launch, while the registry's own doc says they replace it, so `login` works after a provider name and, with no provider name, asks which one on a terminal. The agent offers terminal sign-in only to clients that advertise `auth.terminal` and only where no dialog can be shown (a headless Linux or remote host); everywhere else the paste dialog is the method. Still to confirm by hand: that JetBrains provisions Node for npx agents on a machine without it, and which of append or replace the IDE actually does.
19. ✅ **Repository and licence.** Done: public repository at https://github.com/WAGEDATWAR/incognito-agent, MIT `LICENSE` (copyright line "WAGEDATWAR"; change it to your legal name if you prefer), `.gitignore` and `.gitattributes`, `repository`/`bugs`/`homepage` in `package.json`, `CHANGELOG.md`, and `SECURITY.md` (turn on private vulnerability reporting under the repository's Security settings so its "Report a vulnerability" link works). The `v0.2.0` tag waits for the first real release, since the rebrand in 17a will change the package name and version.
20. ✅ **CI.** Written, not yet run on GitHub: `.github/workflows/ci.yml` runs `npm test` and the pack-and-npx test on Ubuntu, Windows and macOS with Node 20 and 22. Actions are pinned to commit hashes, and `.github/dependabot.yml` proposes updates weekly. Watch the first run; the Linux and macOS jobs have never been exercised on a real machine, so expect to fix a test or two.
21. **Registry submission.** Fork the registry, add `anonrouter/` and `venice/` folders with `agent.json` and `icon.svg`, run the registry's local validator (`uv run --with jsonschema .github/workflows/build_registry.py`) and its auth check, then open the PR.

## Privacy and security features (added during Phase 4)

Built, all tested: secret redaction with restore-on-use (and placeholders only in saved chats); credential-like files ask every time and are never "always allowed"; this agent's own data is blocked from tools; OS-protected API key storage with migration; keys masked in logs and errors; chat retention (30 days by default), `/forget` and `/forget all`, and a private chat folder; a client-side privacy floor for Venice to match Anonrouter's `minimum_privacy`; the README's Privacy and security section documents the limits honestly.

Ideas not done yet, roughly by value:

- **macOS Keychain** for the saved key, once the secret can be passed without a command-line argument.
- **Risky-command guard.** Ask before patterns like `rm -rf`, `git push --force`, `curl ... | sh` and `sudo`, even in Bypass mode, unless switched off.
- **Encrypt saved chats at rest** with a key held in the OS store, for people who keep history.
- **Release integrity.** Publish with npm provenance (`npm publish --provenance` from CI), pin Actions by hash, add `SECURITY.md` with a disclosure address, and generate a software bill of materials. The package has no runtime dependencies, which keeps this small.
- **Secret scanning in CI** (for example gitleaks) and a pre-commit hook, so a real key never lands in the repository.
- **Per-project rules.** A reviewable allow-list file (`.incognito/rules.json`) for approvals you want remembered across sessions, in place of the session-only "Always allow".
- **Network boundary.** A startup check that only the configured provider, control origin and MCP servers are contacted, and a `--offline-models` style option for fully local providers.
- **Prompt-injection hygiene.** Wrap file, web and MCP output in clear delimiters and tell the model it is untrusted data, and ask before the model follows an instruction that came from tool output.

## Phase 5: release hygiene (S–M)

22. ✅ **Key storage.** Done for Windows (DPAPI) and Linux (`secret-tool`), with automatic migration of plaintext files and a 0600 file elsewhere; see the privacy section below. Left: macOS Keychain, which needs a way to pass the secret without putting it in a command line.
23. **Platform coverage.** The key dialog is tested only on Windows. Test macOS (`osascript`) and Linux (`zenity`, with a terminal fallback when it's missing). AI Assistant doesn't support ACP agents in WSL.
24. **Test debt.** Direct tests for `search_files`, outside-project handling and diff previews; an opt-in live test (`npm run test:live`, needs a key) covering streaming, tools and reasoning for both providers.
25. **Docs for strangers.** Rewrite the README around "install from the registry, paste your key", with the manual `acp.json` setup as a fallback section. Add a privacy note: what is sent to which provider, and that nothing is collected by the agent.

## Phase 6: optional marketplace plugin (L)

26. **Settings → Tools page.** A Kotlin plugin with an `applicationConfigurable` page covering the environment variables as fields: key, default model, mode, tool-call limit, routing settings. It would write the agent entries into `~/.jetbrains/acp.json`, since JetBrains offers no documented API for registering agents. It needs a Marketplace vendor account, plugin signing, a supported-IDE build range and a review before listing, then maintenance against each IDE release. Do this only after route A is live and if the settings page is still worth it.

---

## Suggested order of work

1. Items 2–4 (cleanup and review fixes), then 5–7 (API correctness). These are small and unblock everything else.
2. Items 18–21 to get on the registry quickly, with 17 in parallel since it depends on the brand owners' replies.
3. Items 9–11 and 13–14 as 0.3.x releases, since they're the biggest quality jump.
4. Phases 5 and 6 as needed.
