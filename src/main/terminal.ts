// Integrated terminal: real shells in pseudo-terminals (node-pty), streamed to the renderer.
import { chmodSync, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import * as pty from 'node-pty'

export interface TerminalSink {
  send(channel: 'term:data' | 'term:exit', id: number, payload: string | number): void
  isDestroyed(): boolean
}

export interface CreateOptions {
  cwd: string
  cols: number
  rows: number
  /** Overrides for tests; defaults to the user's login shell. */
  shell?: string
  args?: string[]
}

interface Session {
  proc: pty.IPty
  owner: number
  sink: TerminalSink
  buffer: string
  timer: NodeJS.Timeout | null
}

let helperChecked = false

/** npm can install node-pty's spawn-helper without the executable bit, which makes every spawn fail. */
function ensureSpawnHelper() {
  if (helperChecked || process.platform === 'win32') return
  helperChecked = true
  try {
    const pkg = dirname(require.resolve('node-pty/package.json')).replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked')
    const helper = join(pkg, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
    if (existsSync(helper) && (statSync(helper).mode & 0o111) === 0) chmodSync(helper, 0o755)
  } catch {
    /* best effort; spawn reports a clear error otherwise */
  }
}

function shellEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    // Don't leak Electron/dev-tooling variables into the user's shell.
    if (v !== undefined && !k.startsWith('ELECTRON_') && !k.startsWith('GITLANE_') && k !== 'NODE_OPTIONS') env[k] = v
  }
  return {
    ...env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'Gitlane',
    LANG: env.LANG || 'en_US.UTF-8'
  }
}

export class TerminalManager {
  #sessions = new Map<number, Session>()
  #nextId = 1

  create(owner: number, sink: TerminalSink, opts: CreateOptions): { id: number; shell: string } {
    ensureSpawnHelper()
    const shell =
      opts.shell ?? (process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'))
    const args = opts.args ?? (process.platform === 'win32' ? [] : ['-l'])
    const proc = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: Math.max(2, Math.floor(opts.cols) || 80),
      rows: Math.max(1, Math.floor(opts.rows) || 24),
      cwd: opts.cwd && existsSync(opts.cwd) ? opts.cwd : homedir(),
      env: shellEnv()
    })
    const id = this.#nextId++
    const session: Session = { proc, owner, sink, buffer: '', timer: null }
    this.#sessions.set(id, session)

    // Coalesce bursts of output into fewer IPC messages.
    proc.onData((data) => {
      session.buffer += data
      if (!session.timer) session.timer = setTimeout(() => this.#flush(id), 4)
    })
    proc.onExit(({ exitCode }) => {
      this.#flush(id)
      this.#sessions.delete(id)
      if (!sink.isDestroyed()) sink.send('term:exit', id, exitCode)
    })
    return { id, shell: basename(shell) }
  }

  #flush(id: number) {
    const s = this.#sessions.get(id)
    if (!s) return
    if (s.timer) clearTimeout(s.timer)
    s.timer = null
    if (s.buffer && !s.sink.isDestroyed()) s.sink.send('term:data', id, s.buffer)
    s.buffer = ''
  }

  #get(owner: number, id: number): Session | undefined {
    const s = this.#sessions.get(id)
    return s && s.owner === owner ? s : undefined
  }

  write(owner: number, id: number, data: string) {
    this.#get(owner, id)?.proc.write(data)
  }

  resize(owner: number, id: number, cols: number, rows: number) {
    try {
      this.#get(owner, id)?.proc.resize(Math.max(2, Math.floor(cols)), Math.max(1, Math.floor(rows)))
    } catch {
      /* process may have just exited */
    }
  }

  kill(owner: number, id: number) {
    const s = this.#get(owner, id)
    if (!s) return
    this.#sessions.delete(id)
    try {
      s.proc.kill()
    } catch {
      /* already gone */
    }
  }

  killOwner(owner: number) {
    for (const [id, s] of this.#sessions) if (s.owner === owner) this.kill(owner, id)
  }

  killAll() {
    for (const [id, s] of this.#sessions) this.kill(s.owner, id)
  }
}
