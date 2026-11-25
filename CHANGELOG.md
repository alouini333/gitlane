# Changelog

All notable changes to Gitlane are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-11-25

### Fixed

- Pasting a `claude setup-token` token as the Anthropic key now explains that it isn't an API key, instead of showing a confusing "429 rate_limit_error".

## [0.1.0] - 2026-11-25

The first public release.

### Added

- **Commit graph** with colored lanes, merge curves, combined local and remote branch labels, tags, a live `// WIP` node, stashes attached to their base commit, search (⌘F) and keyboard navigation.
- **Staging** of whole files, hunks or individual lines, in unified or split diffs. Commit, amend, discard, and add files to `.gitignore`.
- **Branches and history:** checkout, create, rename, delete, merge, rebase, cherry-pick, revert, reset, tags and stashes. Double-clicking a remote branch resets the local branch to it, and asks first if that would drop local commits.
- **Automatic stashing** when switching branches with uncommitted changes. The behavior is configurable in Preferences.
- **Conflict handling** for merges, rebases, cherry-picks and reverts: continue, skip or abort, and take ours or theirs.
- **GitHub pull requests:**
  - A sidebar list with filters (review requests, assigned, created, involves me).
  - PR pages with conversation, commits, checks and files changed.
  - Line and range review comments, review submission (comment, approve, request changes), replies and resolving threads.
  - Merging, closing and reopening, drafts, and reviewers, assignees and labels.
  - Creating PRs, and `@mention` autocomplete.
- **Integrated terminal** (ctrl+\`) with tabs, backed by a real PTY.
- **Coding agent** (⌘L) that reads, searches and edits the repository and runs commands, with approval prompts.
  - Works with Anthropic, OpenAI, Gemini, OpenRouter (with sign-in), Ollama and any OpenAI-compatible endpoint.
  - Keys are encrypted in the system keychain.
- **Preferences** for branch-switching behavior, the double-click action on remote branches, and the terminal font.
- Packages for macOS (Apple silicon and Intel), Windows and Linux (AppImage and .deb).

[Unreleased]: https://github.com/alouini333/gitlane/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/alouini333/gitlane/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/alouini333/gitlane/releases/tag/v0.1.0
