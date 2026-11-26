# Security Policy

## Supported versions

Security fixes go into the latest release. Please update to the [newest version](https://github.com/alouini333/gitlane/releases/latest) before reporting.

| Version | Supported |
| --- | --- |
| Latest release | ✅ |
| Older releases | ❌ |

## Reporting a vulnerability

**Please don't open a public issue for security problems.**

Report privately through GitHub: open the [Security tab](https://github.com/alouini333/gitlane/security), choose **Report a vulnerability**, and include:

- what an attacker could do, and under which conditions;
- steps to reproduce, or a proof of concept;
- the Gitlane version, your OS and `git --version`.

We'll acknowledge your report within a few days, keep you updated, and credit you in the release notes if you'd like. Please give us a reasonable amount of time to release a fix before disclosing publicly.

## How Gitlane handles sensitive data

Useful context for reports:

- **API keys** for AI providers are encrypted with the operating system's keychain (Electron `safeStorage`) and stored in the app's user-data folder. After you save a key, the UI process never receives it again.
- **GitHub** access reuses your GitHub CLI login (`gh auth token`) or `GITHUB_TOKEN` / `GH_TOKEN`. Gitlane doesn't store GitHub tokens.
- **Network:** Gitlane talks to GitHub and to the AI providers you connect, and to nothing else. There is no telemetry.
- **Update check:** a few seconds after startup and every six hours, Gitlane asks GitHub's public API for the latest release. The request carries only the app version (in the `User-Agent`), no account or repository information. Turn it off in *Preferences → Updates*. Nothing is downloaded or installed automatically.
- **The coding agent** can only read and write inside the open repository. Paths are resolved and checked, symlinks included, and `.git` is off limits. File edits and shell commands wait for your approval unless you change the permission mode. Shell commands run with your user's permissions, so review them before allowing them.
- **The renderer** runs sandboxed with context isolation and talks to the main process only through an allow-listed IPC bridge. Links in rendered Markdown open in your browser, and the app window can't be navigated away.

## Scope

In scope: the Gitlane app and its build and release workflows in this repository.

Out of scope: vulnerabilities in Git, GitHub, model providers or other third-party services themselves (please report those to the vendor), and issues that need an already-compromised machine.
