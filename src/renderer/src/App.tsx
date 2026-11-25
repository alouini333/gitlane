import { useEffect, useState, type CSSProperties, type MouseEvent } from 'react'
import { app } from './api'
import { openRepoDialog } from './actions'
import { DiffView } from './components/DiffView'
import { Graph, OperationBanner } from './components/Graph'
import { ContextMenu, Dialog, Picker, Toasts } from './components/Overlays'
import { PrSidebar } from './components/PrSidebar'
import { PrView } from './components/PrView'
import { SettingsDialog } from './components/Settings'
import { TerminalPanel } from './components/TerminalPanel'
import { AgentPanel } from './components/AgentPanel'
import { Icon } from './components/Icon'
import { ProvidersDialog } from './components/ProvidersDialog'
import { listenToAgent, setTab, useAgent } from './agent'
import { cls } from './util'
import { toggleTerminal } from './terminal'
import { openSettings } from './settings'
import { RightPanel } from './components/RightPanel'
import { Sidebar } from './components/Sidebar'
import { Toolbar } from './components/Toolbar'
import { Welcome } from './components/Welcome'
import { loadRecent, openRepo, refresh, useStore } from './store'

function usePersistentWidth(key: string, initial: number, min: number, max: number) {
  const [width, setWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(key))
      return saved >= min && saved <= max ? saved : initial
    } catch {
      return initial
    }
  })
  const update = (fn: (w: number) => number) =>
    setWidth((w) => {
      const next = Math.max(min, Math.min(max, fn(w)))
      try {
        localStorage.setItem(key, String(next))
      } catch {
        /* storage unavailable */
      }
      return next
    })
  return [width, update] as const
}

function Splitter({ onDrag }: { onDrag: (dx: number) => void }) {
  const start = (e: MouseEvent) => {
    e.preventDefault()
    let last = e.clientX
    const move = (ev: globalThis.MouseEvent) => {
      onDrag(ev.clientX - last)
      last = ev.clientX
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.classList.remove('resizing')
    }
    document.body.classList.add('resizing')
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  return <div className="splitter" onMouseDown={start} />
}

function RightColumn({ prOpen, hasSnap }: { prOpen: boolean; hasSnap: boolean }) {
  const tab = useAgent((s) => s.tab)
  const working = useAgent((s) => Object.values(s.running).some(Boolean))
  const waiting = useAgent((s) => s.permissions.length > 0)
  return (
    <div className="right-column">
      <div className="right-tabs">
        <button className={cls('right-tab', tab === 'details' && 'on')} onClick={() => setTab('details')}>
          {prOpen ? 'Pull request' : 'Details'}
        </button>
        <button className={cls('right-tab', tab === 'agent' && 'on')} onClick={() => setTab('agent')} title="Agent (⌘L)">
          <Icon name="comment" size={12} /> Agent
          {waiting ? <span className="tab-dot waiting" title="Waiting for your approval" /> : working ? <span className="tab-dot" title="Working" /> : null}
        </button>
      </div>
      <div className={cls('right-body', tab !== 'details' && 'hidden')}>
        {prOpen ? <PrSidebar /> : hasSnap ? <RightPanel /> : <div className="panel" />}
      </div>
      <div className={cls('right-body', tab !== 'agent' && 'hidden')}>
        <AgentPanel />
      </div>
    </div>
  )
}

let booted = false

export function App() {
  const repoPath = useStore((s) => s.repoPath)
  const hasSnap = useStore((s) => !!s.snap)
  const diffOpen = useStore((s) => !!s.diff)
  const prOpen = useStore((s) => !!s.prView)
  const [left, setLeft] = usePersistentWidth('gitlane.leftWidth', 250, 160, 480)
  const [right, setRight] = usePersistentWidth('gitlane.rightWidth', 380, 280, 720)

  useEffect(() => {
    if (booted) return
    booted = true
    listenToAgent()
    void (async () => {
      await loadRecent()
      const requested = await app.initialRepo()
      // Reopen the last repository; if it was moved or deleted, just show the welcome screen.
      if (requested) await openRepo(requested)
      else if (useStore.getState().recent[0]) await openRepo(useStore.getState().recent[0], true)
    })()
  }, [])

  useEffect(
    () =>
      window.bridge.onRepoChanged((e) => {
        if (e.path === useStore.getState().repoPath) void refresh(e.kind)
      }),
    []
  )

  useEffect(() => {
    const onFocus = () => {
      if (useStore.getState().repoPath) void refresh('all')
    }
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        void openRepoDialog()
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault()
        openSettings()
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'l' && useStore.getState().repoPath) {
        e.preventDefault()
        setTab(useAgent.getState().tab === 'agent' ? 'details' : 'agent')
      }
      if (e.ctrlKey && e.code === 'Backquote') {
        e.preventDefault()
        toggleTerminal(useStore.getState().repoPath)
      }
    }
    window.addEventListener('focus', onFocus)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  const overlays = (
    <>
      <ContextMenu />
      <Picker />
      <SettingsDialog />
      <ProvidersDialog />
      <Dialog />
      <Toasts />
    </>
  )

  if (!repoPath) {
    return (
      <>
        <Welcome />
        {overlays}
      </>
    )
  }

  return (
    <div className="app" style={{ '--left': `${left}px`, '--right': `${right}px` } as CSSProperties}>
      <Toolbar />
      <div className="main">
        <Sidebar />
        <Splitter onDrag={(dx) => setLeft((w) => w + dx)} />
        <div className="center">
          <OperationBanner />
          <div className="center-body">
            {hasSnap ? <Graph /> : <div className="empty-state">Loading repository…</div>}
            {diffOpen && <DiffView />}
            {prOpen && <PrView />}
          </div>
        </div>
        <Splitter onDrag={(dx) => setRight((w) => w - dx)} />
        <RightColumn prOpen={prOpen} hasSnap={hasSnap} />
      </div>
      <TerminalPanel />
      {overlays}
    </div>
  )
}
