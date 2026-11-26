// WSL support: path mapping and wsl.exe invocations everywhere, a stand-in wsl.exe on macOS/Linux,
// and, on Windows with GITLANE_TEST_WSL=1 (CI), real repositories inside a WSL distribution.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RepoTools } from '../src/main/ai/tools'
import { Repository, resolveRepoRoot } from '../src/main/git/repository'
import { runGit, runGitForPath } from '../src/main/git/runner'
import { TerminalManager, type TerminalSink } from '../src/main/terminal'
import { RepoWatcher } from '../src/main/watcher'
import {
  configureWsl,
  decodeWslText,
  explainWslFailure,
  parseWslPath,
  toWindowsPath,
  withWslEnv,
  wslInvocation,
  wslShell
} from '../src/main/wsl'

const realWindows = process.platform === 'win32'
// Elsewhere, behave as the Windows app would.
if (!realWindows) configureWsl({ platform: 'win32' })

async function waitFor(check: () => boolean, ms: number) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe('WSL paths', () => {
  it('recognizes \\\\wsl.localhost and \\\\wsl$ folders, in either slash style', () => {
    expect(parseWslPath('\\\\wsl.localhost\\Ubuntu\\home\\ada\\project')).toEqual({
      distro: 'Ubuntu',
      linuxPath: '/home/ada/project',
      root: '\\\\wsl.localhost\\Ubuntu'
    })
    expect(parseWslPath('\\\\wsl$\\Debian\\srv\\app\\')).toEqual({ distro: 'Debian', linuxPath: '/srv/app', root: '\\\\wsl$\\Debian' })
    expect(parseWslPath('//wsl.localhost/Ubuntu-24.04/home/ada')).toMatchObject({ distro: 'Ubuntu-24.04', linuxPath: '/home/ada' })
    expect(parseWslPath('\\\\wsl.localhost\\Ubuntu')).toMatchObject({ linuxPath: '/' })
    expect(parseWslPath('C:\\Users\\ada\\project')).toBeNull()
    expect(parseWslPath('\\\\fileserver\\share\\project')).toBeNull()
    expect(parseWslPath('/home/ada/project')).toBeNull()
  })

  it('only applies on Windows', () => {
    if (realWindows) return
    configureWsl({ platform: 'darwin' })
    try {
      expect(parseWslPath('\\\\wsl.localhost\\Ubuntu\\home')).toBeNull()
    } finally {
      configureWsl({ platform: 'win32' })
    }
  })

  it('maps Linux paths printed by git back to Windows paths', () => {
    const loc = parseWslPath('\\\\wsl.localhost\\Ubuntu\\home\\ada\\project')!
    expect(toWindowsPath(loc, '/home/ada/project\n')).toBe('\\\\wsl.localhost\\Ubuntu\\home\\ada\\project')
    expect(toWindowsPath(loc, '/home/ada/project/.git')).toBe('\\\\wsl.localhost\\Ubuntu\\home\\ada\\project\\.git')
    expect(toWindowsPath(loc, '/')).toBe('\\\\wsl.localhost\\Ubuntu\\')
    expect(toWindowsPath(loc, '/mnt/c/Users/ada/repo')).toBe('C:\\Users\\ada\\repo')
    expect(toWindowsPath(loc, '/mnt/d')).toBe('D:\\')
    expect(toWindowsPath(loc, 'relative/path')).toBe('relative/path')
  })

  it('builds wsl.exe command lines and forwards only the listed variables', () => {
    const loc = parseWslPath('\\\\wsl.localhost\\Ubuntu\\home\\ada\\my project')!
    const run = wslInvocation(loc, ['git', 'status'], { WSLENV: 'USERPROFILE/p', GIT_EDITOR: 'true', LC_ALL: 'C.UTF-8' }, ['GIT_EDITOR', 'LC_ALL', 'UNSET'])
    expect(run.args).toEqual(['-d', 'Ubuntu', '--cd', '/home/ada/my project', '--exec', 'git', 'status'])
    expect(run.env.WSLENV).toBe('USERPROFILE/p:GIT_EDITOR:LC_ALL')
    expect(run.env.WSL_UTF8).toBe('1')
    expect(withWslEnv({ WSLENV: 'GIT_EDITOR', GIT_EDITOR: 'x' }, ['GIT_EDITOR']).WSLENV).toBe('GIT_EDITOR')
    expect(wslShell(loc).args).toEqual(['-d', 'Ubuntu', '--cd', '/home/ada/my project'])
  })

  it('decodes wsl.exe messages and explains common failures', () => {
    const msg = 'There is no distribution with the supplied name.\r\n'
    expect(decodeWslText(Buffer.from('\uFEFF' + msg, 'utf16le'))).toBe(msg)
    expect(decodeWslText(Buffer.from('fatal: not a git repository', 'utf8'))).toBe('fatal: not a git repository')
    const loc = parseWslPath('\\\\wsl$\\Arch\\home\\ada')!
    expect(explainWslFailure(loc, 'git', msg)).toMatch(/"Arch" isn't installed/)
    expect(explainWslFailure(loc, 'git', '<3>WSL ERROR: execvp(git) failed: No such file or directory')).toMatch(/git isn't installed in the WSL distribution "Arch"/)
    expect(explainWslFailure(loc, 'git', 'fatal: bad revision')).toBe('fatal: bad revision')
  })
})

// A stand-in for wsl.exe: maps the distribution "Fake" onto a temp folder, passes on only the
// variables named in WSLENV (like WSL does), and prints Linux paths.
describe.skipIf(realWindows)('git through wsl.exe (stand-in)', () => {
  let root: string
  const unc = '\\\\wsl.localhost\\Fake\\work\\repo'

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'gitlane-wsl-')))
    const fake = join(root, 'fake-wsl.cjs')
    writeFileSync(
      fake,
      `#!/usr/bin/env node
const { spawnSync } = require('child_process')
const fs = require('fs')
const ROOT = ${JSON.stringify(root)}
const a = process.argv.slice(2)
let distro = null, cd = '/', exec = []
for (let i = 0; i < a.length; i++) {
  if (a[i] === '-d') distro = a[++i]
  else if (a[i] === '--cd') cd = a[++i]
  else if (a[i] === '--exec') { exec = a.slice(i + 1); break }
}
if (distro !== 'Fake') {
  process.stdout.write(Buffer.from('There is no distribution with the supplied name.\\r\\n', 'utf16le'))
  process.exit(1)
}
const env = { PATH: process.env.PATH, HOME: process.env.HOME }
for (const k of (process.env.WSLENV || '').split(':').filter(Boolean).map((s) => s.split('/')[0])) {
  if (process.env[k] !== undefined) env[k] = process.env[k]
}
const r = spawnSync(exec[0], exec.slice(1), { cwd: ROOT + cd, env, input: fs.readFileSync(0) })
process.stdout.write(r.stdout.toString().split(ROOT).join(''))
process.stderr.write(r.stderr)
process.exit(r.status ?? 1)
`
    )
    chmodSync(fake, 0o755)
    configureWsl({ executable: fake })
    const repo = join(root, 'work', 'repo')
    execFileSync('mkdir', ['-p', repo])
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo })
    git('init', '-q', '-b', 'main')
    git('config', 'user.name', 'Test')
    git('config', 'user.email', 'test@example.com')
    git('config', 'commit.gpgsign', 'false')
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    git('add', '.')
    git('commit', '-q', '-m', 'first')
  })

  afterAll(() => {
    configureWsl({ executable: 'wsl.exe' })
    rmSync(root, { recursive: true, force: true })
  })

  it('runs git in the distribution and maps the paths it prints', async () => {
    expect(await resolveRepoRoot(unc)).toBe(unc)
    expect(await runGitForPath(unc, ['rev-parse', '--absolute-git-dir'])).toBe(`${unc}\\.git`)
    expect((await runGit(unc, ['log', '--format=%s'])).trim()).toBe('first')
    // stdin reaches git, and so do the variables Gitlane relies on (GIT_EDITOR=true).
    expect((await runGit(unc, ['hash-object', '--stdin'], { input: 'hello\n' })).trim()).toBe('ce013625030ba8dba906f756967f9e9ca394464a')
    expect((await runGit(unc, ['var', 'GIT_EDITOR'])).trim()).toBe('true')
  })

  it('works with the Repository class', async () => {
    const repo = new Repository(unc)
    writeFileSync(join(root, 'work', 'repo', 'a.txt'), 'two\n')
    expect((await repo.status()).unstaged.map((f) => f.path)).toEqual(['a.txt'])
    await repo.stageAll()
    await repo.commit('second', false)
    expect((await repo.snapshot(10)).commits.map((c) => c.subject)).toEqual(['second', 'first'])
  })

  it('reports a missing distribution clearly', async () => {
    await expect(runGit('\\\\wsl.localhost\\Nope\\home', ['status'])).rejects.toThrow(/"Nope" isn't installed/)
  })
})

// The real thing: Windows with a WSL distribution that has git (see the "Windows + WSL" CI job).
describe.runIf(realWindows && process.env.GITLANE_TEST_WSL === '1')('repositories inside WSL (Windows)', () => {
  const wsl = (distro: string | null, script: string) =>
    execFileSync('wsl.exe', [...(distro ? ['-d', distro] : []), '--exec', 'sh', '-c', script], { env: { ...process.env, WSL_UTF8: '1' } }).toString()
  let distro: string
  let unc: string

  beforeAll(() => {
    distro =
      process.env.GITLANE_TEST_WSL_DISTRO ||
      decodeWslText(execFileSync('wsl.exe', ['--list', '--quiet'])).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
    wsl(
      distro,
      'rm -rf /tmp/gitlane-wsl && mkdir -p /tmp/gitlane-wsl && cd /tmp/gitlane-wsl && git init -q -b main && ' +
        'git config user.name Test && git config user.email test@example.com && git config commit.gpgsign false && ' +
        'printf "one\\n" > a.txt && git add . && git commit -qm first'
    )
    const modern = `\\\\wsl.localhost\\${distro}\\tmp\\gitlane-wsl`
    unc = existsSync(modern) ? modern : `\\\\wsl$\\${distro}\\tmp\\gitlane-wsl`
  }, 120_000)

  it('opens the repository and runs git inside the distribution', async () => {
    expect(await resolveRepoRoot(unc)).toBe(unc)
    const repo = new Repository(unc)
    expect((await repo.status()).branch).toBe('main')
    // Edit through the Windows path, commit through WSL git.
    writeFileSync(join(unc, 'a.txt'), 'two\n')
    expect((await repo.status()).unstaged.map((f) => f.path)).toEqual(['a.txt'])
    await repo.stageAll()
    await repo.commit('second', false)
    expect((await repo.snapshot(10)).commits.map((c) => c.subject)).toEqual(['second', 'first'])
    expect(wsl(distro, 'cd /tmp/gitlane-wsl && git log -1 --format=%s').trim()).toBe('second')
  }, 120_000)

  it('notices commits made inside WSL', async () => {
    const gitDir = await runGitForPath(unc, ['rev-parse', '--absolute-git-dir'])
    expect(readFileSync(join(gitDir, 'HEAD'), 'utf8')).toContain('refs/heads/main')
    let changed = false
    const watcher = new RepoWatcher(unc, gitDir, (kind) => kind === 'all' && (changed = true))
    watcher.start()
    try {
      await new Promise((r) => setTimeout(r, 2500))
      wsl(distro, 'cd /tmp/gitlane-wsl && git commit -q --allow-empty -m third')
      await waitFor(() => changed, 15_000)
    } finally {
      watcher.dispose()
    }
  }, 60_000)

  it('gives the agent the repository files and a Linux shell', async () => {
    const tools = new RepoTools(unc)
    const signal = new AbortController().signal
    expect((await tools.prepare('read_file', { path: 'a.txt' }).run(signal)).content).toContain('two')
    const run = await tools.prepare('run_command', { command: 'pwd && uname -s && git rev-parse --abbrev-ref HEAD' }).run(signal)
    expect(run.isError).toBe(false)
    expect(run.content).toContain('/tmp/gitlane-wsl')
    expect(run.content).toContain('Linux')
    expect(run.content).toContain('main')
  }, 60_000)

  it('starts the integrated terminal in the distribution', async () => {
    const mgr = new TerminalManager()
    // Collects one session's output; on timeout, the error shows what the terminal printed.
    const run = async (opts: { cwd: string; shell?: string; args?: string[] }, input: string, expected: RegExp[]) => {
      const events: string[] = []
      const exits: number[] = []
      const sink: TerminalSink = {
        send: (channel, _id, payload) => void (channel === 'term:data' ? events.push(String(payload)) : exits.push(Number(payload))),
        isDestroyed: () => false
      }
      const session = mgr.create(1, sink, { cols: 100, rows: 30, ...opts })
      try {
        await new Promise((r) => setTimeout(r, 1500))
        mgr.write(1, session.id, input)
        await waitFor(() => expected.every((re) => re.test(events.join(''))), 30_000).catch(() => {
          throw new Error(`Expected ${expected.join(', ')}; exit ${JSON.stringify(exits)}; output: ${JSON.stringify(events.join('').slice(-2000))}`)
        })
      } finally {
        mgr.kill(1, session.id)
      }
      return session
    }
    // Baseline: a Windows shell in a pseudo-terminal.
    await run({ cwd: process.cwd(), shell: 'cmd.exe', args: [] }, 'echo PTY_%OS%\r', [/PTY_Windows_NT/])
    const session = await run({ cwd: unc }, 'echo "WSL_$(uname -s)"; pwd\r', [/WSL_Linux/, /\/tmp\/gitlane-wsl/])
    expect(session.shell).toBe(distro)
  }, 90_000)
})
