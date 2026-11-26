import { watch, type FSWatcher } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { parseWslPath } from './wsl'

type Kind = 'status' | 'all'

// Windows gets no change notifications from inside WSL (\\wsl.localhost\…), so for those repositories
// we poll the files that change when HEAD, refs, the index or an operation in progress change.
// Working-tree edits show up when the window regains focus.
const POLLED_GIT_PATHS = ['HEAD', 'index', 'packed-refs', 'logs/HEAD', 'FETCH_HEAD', 'refs/heads', 'refs/remotes', 'refs/tags', 'refs/stash', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']
const POLL_MS = 2000

// Files inside .git whose changes don't affect what we display.
const IGNORED_GIT_PATHS = /^(objects|logs|hooks|lfs|fsmonitor--daemon)(\/|$)|\.lock$|^FETCH_HEAD$|^gc\.pid$/

/**
 * Watches a working tree and its git directory and reports debounced changes:
 * 'status' for working-tree edits, 'all' when refs/HEAD/index change.
 */
export class RepoWatcher {
  #watchers: FSWatcher[] = []
  #poll: NodeJS.Timeout | null = null
  #timer: NodeJS.Timeout | null = null
  #pending: Kind | null = null

  constructor(
    private readonly root: string,
    private readonly gitDir: string,
    private readonly onChange: (kind: Kind) => void
  ) {}

  start(): void {
    const gitInsideRoot = !relative(this.root, this.gitDir).startsWith('..')
    this.#watch(this.root, (file) => {
      const normalized = file.split(sep).join('/')
      if (normalized === '.git' || normalized.startsWith('.git/')) {
        if (gitInsideRoot) this.#onGitPath(normalized.slice(5))
        return
      }
      this.#schedule('status')
    })
    if (!gitInsideRoot) this.#watch(this.gitDir, (file) => this.#onGitPath(file.split(sep).join('/')))
    if (parseWslPath(this.root)) this.#startPolling()
  }

  dispose(): void {
    this.#watchers.forEach((w) => w.close())
    this.#watchers = []
    if (this.#timer) clearTimeout(this.#timer)
    if (this.#poll) clearTimeout(this.#poll)
    this.#poll = null
  }

  #startPolling() {
    let last: string | null = null
    const tick = async () => {
      const stamps = await Promise.all(
        POLLED_GIT_PATHS.map((p) =>
          stat(join(this.gitDir, p)).then(
            (s) => `${s.mtimeMs}:${s.size}`,
            () => '-'
          )
        )
      )
      const now = stamps.join('|')
      if (last !== null && now !== last) this.#schedule('all')
      last = now
      if (this.#poll) this.#poll = setTimeout(tick, POLL_MS)
    }
    this.#poll = setTimeout(tick, 0)
  }

  #watch(dir: string, cb: (file: string) => void) {
    try {
      const w = watch(dir, { recursive: true }, (_event, filename) => {
        if (filename) cb(filename.toString())
        else this.#schedule('all')
      })
      w.on('error', () => {
        /* directory may disappear; ignore */
      })
      this.#watchers.push(w)
    } catch {
      /* recursive watching unsupported; the renderer still refreshes on focus */
    }
  }

  #onGitPath(rel: string) {
    if (!rel || IGNORED_GIT_PATHS.test(rel)) return
    this.#schedule('all')
  }

  #schedule(kind: Kind) {
    this.#pending = this.#pending === 'all' || kind === 'all' ? 'all' : 'status'
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = setTimeout(() => {
      const k = this.#pending
      this.#pending = null
      this.#timer = null
      if (k) this.onChange(k)
    }, 300)
  }
}
