# Architecture

Gitlane is an [Electron](https://www.electronjs.org/) app written in TypeScript, built with [electron-vite](https://electron-vite.org/). The UI is React with [zustand](https://github.com/pmndrs/zustand) stores. Git work is done by running the user's `git` binary; nothing reimplements Git.

```
src/
  shared/              types and pure helpers used by both processes
    types.ts           repository, pull request and IPC API types
    agent.ts           coding-agent types
    patch.ts           builds partial patches for hunk and line staging
  main/                Electron main process (Node.js)
    index.ts           window, IPC handlers, recent repositories
    git/
      runner.ts        spawns git: no TTY, prompts disabled, stable English output
      parsers.ts       pure parsers for log, refs, status v2, name-status, diffs
      repository.ts    every git operation the UI can request (RepoApi)
    github.ts          GitHub REST/GraphQL client: remote detection, auth via gh or env, caching
    pullRequests.ts    PR lists, details, reviews, comments, merging, creating
    watcher.ts         debounced file watcher for the working tree and git dir
    terminal.ts        PTY sessions (node-pty) for the integrated terminal
    ai/
      adapter.ts       provider-neutral interface, SSE reader
      anthropic.ts     Claude via the official Anthropic SDK
      openai.ts        OpenAI-compatible chat completions (OpenAI, OpenRouter, Ollama, custom)
      gemini.ts        Google Gemini
      providers.ts     provider registry and Keychain-encrypted credentials
      oauth.ts         "Sign in with OpenRouter" (OAuth PKCE, loopback callback)
      tools.ts         the agent's tools, confined to the repository
      agent.ts         the agent loop, permission prompts, chat storage
  preload/             exposes a small, typed window.bridge (sandboxed renderer)
  renderer/            React UI
    src/store.ts       repository state, refresh coalescing, selection and diff sync
    src/actions.ts     user-level git operations with confirmations
    src/prActions.ts   pull-request dialogs (create, review, merge, pickers)
    src/agent.ts       agent state, streaming, providers and models
    src/terminal.ts    xterm.js instances and terminal sessions
    src/graph/         commit-graph lane layout
    src/components/    Toolbar, Sidebar, Graph, RightPanel, DiffView, PrView, AgentPanel, TerminalPanel, …
tests/                 vitest: parsers, layout, patches, real git repos, mocked GitHub and LLM APIs
```

## How the pieces talk

The renderer never touches Node APIs. `preload/index.ts` exposes `window.bridge` with three channels:

- `app`: app-level calls such as opening a folder, cloning, and opening files and links.
- `repo`: methods of `Repository` (`src/main/git/repository.ts`), allowed only for repositories the user opened.
- `agent`: provider and chat management. Long-running agent work streams back as `agent:event` messages.

`window.bridge.terminal` carries PTY data both ways, and `repo-changed` events from the file watcher trigger refreshes.

## Things worth knowing

- **Graph layout** (`src/renderer/src/graph/layout.ts`) is a pure function from commits to lanes and segments. The `Graph` component renders only visible rows.
- **Line staging** builds a minimal patch (`src/shared/patch.ts`) and applies it with `git apply --cached`. Unselected lines are rewritten so the side being matched stays intact.
- **Branch switching** (`Repository.switchTo`) stashes, switches and optionally re-applies in one call, and restores changes if the switch fails.
- **GitHub** requests go through Electron's `net.fetch`, so system proxy settings apply. Pull requests come from the base repository (`upstream` before `origin`).
- **The agent** keeps provider-native message content and replays it unchanged to the same provider (thinking blocks, Gemini thought signatures). The system prompt is frozen per chat, so prompt caching works. Tools validate paths so they stay inside the repository. Edits and commands go through a permission prompt unless the user allows them.
- **Credentials:** API keys are encrypted with Electron `safeStorage` (the system keychain). The renderer never sees them after they're saved.

## Dev helpers

These environment variables are read by the main process:

| Variable | Effect |
| --- | --- |
| `GITLANE_OPEN=/path/to/repo` | open this repository on start |
| `GITLANE_USER_DATA=/tmp/x` | use an isolated profile (recent repos, chats, keys) |
| `GITLANE_CAPTURE=out.png` | render, save a screenshot and quit (`GITLANE_CAPTURE_SCRIPT` runs JS first) |
| `GITLANE_DEBUG=1` | forward renderer console output to stdout |

`GITLANE_LIVE_OLLAMA=llama3.2 npx vitest run tests/live-ollama.test.ts` runs the agent loop against a local Ollama model.
