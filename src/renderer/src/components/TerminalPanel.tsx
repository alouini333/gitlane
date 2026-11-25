import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef, type MouseEvent } from 'react'
import { openInTerminal } from '../actions'
import { useStore } from '../store'
import {
  closeSession,
  ensureTerminal,
  fitInstance,
  hideTerminal,
  instances,
  newTerminal,
  selectSession,
  setTerminalHeight,
  useTerminal
} from '../terminal'
import { cls } from '../util'
import { Icon } from './Icon'

function TermView({ id, visible }: { id: number; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const inst = instances.get(id)
    const el = host.current
    if (!inst || !el) return
    el.appendChild(inst.container)
    if (!inst.opened) {
      inst.term.open(inst.container)
      inst.opened = true
    }
    const ro = new ResizeObserver(() => fitInstance(id))
    ro.observe(el)
    return () => {
      ro.disconnect()
      inst.container.remove()
    }
  }, [id])

  useEffect(() => {
    if (!visible) return
    requestAnimationFrame(() => {
      fitInstance(id)
      instances.get(id)?.term.focus()
    })
  }, [visible, id])

  return <div ref={host} className="term-host" style={{ display: visible ? 'block' : 'none' }} />
}

export function TerminalPanel() {
  const { open, height, sessions, active } = useTerminal()
  const repo = useStore((s) => s.repoPath)
  const mine = sessions.filter((s) => s.repo === repo)
  const current = repo ? active[repo] : undefined

  // Opening the panel on a repository without a shell starts one.
  useEffect(() => {
    if (open && repo && mine.length === 0) void ensureTerminal(repo)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, repo])

  if (!open || !repo) return null

  const startResize = (e: MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = height
    const move = (ev: globalThis.MouseEvent) => setTerminalHeight(startH + (startY - ev.clientY))
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.classList.remove('resizing-v')
    }
    document.body.classList.add('resizing-v')
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return (
    <div className="terminal-panel" style={{ height }}>
      <div className="terminal-resize" onMouseDown={startResize} />
      <div className="terminal-bar">
        <span className="terminal-label">
          <Icon name="terminal" size={13} /> TERMINAL
        </span>
        <div className="term-tabs">
          {mine.map((s) => (
            <div key={s.id} className={cls('term-tab', s.id === current && 'on')} onClick={() => selectSession(repo, s.id)} title={s.title}>
              <span className="term-tab-title">{s.title}</span>
              <button
                className="term-tab-close"
                title="Kill terminal"
                onClick={(e) => {
                  e.stopPropagation()
                  closeSession(s.id)
                }}
              >
                <Icon name="close" size={10} />
              </button>
            </div>
          ))}
        </div>
        <span className="spacer" />
        <button className="icon-btn" title="New terminal" onClick={() => newTerminal(repo)}>
          <Icon name="plus" size={13} />
        </button>
        <button className="icon-btn" title="Open in Terminal.app" onClick={openInTerminal}>
          <Icon name="external" size={13} />
        </button>
        <button className="icon-btn" title="Hide panel (Ctrl+`)" onClick={hideTerminal}>
          <Icon name="chevronDown" size={13} />
        </button>
      </div>
      <div className="terminal-body">
        {mine.map((s) => (
          <TermView key={s.id} id={s.id} visible={s.id === current} />
        ))}
      </div>
    </div>
  )
}
