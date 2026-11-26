import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { BrowserWindow, app, clipboard, dialog, ipcMain, net, safeStorage, shell, type WebContents } from 'electron'
import type { ApiResult, AppApi, RepoChangeEvent } from '../shared/types'
import { REPO_METHODS, Repository, resolveRepoRoot } from './git/repository'
import { runGit, runGitForPath } from './git/runner'
import { parseWslPath, wslShell } from './wsl'
import { setFetch } from './github'
import { TerminalManager } from './terminal'
import type { AgentApi, AgentEvent, PermissionMode, ProviderId } from '../shared/agent'
import { AgentService, ChatStore } from './ai/agent'
import { setAiFetch } from './ai/http'
import { signInWithOpenRouter } from './ai/oauth'
import { CredentialStore, PROVIDER_IDS, ProviderRegistry } from './ai/providers'
import { RepoWatcher } from './watcher'

// ------------------------------------------------------------------ recent repositories

const MAX_RECENT = 15
const recentFile = () => join(app.getPath('userData'), 'recent-repos.json')

async function loadRecent(): Promise<string[]> {
  try {
    const list = JSON.parse(await readFile(recentFile(), 'utf8'))
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string') : []
  } catch {
    return []
  }
}

async function saveRecent(list: string[]): Promise<string[]> {
  const trimmed = list.slice(0, MAX_RECENT)
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(recentFile(), JSON.stringify(trimmed, null, 2))
  return trimmed
}

async function rememberRepo(path: string) {
  const list = await loadRecent()
  await saveRecent([path, ...list.filter((p) => p !== path)])
}

// ------------------------------------------------------------------ repository sessions

/** Repositories the renderer opened; repo calls for other paths are refused. */
const openedRepos = new Set<string>()
const watchers = new Map<number, RepoWatcher>()

async function activateRepo(sender: WebContents, path: string): Promise<string> {
  const root = await resolveRepoRoot(path)
  openedRepos.add(root)
  await rememberRepo(root)

  watchers.get(sender.id)?.dispose()
  const gitDir = await runGitForPath(root, ['rev-parse', '--absolute-git-dir'])
  const watcher = new RepoWatcher(root, gitDir, (kind) => {
    if (sender.isDestroyed()) return
    const event: RepoChangeEvent = { path: root, kind }
    sender.send('repo-changed', event)
  })
  watcher.start()
  watchers.set(sender.id, watcher)
  sender.once('destroyed', () => {
    watchers.get(sender.id)?.dispose()
    watchers.delete(sender.id)
  })
  return root
}

function openTerminal(path: string) {
  const opts = { detached: true, stdio: 'ignore' as const }
  const wsl = parseWslPath(path)
  // A detached console program gets its own window on Windows.
  if (wsl) spawn(wslShell(wsl).file, wslShell(wsl).args, opts).unref()
  else if (process.platform === 'darwin') spawn('open', ['-a', 'Terminal', path], opts).unref()
  else if (process.platform === 'win32') spawn('cmd.exe', ['/c', 'start', 'cmd.exe'], { ...opts, cwd: path }).unref()
  else spawn('x-terminal-emulator', [], { ...opts, cwd: path }).unref()
}

type Handlers = { [K in keyof AppApi]: (sender: WebContents, ...args: Parameters<AppApi[K]>) => ReturnType<AppApi[K]> }

const appHandlers: Handlers = {
  async initialRepo() {
    return process.env.GITLANE_OPEN ?? null
  },
  recentRepos: () => loadRecent(),
  async forgetRepo(_sender, path) {
    return saveRecent((await loadRecent()).filter((p) => p !== path))
  },
  async pickDirectory(sender, title) {
    const win = BrowserWindow.fromWebContents(sender)
    const options = { title, properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> }
    const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return res.canceled ? null : (res.filePaths[0] ?? null)
  },
  openRepo: (sender, path) => activateRepo(sender, path),
  async initRepo(sender, path) {
    await runGit(path, ['init'])
    return activateRepo(sender, path)
  },
  async cloneRepo(sender, url, parentDir) {
    const name = url.trim().replace(/[/\\]+$/, '').split(/[/\\:]/).pop()?.replace(/\.git$/, '') || 'repository'
    const dest = join(parentDir, name)
    if (existsSync(dest)) throw new Error(`${dest} already exists`)
    await runGit(parentDir, ['clone', '--', url.trim(), name])
    return activateRepo(sender, dest)
  },
  async openTerminal(_sender, path) {
    openTerminal(path)
  },
  async openPath(_sender, path) {
    const err = await shell.openPath(path)
    if (err) throw new Error(err)
  },
  async revealPath(_sender, path) {
    shell.showItemInFolder(path)
  },
  async copyText(_sender, text) {
    clipboard.writeText(text)
  },
  async openExternal(_sender, url) {
    if (!/^https?:\/\//.test(url)) throw new Error('Only web links can be opened')
    await shell.openExternal(url)
  }
}

async function wrap(fn: () => unknown): Promise<ApiResult<unknown>> {
  try {
    return { ok: true, value: await fn() }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

ipcMain.handle('app', (event, method: string, args: unknown[]) =>
  wrap(() => {
    if (!Object.hasOwn(appHandlers, method)) throw new Error(`Unknown method: ${method}`)
    const handler = appHandlers[method as keyof AppApi] as (sender: WebContents, ...a: unknown[]) => unknown
    return handler(event.sender, ...args)
  })
)

ipcMain.handle('repo', (_event, path: string, method: string, args: unknown[]) =>
  wrap(() => {
    if (!openedRepos.has(path)) throw new Error(`Repository not opened: ${path}`)
    if (!REPO_METHODS.has(method)) throw new Error(`Unknown method: ${method}`)
    const repo = new Repository(path) as unknown as Record<string, (...a: unknown[]) => unknown>
    return repo[method](...args)
  })
)

// ------------------------------------------------------------------ integrated terminal

const terminals = new TerminalManager()
const terminalOwners = new Set<number>()

ipcMain.handle('term:create', (event, opts: { cwd: string; cols: number; rows: number }) => {
  const sender = event.sender
  if (!terminalOwners.has(sender.id)) {
    terminalOwners.add(sender.id)
    const ownerId = sender.id
    sender.once('destroyed', () => {
      terminals.killOwner(ownerId)
      terminalOwners.delete(ownerId)
    })
  }
  // Shells start in an opened repository (or the home folder).
  const cwd = openedRepos.has(opts.cwd) ? opts.cwd : app.getPath('home')
  return terminals.create(sender.id, sender, { cwd, cols: opts.cols, rows: opts.rows })
})
ipcMain.on('term:write', (event, id: number, data: string) => terminals.write(event.sender.id, id, data))
ipcMain.on('term:resize', (event, id: number, cols: number, rows: number) => terminals.resize(event.sender.id, id, cols, rows))
ipcMain.on('term:kill', (event, id: number) => terminals.kill(event.sender.id, id))
app.on('before-quit', () => terminals.killAll())

// ------------------------------------------------------------------ coding agent

let agentService: AgentService | null = null
let providerRegistry: ProviderRegistry | null = null

function agent() {
  if (!agentService || !providerRegistry) {
    const cipher = {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (plain: string) => safeStorage.encryptString(plain).toString('base64'),
      decrypt: (stored: string) => safeStorage.decryptString(Buffer.from(stored, 'base64'))
    }
    providerRegistry = new ProviderRegistry(new CredentialStore(join(app.getPath('userData'), 'ai-credentials.json'), cipher))
    agentService = new AgentService(new ChatStore(join(app.getPath('userData'), 'agent-chats')), providerRegistry)
  }
  return { service: agentService, providers: providerRegistry }
}

const isProvider = (id: unknown): id is ProviderId => typeof id === 'string' && (PROVIDER_IDS as string[]).includes(id)

function requireRepo(repo: string) {
  if (!openedRepos.has(repo)) throw new Error('Open the repository first.')
}

type AgentHandlers = { [K in keyof AgentApi]: (sender: WebContents, ...args: Parameters<AgentApi[K]>) => ReturnType<AgentApi[K]> }

const agentHandlers: AgentHandlers = {
  async providers() {
    return agent().providers.statuses()
  },
  async connect(_s, id, cred) {
    if (!isProvider(id)) throw new Error('Unknown provider.')
    await agent().providers.connect(id, cred)
    return agent().providers.statuses()
  },
  async disconnect(_s, id) {
    if (!isProvider(id)) throw new Error('Unknown provider.')
    agent().providers.disconnect(id)
    return agent().providers.statuses()
  },
  async signInOpenRouter() {
    const key = await signInWithOpenRouter((url) => shell.openExternal(url))
    agent().providers.saveVerified('openrouter', { apiKey: key, baseUrl: 'https://openrouter.ai/api/v1' })
    return agent().providers.statuses()
  },
  async models(_s, id) {
    if (!isProvider(id)) throw new Error('Unknown provider.')
    return agent().providers.models(id)
  },
  async chats(_s, repo) {
    requireRepo(repo)
    return agent().service.store.list(repo)
  },
  async chat(_s, id) {
    return agent().service.store.get(id)
  },
  async newChat(_s, repo, mode: PermissionMode) {
    requireRepo(repo)
    return agent().service.newChat(repo, mode)
  },
  async deleteChat(_s, id) {
    agent().service.stop(id)
    agent().service.store.delete(id)
  },
  async setMode(_s, chatId, mode) {
    return agent().service.setMode(chatId, mode)
  },
  async send(sender, chatId, text, options) {
    const { service } = agent()
    const chat = service.store.get(chatId)
    if (!chat) throw new Error('Chat not found.')
    requireRepo(chat.repo)
    if (!isProvider(options.provider)) throw new Error('Unknown provider.')
    if (service.isRunning(chatId)) throw new Error('The agent is already working in this chat.')
    const host = { send: (e: AgentEvent) => !sender.isDestroyed() && sender.send('agent:event', e) }
    // Runs in the background; progress, results and errors arrive as events.
    void service.send(host, chatId, text, options)
  },
  async stop(_s, chatId) {
    agent().service.stop(chatId)
  },
  async respond(sender, requestId, decision, message) {
    agent().service.respond({ send: (e: AgentEvent) => !sender.isDestroyed() && sender.send('agent:event', e) }, requestId, decision, message)
  }
}

ipcMain.handle('agent', (event, method: string, args: unknown[]) =>
  wrap(() => {
    if (!Object.hasOwn(agentHandlers, method)) throw new Error(`Unknown method: ${method}`)
    const handler = agentHandlers[method as keyof AgentApi] as (sender: WebContents, ...a: unknown[]) => unknown
    return handler(event.sender, ...args)
  })
)

// ------------------------------------------------------------------ environment

/** Apps started from Finder get a minimal PATH; borrow the login shell's so git hooks find node etc. */
async function loadShellPath() {
  if (process.platform === 'win32') return
  const shellPath = process.env.SHELL || '/bin/zsh'
  const out = await new Promise<string>((resolve) => {
    execFile(shellPath, ['-ilc', 'printf "__GL__%s__GL__" "$PATH"'], { timeout: 5000 }, (_err, stdout) =>
      resolve(stdout ?? '')
    )
  })
  const match = /__GL__(.*)__GL__/s.exec(out)
  if (match) {
    const merged = [...match[1].split(delimiter), ...(process.env.PATH ?? '').split(delimiter)]
    process.env.PATH = merged.filter((p, i) => p && merged.indexOf(p) === i).join(delimiter)
  }
}

// ------------------------------------------------------------------ window

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

function createWindow() {
  const capture = process.env.GITLANE_CAPTURE
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'Gitlane',
    backgroundColor: '#1b1d23',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 15 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Screenshots need fresh frames even when the window is behind others.
      backgroundThrottling: !capture
    }
  })

  win.once('ready-to-show', () => (capture ? win.showInactive() : win.show()))
  // Links inside rendered PR comments must never navigate the app window itself.
  win.webContents.on('will-navigate', (e, url) => {
    const own = process.env.ELECTRON_RENDERER_URL ?? 'file://'
    if (url.startsWith(own)) return
    e.preventDefault()
    if (/^https?:/.test(url)) void shell.openExternal(url)
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.GITLANE_DEBUG) {
    win.webContents.on('console-message', (e) => console.log(`[renderer:${e.level}] ${e.message}`))
  }

  // Dev helper: GITLANE_CAPTURE=out.png renders the app, optionally runs GITLANE_CAPTURE_SCRIPT, saves a screenshot and quits.
  if (capture) {
    win.webContents.once('did-finish-load', async () => {
      await delay(Number(process.env.GITLANE_CAPTURE_DELAY ?? 2500))
      const script = process.env.GITLANE_CAPTURE_SCRIPT
      if (script) {
        try {
          await win.webContents.executeJavaScript(script)
        } catch (e) {
          console.error('capture script failed', e)
        }
        await delay(1500)
      }
      const image = await win.webContents.capturePage()
      await writeFile(capture, image.toPNG())
      app.quit()
    })
  }

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.setName('Gitlane')
// Isolated profile for dev/test runs (keeps recent-repos of the real profile untouched).
if (process.env.GITLANE_USER_DATA) app.setPath('userData', process.env.GITLANE_USER_DATA)

app.whenReady().then(async () => {
  if (app.isPackaged) await loadShellPath()
  // Use Chromium's network stack for GitHub requests (respects system proxy settings).
  setFetch((url, init) => net.fetch(url, init))
  setAiFetch((url, init) => net.fetch(url, init))
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || process.env.GITLANE_CAPTURE) app.quit()
})

