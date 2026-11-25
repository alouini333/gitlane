import { spawn } from 'node:child_process'
import { delimiter } from 'node:path'

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly exitCode: number | null,
    readonly stderr: string,
    readonly stdout: string
  ) {
    super(message)
    this.name = 'GitError'
  }
}

export interface RunOptions {
  /** Written to stdin. */
  input?: string
  /** Exit codes other than 0 that count as success. */
  okCodes?: number[]
}

const EXTRA_PATHS =
  process.platform === 'win32' ? [] : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']

/** Environment for child processes: augmented PATH, no interactive prompts, English messages. */
export function childEnv(): NodeJS.ProcessEnv {
  const path = [...(process.env.PATH ?? '').split(delimiter), ...EXTRA_PATHS]
    .filter((p, i, all) => p && all.indexOf(p) === i)
    .join(delimiter)
  return {
    ...process.env,
    PATH: path,
    // Never block on an interactive prompt; fail and report instead.
    GIT_TERMINAL_PROMPT: '0',
    // Accept default messages for merge/rebase/cherry-pick --continue.
    GIT_EDITOR: 'true',
    GIT_PAGER: 'cat',
    // English messages so errors like "non-fast-forward" can be recognised.
    LC_ALL: process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8'
  }
}

/** Run `git <args>` in `cwd` and resolve with stdout. */
export function runGit(cwd: string, args: string[], opts: RunOptions = {}): Promise<string> {
  const fullArgs = ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args]
  return new Promise((resolve, reject) => {
    const child = spawn('git', fullArgs, {
      cwd,
      env: childEnv(),
      // Own session: no controlling terminal, so ssh/credential prompts fail instead of hanging.
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', (d: Buffer) => err.push(d))
    child.on('error', (e) => {
      reject(new GitError(`Could not run git: ${e.message}`, args, null, '', ''))
    })
    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString('utf8')
      const stderr = Buffer.concat(err).toString('utf8')
      if (code === 0 || (code !== null && opts.okCodes?.includes(code))) {
        resolve(stdout)
        return
      }
      const message = stderr.trim() || stdout.trim() || `git ${args[0]} exited with code ${code}`
      reject(new GitError(message, args, code, stderr, stdout))
    })
    child.stdin.on('error', () => {
      /* git may exit before reading stdin */
    })
    child.stdin.end(opts.input ?? '')
  })
}
