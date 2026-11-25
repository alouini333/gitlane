import { watch, type FSWatcher } from 'node:fs'
import { relative, sep } from 'node:path'

type Kind = 'status' | 'all'

// Files inside .git whose changes don't affect what we display.
const IGNORED_GIT_PATHS = /^(objects|logs|hooks|lfs|fsmonitor--daemon)(\/|$)|\.lock$|^FETCH_HEAD$|^gc\.pid$/

/**
 * Watches a working tree and its git directory and reports debounced changes:
 * 'status' for working-tree edits, 'all' when refs/HEAD/index change.
 */
export class RepoWatcher {
  #watchers: FSWatcher[] = []
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
  }

  dispose(): void {
    this.#watchers.forEach((w) => w.close())
    this.#watchers = []
    if (this.#timer) clearTimeout(this.#timer)
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
