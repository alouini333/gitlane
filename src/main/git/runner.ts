import { spawn } from 'node:child_process'
import { delimiter } from 'node:path'
import { decodeWslText, explainWslFailure, parseWslPath, toWindowsPath, wslInvocation } from '../wsl'

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

/** Variables from childEnv() that git inside WSL needs too. */
const WSL_GIT_ENV = ['GIT_TERMINAL_PROMPT', 'GIT_EDITOR', 'GIT_PAGER', 'LC_ALL']

/**
 * Run `git <args>` in `cwd` and resolve with stdout. For a folder inside WSL (\\wsl.localhost\…),
 * git runs in that distribution through wsl.exe.
 */
export function runGit(cwd: string, args: string[], opts: RunOptions = {}): Promise<string> {
  const fullArgs = ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args]
  const wsl = parseWslPath(cwd)
  const run = wsl ? wslInvocation(wsl, ['git', ...fullArgs], childEnv(), WSL_GIT_ENV) : { file: 'git', args: fullArgs, env: childEnv() }
  return new Promise((resolve, reject) => {
    const child = spawn(run.file, run.args, {
      // wsl.exe changes directory itself (--cd); Windows can't start a process in a UNC folder.
      cwd: wsl ? undefined : cwd,
      env: run.env,
      // Own session: no controlling terminal, so ssh/credential prompts fail instead of hanging.
      detached: process.platform !== 'win32',
      // No console window flashing up on Windows for every git call.
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', (d: Buffer) => err.push(d))
    child.on('error', (e) => {
      reject(new GitError(`Could not run ${wsl ? 'wsl.exe' : 'git'}: ${e.message}`, args, null, '', ''))
    })
    child.on('close', (code) => {
      if (code === 0 || (code !== null && opts.okCodes?.includes(code))) {
        resolve(Buffer.concat(out).toString('utf8'))
        return
      }
      const decode = (b: Buffer[]) => (wsl ? decodeWslText(Buffer.concat(b)) : Buffer.concat(b).toString('utf8'))
      const stdout = decode(out)
      const stderr = decode(err)
      let message = stderr.trim() || stdout.trim() || `git ${args[0]} exited with code ${code}`
      if (wsl) message = explainWslFailure(wsl, 'git', message)
      reject(new GitError(message, args, code, stderr, stdout))
    })
    child.stdin.on('error', () => {
      /* git may exit before reading stdin */
    })
    child.stdin.end(opts.input ?? '')
  })
}

/** Run git for a path it prints (e.g. `rev-parse --show-toplevel`), returned in a form this OS can open. */
export async function runGitForPath(cwd: string, args: string[]): Promise<string> {
  const out = (await runGit(cwd, args)).trim()
  const wsl = parseWslPath(cwd)
  return wsl && out ? toWindowsPath(wsl, out) : out
}
