# Contributing to Gitlane

Thanks for helping! Bug reports, ideas, docs fixes and code are all welcome. By taking part you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to help

- **Report a bug** with the [bug template](https://github.com/alouini333/gitlane/issues/new?template=bug_report.md). Steps to reproduce, your OS and `git --version` help a lot.
- **Suggest a feature** with the [feature template](https://github.com/alouini333/gitlane/issues/new?template=feature_request.md). Describe the problem before the solution.
- **Pick up an issue.** Look for `good first issue` and `help wanted`. Comment before you start so nobody duplicates work.
- **Security issues:** please don't open a public issue. Follow [SECURITY.md](SECURITY.md).

## Development setup

You need [Node.js](https://nodejs.org/) (the version in [`.nvmrc`](.nvmrc); `nvm use` picks it up) and Git 2.31+.

```bash
git clone https://github.com/alouini333/gitlane.git
cd gitlane
npm ci
npm run dev
```

`npm run dev` starts the app with hot reload for the UI. Changes to the main process restart it.

Native modules: the integrated terminal uses [`node-pty`](https://github.com/microsoft/node-pty). macOS and Windows use its prebuilt binaries. On Linux it compiles during `npm ci`, so you need `python3`, `make` and a C++ compiler (`sudo apt install build-essential python3`).

If npm prints a warning about install scripts for a *new* dependency, review that package and approve it with `npm install-scripts approve <pkg>` (or deny it). The approvals live in `package.json`.

## Useful commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Run the app in development |
| `npm test` | Unit and integration tests (vitest) |
| `npm run typecheck` | Type-check everything |
| `npm run build` | Production build into `out/` |
| `npm run dist:mac` / `dist:win` / `dist:linux` | Package installers into `dist/` |

Tests create throwaway Git repositories in your temp folder. GitHub and model-provider calls are mocked, so no network or keys are needed.

## Project layout

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how the main process, preload and renderer fit together, and where each feature lives.

## How we work: trunk-based

`main` is the trunk and is always releasable.

1. Fork the repo (or, as a maintainer, branch off `main`) and create a **short-lived** branch: `feature/short-name` or `fix/short-name`.
2. Keep changes small and focused, and merge often. Hide big features behind a preference instead of a long-running branch.
3. Add or update tests for behavior you change. Git operations get integration tests against real repos (see `tests/repository.test.ts`), and pure logic gets unit tests.
4. Make sure `npm run typecheck` and `npm test` pass. CI runs both on every pull request.
5. Add a line to [CHANGELOG.md](CHANGELOG.md) under **Unreleased** for anything users will notice. The release workflow turns these notes into the release page.
6. Open a pull request into `main` and fill in the template. Screenshots or a short clip help for UI changes.

### Code style

- TypeScript in strict mode. No `any` unless there's no reasonable alternative.
- Keep the renderer free of Node APIs. Go through `window.bridge`.
- Prefer small, pure functions for logic (parsers, layout, patch building) so they're easy to test.
- Match the formatting of the surrounding code (2 spaces, single quotes, no semicolons). `.editorconfig` covers the basics.
- UI text: short, plain, sentence case.

### Commit messages

Write the subject in the imperative mood, under about 72 characters ("Add line staging to the split diff"). Explain the *why* in the body when it isn't obvious. Reference issues with `Fixes #123`.

## Releases

Releases are cut from `main` in two steps, and like every change they land through a pull request.

1. **Start the release.** Open **Actions → Release → Run workflow**, keep the branch on `main`, choose the kind of release (**minor**, **major** or **patch**), and click **Run workflow**. The [Release workflow](.github/workflows/release.yml):
   - runs the type-check and tests on `main`;
   - bumps the version in `package.json`, and moves the **Unreleased** notes in `CHANGELOG.md` under the new version (`scripts/changelog.mts`);
   - pushes a `release/vX.Y.Z` branch and opens a **Release vX.Y.Z** pull request with those notes.
2. **Merge the release PR.** Approve and merge it. The [Publish release workflow](.github/workflows/publish.yml) then:
   - tags the merge commit `vX.Y.Z` and deletes the release branch;
   - builds macOS (Apple silicon and Intel), Windows and Linux installers in parallel;
   - publishes a GitHub release with the installers and that version's changelog notes.

Pick **major** for breaking changes, **minor** for new features, and **patch** for fixes only.

Merge the release PR before other pull requests, so the release contains exactly what its notes describe. If a build fails (GitHub sometimes runs short of macOS runners), open the Publish release run and click **Re-run failed jobs**.

## Questions

Open a [discussion or issue](https://github.com/alouini333/gitlane/issues). We're happy to help you get started.
