import { useEffect, useState, type MouseEvent } from 'react'
import type { DiffTarget, FileChange } from '../../../shared/types'
import { repoApi } from '../api'
import * as A from '../actions'
import { commitFileMenu, stashMenu, wipFileMenu, type WipFileKind } from '../menus'
import { openDiff, selectSha, setDraft, showMenu, useStore } from '../store'
import { basename, cls, dirname, formatDate, hashColor, initials, plural, relativeTime, shortSha } from '../util'
import { Icon } from './Icon'
import { PullRequestSection } from './PullRequests'

// ------------------------------------------------------------------ file list

const STATUS_LABEL: Record<string, string> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  T: 'Type changed',
  U: 'Conflicted',
  '?': 'Untracked'
}

export function StatusBadge({ status }: { status: string }) {
  const letter = status === '?' ? 'A' : status === 'U' ? '!' : status
  return (
    <span className={cls('status-badge', `st-${status === '?' ? 'A' : status}`)} title={STATUS_LABEL[status]}>
      {letter}
    </span>
  )
}

interface FileRowProps {
  file: FileChange
  active: boolean
  onOpen: () => void
  onMenu: (e: MouseEvent) => void
  action?: { label: string; run: () => void }
}

function FileRow({ file, active, onOpen, onMenu, action }: FileRowProps) {
  const dir = dirname(file.path)
  return (
    <div
      className={cls('file-row', active && 'active')}
      onClick={onOpen}
      onContextMenu={onMenu}
      title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
    >
      <StatusBadge status={file.status} />
      <span className="file-name">{basename(file.path)}</span>
      {dir && <span className="file-dir">{dir}</span>}
      {action && (
        <button
          className="file-action"
          onClick={(e) => {
            e.stopPropagation()
            action.run()
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  )
}

const MAX_FILES = 1500

function isActive(target: DiffTarget | undefined, kind: string, path: string, sha?: string) {
  if (!target || target.kind !== kind || target.path !== path) return false
  return target.kind !== 'commit' || target.sha === sha
}

function WipFileList({ files, kind }: { files: FileChange[]; kind: WipFileKind }) {
  const target = useStore((s) => s.diff?.target)
  const diffKind = kind === 'staged' ? 'staged' : 'unstaged'
  return (
    <div className="file-list">
      {files.slice(0, MAX_FILES).map((f) => (
        <FileRow
          key={f.path}
          file={f}
          active={isActive(target, diffKind, f.path)}
          onOpen={() =>
            openDiff(
              kind === 'staged'
                ? { kind: 'staged', path: f.path, oldPath: f.oldPath }
                : { kind: 'unstaged', path: f.path, untracked: f.status === '?', conflicted: kind === 'conflicted' }
            )
          }
          onMenu={(e) => showMenu(e, wipFileMenu(f, kind))}
          action={
            kind === 'staged'
              ? { label: 'Unstage', run: () => A.unstageFiles([f]) }
              : kind === 'conflicted'
                ? { label: 'Mark resolved', run: () => A.stageFiles([f]) }
                : { label: 'Stage', run: () => A.stageFiles([f]) }
          }
        />
      ))}
      {files.length > MAX_FILES && <div className="file-more">…and {files.length - MAX_FILES} more</div>}
    </div>
  )
}

// ------------------------------------------------------------------ WIP panel

function WipPanel() {
  const status = useStore((s) => s.snap!.status)
  const repoPath = useStore((s) => s.repoPath)!
  const draft = useStore((s) => s.draft)
  const { staged, unstaged, conflicted, operation } = status

  // Prefill the message git prepared for a merge / cherry-pick / revert.
  useEffect(() => {
    if (operation === 'none' || useStore.getState().draft.summary) return
    void repoApi(repoPath)
      .pendingMessage()
      .then((msg) => {
        if (!msg || useStore.getState().draft.summary) return
        const [summary, ...rest] = msg.split('\n')
        setDraft({ summary, description: rest.join('\n').trim() })
      })
  }, [operation, repoPath])

  const toggleAmend = async (amend: boolean) => {
    setDraft({ amend })
    if (amend && !draft.summary.trim()) {
      const msg = await repoApi(repoPath).lastCommitMessage()
      const [summary, ...rest] = msg.split('\n')
      setDraft({ summary, description: rest.join('\n').trim() })
    }
  }

  const blockedByRebase = operation === 'rebase'
  const canCommit =
    !!draft.summary.trim() && (staged.length > 0 || draft.amend) && conflicted.length === 0 && !blockedByRebase
  const buttonLabel = blockedByRebase
    ? 'Use “Continue” to proceed with the rebase'
    : conflicted.length
      ? 'Resolve conflicts to commit'
      : draft.amend
        ? 'Amend previous commit'
        : staged.length
          ? `Commit changes to ${plural(staged.length, 'file')}`
          : 'Stage files to commit'

  return (
    <div className="panel wip-panel">
      <div className="panel-title">
        <span>
          {plural(staged.length + unstaged.length + conflicted.length, 'file')} changed on{' '}
          <strong>{status.branch ?? 'detached HEAD'}</strong>
        </span>
        <button className="icon-btn" title="Discard all changes" onClick={A.discardAll}>
          <Icon name="trash" size={14} />
        </button>
      </div>

      <div className="wip-lists">
        {conflicted.length > 0 && (
          <section className="file-section conflicts">
            <div className="section-head">
              <span>Conflicted Files ({conflicted.length})</span>
            </div>
            <WipFileList files={conflicted} kind="conflicted" />
          </section>
        )}
        <section className="file-section">
          <div className="section-head">
            <span>Unstaged Files ({unstaged.length})</span>
            {unstaged.length > 0 && (
              <button className="btn btn-sm btn-stage" onClick={A.stageAll}>
                Stage all changes
              </button>
            )}
          </div>
          <WipFileList files={unstaged} kind="unstaged" />
        </section>
        <section className="file-section">
          <div className="section-head">
            <span>Staged Files ({staged.length})</span>
            {staged.length > 0 && (
              <button className="btn btn-sm" onClick={A.unstageAll}>
                Unstage all
              </button>
            )}
          </div>
          <WipFileList files={staged} kind="staged" />
        </section>
      </div>

      <form
        className="commit-box"
        onSubmit={(e) => {
          e.preventDefault()
          if (canCommit) void A.commitChanges()
        }}
      >
        <label className="amend">
          <input type="checkbox" checked={draft.amend} onChange={(e) => toggleAmend(e.target.checked)} disabled={!status.head} />
          Amend previous commit
        </label>
        <div className="summary-wrap">
          <input
            className="summary"
            placeholder="Commit summary"
            value={draft.summary}
            onChange={(e) => setDraft({ summary: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canCommit) void A.commitChanges()
            }}
          />
          <span className={cls('summary-count', draft.summary.length > 72 && 'over')}>{72 - draft.summary.length}</span>
        </div>
        <textarea
          className="description"
          placeholder="Description"
          value={draft.description}
          onChange={(e) => setDraft({ description: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canCommit) void A.commitChanges()
          }}
        />
        <button type="submit" className="btn btn-commit" disabled={!canCommit}>
          {buttonLabel}
        </button>
      </form>
    </div>
  )
}

// ------------------------------------------------------------------ commit panel

function Avatar({ name, email }: { name: string; email: string }) {
  return (
    <span className="avatar" style={{ background: hashColor(email || name) }}>
      {initials(name)}
    </span>
  )
}

function CommitPanel({ sha, stash: isStash }: { sha: string; stash: boolean }) {
  const details = useStore((s) => s.details)
  const target = useStore((s) => s.diff?.target)
  const stash = useStore((s) => (isStash ? s.snap?.stashes.find((x) => x.sha === sha) : undefined))
  const [showBody, setShowBody] = useState(true)

  if (!details || details.sha !== sha) return <div className="panel panel-loading">Loading…</div>

  const [subject, ...rest] = details.message.split('\n')
  const body = rest.join('\n').trim()
  const committedSeparately = details.committer !== details.author || details.committerDate !== details.date
  const parents = isStash ? details.parents.slice(0, 1) : details.parents

  return (
    <div className="panel commit-panel">
      <div className="cp-meta">
        <span className="cp-kind">{isStash ? 'stash' : 'commit'}:</span>
        <button className="sha-btn" onClick={() => A.copy(sha, 'SHA copied')} title="Copy full SHA">
          {shortSha(sha)} <Icon name="copy" size={11} />
        </button>
        {parents.length > 0 && <span className="cp-kind">{parents.length > 1 ? 'parents:' : 'parent:'}</span>}
        {parents.map((p) => (
          <button key={p} className="link-btn" onClick={() => selectSha(p)}>
            {shortSha(p)}
          </button>
        ))}
      </div>

      {stash && (
        <div className="cp-actions">
          <button className="btn btn-sm btn-primary" onClick={() => A.applyStash(stash)}>
            Apply
          </button>
          <button className="btn btn-sm" onClick={() => A.popStash(stash)}>
            Pop
          </button>
          <button className="btn btn-sm btn-danger" onClick={() => A.dropStash(stash)}>
            Delete
          </button>
          <button className="icon-btn" onClick={(e) => showMenu(e, stashMenu(stash))}>
            ⋯
          </button>
        </div>
      )}

      <div className="cp-subject">{subject}</div>
      {body && (
        <div className="cp-body-wrap">
          {showBody && <pre className="cp-body">{body}</pre>}
          <button className="link-btn small" onClick={() => setShowBody((v) => !v)}>
            {showBody ? 'Hide description' : 'Show description'}
          </button>
        </div>
      )}

      {!isStash && <PullRequestSection sha={sha} />}

      <div className="cp-people">
        <div className="cp-person">
          <Avatar name={details.author} email={details.email} />
          <div>
            <div className="cp-name">{details.author}</div>
            <div className="cp-date" title={formatDate(details.date)}>
              authored {relativeTime(details.date)} · {formatDate(details.date)}
            </div>
          </div>
        </div>
        {committedSeparately && (
          <div className="cp-person">
            <Avatar name={details.committer} email={details.committerEmail} />
            <div>
              <div className="cp-name">{details.committer}</div>
              <div className="cp-date">committed {relativeTime(details.committerDate)}</div>
            </div>
          </div>
        )}
      </div>

      <div className="section-head">
        <span>{plural(details.files.length, 'file')} changed</span>
      </div>
      <div className="file-list commit-files">
        {details.files.slice(0, MAX_FILES).map((f) => {
          const rev = f.rev ?? sha
          return (
            <FileRow
              key={`${rev}:${f.path}`}
              file={f}
              active={isActive(target, 'commit', f.path, rev)}
              onOpen={() => openDiff({ kind: 'commit', sha: rev, path: f.path, oldPath: f.oldPath })}
              onMenu={(e) => showMenu(e, commitFileMenu(f))}
            />
          )
        })}
        {details.files.length > MAX_FILES && <div className="file-more">…and {details.files.length - MAX_FILES} more</div>}
      </div>
    </div>
  )
}

export function RightPanel() {
  const selection = useStore((s) => s.selection)
  if (!selection) return <div className="panel panel-loading">Select a commit to see its details</div>
  if (selection.kind === 'wip') return <WipPanel />
  return <CommitPanel sha={selection.sha} stash={!!selection.stash} />
}
