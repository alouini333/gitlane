import type { MouseEvent, ReactNode } from 'react'
import * as A from '../actions'
import { createPullRequestDialog } from '../prActions'
import { openSettings } from '../settings'
import { toggleTerminal, useTerminal } from '../terminal'
import { setTab, useAgent } from '../agent'
import { closeRepo, openRepo, refresh, showMenu, useStore, type MenuItem } from '../store'
import { cls, repoName } from '../util'
import { Icon } from './Icon'

function ToolButton(props: {
  icon: string
  label: string
  onClick: (e: MouseEvent) => void
  disabled?: boolean
  badge?: ReactNode
  title?: string
  active?: boolean
  onContextMenu?: (e: MouseEvent) => void
}) {
  return (
    <button
      className={cls('tool-btn', props.active && 'active')}
      onClick={props.onClick}
      onContextMenu={props.onContextMenu}
      disabled={props.disabled}
      title={props.title ?? props.label}
    >
      <span className="tool-icon">
        <Icon name={props.icon} size={18} />
        {props.badge}
      </span>
      <span className="tool-label">{props.label}</span>
    </button>
  )
}

export function Toolbar() {
  const repoPath = useStore((s) => s.repoPath)!
  const recent = useStore((s) => s.recent)
  const status = useStore((s) => s.snap?.status)
  const stashCount = useStore((s) => s.snap?.stashes.length ?? 0)
  const busy = useStore((s) => s.busy)
  const hasGitHub = useStore((s) => !!s.github?.info)
  const terminalOpen = useTerminal((s) => s.open)
  const agentOpen = useAgent((s) => s.tab === 'agent')

  const repoMenu = (e: MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const items: MenuItem[] = [
      ...recent
        .filter((p) => p !== repoPath)
        .slice(0, 10)
        .map((p) => ({ label: repoName(p), action: () => openRepo(p) })),
      { separator: true },
      { label: 'Open repository…', action: A.openRepoDialog },
      { label: 'Clone repository…', action: A.cloneRepoDialog },
      { label: 'Init repository…', action: A.initRepoDialog },
      { separator: true },
      { label: 'Close repository', action: closeRepo }
    ]
    showMenu({ clientX: rect.left, clientY: rect.bottom + 4 }, items)
  }

  const pullMenu = (e: MouseEvent) => {
    e.stopPropagation()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    showMenu({ clientX: rect.left, clientY: rect.bottom + 4 }, [
      { label: 'Fetch all', action: A.fetchAll },
      { label: 'Pull (fast-forward if possible)', action: () => A.pull('merge') },
      { label: 'Pull (fast-forward only)', action: () => A.pull('ff-only') },
      { label: 'Pull (rebase)', action: () => A.pull('rebase') }
    ])
  }

  const counter = (n: number, up: boolean) =>
    n > 0 ? <span className={cls('tool-badge', up ? 'up' : 'down')}>{n}</span> : null

  return (
    <header className="toolbar">
      <div className="toolbar-left">
        <button className="repo-switch" onClick={repoMenu} title={repoPath}>
          <span className="repo-switch-label">repository</span>
          <span className="repo-switch-name">
            {repoName(repoPath)} <Icon name="chevronDown" size={11} />
          </span>
        </button>
        <div className="branch-indicator" title="Current branch">
          <span className="repo-switch-label">branch</span>
          <span className="repo-switch-name">
            <Icon name="branch" size={12} /> {status ? (status.branch ?? `detached @ ${status.head?.slice(0, 7) ?? '?'}`) : '…'}
          </span>
        </div>
      </div>

      <div className="toolbar-center">
        <ToolButton icon="fetch" label="Fetch" onClick={A.fetchAll} />
        <div className="split-btn">
          <ToolButton icon="pull" label="Pull" onClick={() => A.pull('merge')} badge={counter(status?.behind ?? 0, false)} />
          <button className="split-caret" onClick={pullMenu} title="Pull options">
            <Icon name="chevronDown" size={10} />
          </button>
        </div>
        <ToolButton icon="push" label="Push" onClick={() => A.pushCurrent()} badge={counter(status?.ahead ?? 0, true)} />
        <span className="toolbar-sep" />
        <ToolButton icon="branch" label="Branch" onClick={() => status?.head && A.createBranchAt('HEAD', status.branch ?? 'HEAD')} disabled={!status?.head} />
        <ToolButton icon="stash" label="Stash" onClick={A.stashChanges} />
        <ToolButton icon="pop" label="Pop" onClick={() => A.popStash()} disabled={stashCount === 0} />
        {hasGitHub && (
          <ToolButton icon="pr" label="Pull Request" onClick={() => createPullRequestDialog()} title="Create a pull request for the current branch" />
        )}
        <span className="toolbar-sep" />
        <ToolButton icon="comment" label="Agent" title="Coding agent (⌘L)" active={agentOpen} onClick={() => setTab(agentOpen ? 'details' : 'agent')} />
        <ToolButton
          icon="terminal"
          label="Terminal"
          onClick={() => toggleTerminal(repoPath)}
          title="Show or hide the terminal (Ctrl+`). Right-click for Terminal.app"
          active={terminalOpen}
          onContextMenu={(e) => showMenu(e, [{ label: 'Open in Terminal.app', action: A.openInTerminal }])}
        />
      </div>

      <div className="toolbar-right">
        {busy && (
          <span className="busy">
            <span className="spinner" /> {busy}
          </span>
        )}
        <button className="icon-btn" title="Refresh" onClick={() => refresh('all')}>
          <Icon name="refresh" size={15} />
        </button>
        <button className="icon-btn" title="Preferences (⌘,)" onClick={openSettings}>
          <Icon name="gear" size={15} />
        </button>
      </div>
    </header>
  )
}
