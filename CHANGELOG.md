# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed
- Repository set up with CI, a security policy, and registry drafts. The project is being renamed to Incognito; see `ROADMAP.md`.

### Added
- Sign-in dialog fallbacks: `kdialog` and `yad` after `zenity` on Linux, a check that a dialog program and display actually exist, and no dialog over SSH. Where none can be shown, the agent points to `login`.
- Tests: every tool (including diff previews, unsaved editor buffers and IDE terminals), the sign-in dialog on each platform, the model-list parsers against captured real data, a real-keyring CI job, and an opt-in live test (`npm run test:live`).

### Fixed
- `search_files` called without a pattern now says so instead of matching every line.

## [0.2.0] - 2026-10-23

First version with both providers, packaged as one npm package with a launcher for each agent.

### Added
- **Venice agent**, alongside Anonrouter, on a shared core with one small adapter per provider.
- **Modes and approvals** in AI Chat: Manual, Accept edits, Plan and Bypass permissions, using native permission prompts with diffs.
- **Anonrouter**: routing and privacy settings (minimum privacy, sort, fallbacks, price caps), private ticket mode, route and privacy notes, per-model capability data, reasoning effort, session cost and `/status`.
- **Venice**: web search and other `venice_parameters`, reasoning effort, account balance, and a privacy floor.
- **Resumable chats**, MCP servers over stdio and HTTP, image input, `/clear` and `/compact`, task checklist updates, a context meter, and an AI Completion proxy for Anonrouter (experimental).
- **Privacy and security**: secret redaction with restore-on-use, rules for sensitive and blocked files, OS-protected key storage, chat retention with `/forget`, key masking in logs, and process and regex safeguards.
- Combined launcher `anonrouter-venice-acp <anonrouter|venice>` and terminal sign-in for headless machines.
- Draft ACP registry entries and 16x16 monochrome icons.
- MIT license.

### Changed
- Reasoning is always sent as one thought update; the `<P>_THINKING` option is gone.
- Tool-call limit per turn is configurable (`<P>_MAX_TOOL_CALLS`, `<P>_ON_TOOL_LIMIT`) and asks before stopping.

### Removed
- `<P>_AUTO_APPROVE` and `<P>_APPROVAL`; use `<P>_MODE` instead (for example `bypassPermissions`).

### Fixed
- Cancelling mid tool call no longer leaves the chat history unusable.
- Stalled and half-finished streams are retried instead of hanging.
- The completion proxy refuses requests from web pages.

## [0.1.0]

Initial Anonrouter agent for JetBrains AI Chat: streaming chat with file and command tools, permission prompts, and a first-run API key dialog.
