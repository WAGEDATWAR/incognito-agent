# Security policy

This project handles API keys and sends your code and prompts to AI providers, so security reports are welcome and taken seriously.

## Reporting a vulnerability

Please report it privately, not in a public issue:

1. Open the repository's **Security** tab and choose **Report a vulnerability** (GitHub private vulnerability reporting).
2. Include what you found, the steps or a minimal example that reproduces it, the version (`npx anonrouter-venice-acp --version`), and your operating system.

This is a small volunteer project, so replies are best effort: expect an acknowledgement within about a week. Fixes for confirmed problems are released as soon as practical, and you will be credited in the changelog if you wish.

## What counts

Examples of things worth reporting:

- A way to make the agent send a saved API key or other secret to a model, a log, or a saved chat.
- A way around the secret redaction, the sensitive-file prompts, the blocked credential files, or the approval modes.
- A way for a web page or another local program to use the completion proxy or the saved key.
- A flaw in how keys are stored, migrated or deleted, or in `/forget` and chat retention.

Not in scope: problems in Anonrouter, Venice, JetBrains' IDEs or the model providers themselves (report those to their owners), and behavior documented under "What this does not do" in the README, such as `run_command` being able to read anything you can.

## Supported versions

Only the latest release receives fixes.

## For maintainers

Releases should be published from CI with npm provenance, and the GitHub Actions in `.github/workflows` stay pinned to commit hashes. Never commit keys; the `.gitignore` excludes the usual places they end up.
