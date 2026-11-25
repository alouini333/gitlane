// Integrated terminal state: sessions per repository, xterm.js instances kept alive while hidden.
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import { create } from 'zustand'
import { app } from './api'
import { useSettings } from './settings'
import { toast, useStore } from './store'
import { errorMessage } from './util'

export interface TermSession {
  id: number
  repo: string
  title: string
}

interface TerminalState {
  open: boolean
  height: number
  sessions: TermSession[]
  /** Active session per repository. */
  active: Record<string, number>
}

function savedHeight(): number {
  try {
    const h = Number(localStorage.getItem('gitlane.terminalHeight'))
    return h >= 120 ? h : 260
  } catch {
    return 260
  }
}

export const useTerminal = create<TerminalState>(() => ({ open: false, height: savedHeight(), sessions: [], active: {} }))
const set = useTerminal.setState
const get = useTerminal.getState

// ------------------------------------------------------------------ xterm instances

export interface TermInstance {
  term: Terminal
  fit: FitAddon
  /** Stable element xterm renders into; moved in and out of the React tree. */
  container: HTMLDivElement
  opened: boolean
  cols: number
  rows: number
}

export const instances = new Map<number, TermInstance>()

const THEME = {
  background: '#16181d',
  foreground: '#d6dbe4',
  cursor: '#58a6f5',
  cursorAccent: '#16181d',
  selectionBackground: 'rgba(88, 166, 245, 0.35)',
  black: '#3b4048',
  red: '#f0565d',
  green: '#3fb950',
  yellow: '#d9a33a',
  blue: '#58a6f5',
  magenta: '#c678dd',
  cyan: '#2ece9d',
  white: '#d6dbe4',
  brightBlack: '#5f6878',
  brightRed: '#ff7b72',
  brightGreen: '#56d364',
  brightYellow: '#e3b341',
  brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd',
  brightWhite: '#ffffff'
}

// Nerd Fonts come after the system monospace fonts so prompt icons render when one is installed.
const FALLBACK_FONTS =
  "'SF Mono', ui-monospace, Menlo, 'Symbols Nerd Font Mono', 'MesloLGS NF', 'JetBrainsMono Nerd Font', 'Hack Nerd Font', 'FiraCode Nerd Font', Consolas, monospace"

function fontFamily(): string {
  const custom = useSettings.getState().terminalFont.replace(/["']/g, '').trim()
  return custom ? `'${custom}', ${FALLBACK_FONTS}` : FALLBACK_FONTS
}

// Apply font preference changes to open terminals.
useSettings.subscribe((s, prev) => {
  if (s.terminalFont === prev.terminalFont && s.terminalFontSize === prev.terminalFontSize) return
  for (const [id, inst] of instances) {
    inst.term.options.fontFamily = fontFamily()
    inst.term.options.fontSize = s.terminalFontSize
    fitInstance(id)
  }
})

function createInstance(id: number): TermInstance {
  const term = new Terminal({
    fontFamily: fontFamily(),
    fontSize: useSettings.getState().terminalFontSize,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 10000,
    theme: THEME,
    // Option must stay a modifier for characters (e.g. @ | [ ] { } on German keyboards).
    macOptionIsMeta: false,
    allowProposedApi: false
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon((_e, uri) => void app.openExternal(uri).catch(() => undefined)))
  term.onData((data) => window.bridge.terminal.write(id, data))
  term.onTitleChange((title) => {
    if (title) set((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? { ...x, title: title.slice(0, 40) } : x)) }))
  })
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true
    // Ctrl+` toggles the panel; let the app handle it instead of sending it to the shell.
    if (e.ctrlKey && e.code === 'Backquote') return false
    if (e.metaKey) {
      const key = e.key.toLowerCase()
      if (key === 'c' && term.hasSelection()) {
        void app.copyText(term.getSelection())
        return false
      }
      if (key === 'k') {
        term.clear()
        return false
      }
      if (key === 'a') {
        term.selectAll()
        return false
      }
      return key === 'v' // paste goes through the native paste event; other Cmd shortcuts belong to the app
    }
    return true
  })
  const container = document.createElement('div')
  container.className = 'term-container'
  const inst: TermInstance = { term, fit, container, opened: false, cols: 80, rows: 24 }
  instances.set(id, inst)
  return inst
}

/** Fit the terminal to its container and tell the shell about the new size. */
export function fitInstance(id: number) {
  const inst = instances.get(id)
  if (!inst || !inst.opened || inst.container.offsetWidth === 0 || inst.container.offsetHeight === 0) return
  try {
    inst.fit.fit()
  } catch {
    return
  }
  if (inst.term.cols !== inst.cols || inst.term.rows !== inst.rows) {
    inst.cols = inst.term.cols
    inst.rows = inst.term.rows
    window.bridge.terminal.resize(id, inst.cols, inst.rows)
  }
}

let listening = false
function listen() {
  if (listening) return
  listening = true
  window.bridge.terminal.onData((id, data) => instances.get(id)?.term.write(data))
  window.bridge.terminal.onExit((id) => removeSession(id))
}

function removeSession(id: number) {
  const inst = instances.get(id)
  inst?.term.dispose()
  inst?.container.remove()
  instances.delete(id)
  set((s) => {
    const sessions = s.sessions.filter((x) => x.id !== id)
    const active = { ...s.active }
    for (const [repo, activeId] of Object.entries(active)) {
      if (activeId !== id) continue
      const next = sessions.filter((x) => x.repo === repo).at(-1)
      if (next) active[repo] = next.id
      else delete active[repo]
    }
    // Hide the panel once the repository on screen has no terminal left.
    const visibleRepo = useStore.getState().repoPath
    const open = s.open && sessions.some((x) => x.repo === visibleRepo)
    return { sessions, active, open }
  })
}

// ------------------------------------------------------------------ actions

export async function newTerminal(repo: string): Promise<void> {
  listen()
  set({ open: true })
  try {
    const { id, shell } = await window.bridge.terminal.create({ cwd: repo, cols: 100, rows: 24 })
    createInstance(id)
    const name = repo.split('/').filter(Boolean).pop() ?? repo
    set((s) => ({ sessions: [...s.sessions, { id, repo, title: `${shell} — ${name}` }], active: { ...s.active, [repo]: id } }))
  } catch (e) {
    toast('error', `Could not start a shell: ${errorMessage(e)}`)
    if (!get().sessions.some((s) => s.repo === repo)) set({ open: false })
  }
}

const starting = new Set<string>()

/** Start a shell for this repository unless it already has one (or one is starting). */
export async function ensureTerminal(repo: string): Promise<void> {
  if (starting.has(repo) || get().sessions.some((s) => s.repo === repo)) return
  starting.add(repo)
  try {
    await newTerminal(repo)
  } finally {
    starting.delete(repo)
  }
}

/** Show or hide the panel; the panel starts a shell when the repository has none. */
export function toggleTerminal(repo: string | null) {
  if (repo) set({ open: !get().open })
}

export function closeSession(id: number) {
  window.bridge.terminal.kill(id)
  removeSession(id)
}

export const selectSession = (repo: string, id: number) => set((s) => ({ active: { ...s.active, [repo]: id } }))
export const hideTerminal = () => set({ open: false })

export function setTerminalHeight(height: number) {
  const max = Math.round(window.innerHeight * 0.75)
  const h = Math.max(120, Math.min(max, Math.round(height)))
  set({ height: h })
  try {
    localStorage.setItem('gitlane.terminalHeight', String(h))
  } catch {
    /* storage unavailable */
  }
}
