import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import { canPartiallyApply, type PatchSelection } from '../../../shared/patch'
import type { ApplyMode, DiffHunk, DiffLine, FileChange } from '../../../shared/types'
import * as A from '../actions'
import { closeDiff, useStore } from '../store'
import { basename, cls, dirname, plural, shortSha } from '../util'
import { Icon } from './Icon'

type LineSelection = Map<number, Set<number>>

const LARGE_DIFF_LINES = 6000
const isChange = (l: DiffLine) => l.type === '+' || l.type === '-'
const display = (text: string) => text.replace(/\r$/, '') || ' '

function loadMode(): 'unified' | 'split' {
  try {
    return localStorage.getItem('gitlane.diffMode') === 'split' ? 'split' : 'unified'
  } catch {
    return 'unified'
  }
}

/** Pair deletions with additions so they line up side by side. */
function splitRows(lines: DiffLine[]): { left?: number; right?: number }[] {
  const rows: { left?: number; right?: number }[] = []
  let i = 0
  while (i < lines.length) {
    const type = lines[i].type
    if (type === ' ') {
      rows.push({ left: i, right: i })
      i++
      continue
    }
    if (type === '\\') {
      i++
      continue
    }
    const dels: number[] = []
    const adds: number[] = []
    while (i < lines.length && lines[i].type !== ' ') {
      if (lines[i].type === '-') dels.push(i)
      else if (lines[i].type === '+') adds.push(i)
      i++
    }
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ left: dels[k], right: adds[k] })
  }
  return rows
}

interface LineProps {
  line?: DiffLine
  side?: 'old' | 'new'
  selected: boolean
  selectable: boolean
  onSelect: (e: MouseEvent) => void
}

function Line({ line, side, selected, selectable, onSelect }: LineProps) {
  if (!line) return <div className="dl empty" />
  const gutter = (
    <>
      {side !== 'new' && <span className="ln">{line.oldNo ?? ''}</span>}
      {side !== 'old' && <span className="ln">{line.newNo ?? ''}</span>}
      <span className="sign">{isChange(line) ? line.type : ''}</span>
    </>
  )
  return (
    <div
      className={cls(
        'dl',
        line.type === '+' && 'add',
        line.type === '-' && 'del',
        line.type === '\\' && 'meta',
        selected && 'sel',
        selectable && 'selectable'
      )}
    >
      <span className="gutter" onMouseDown={selectable ? onSelect : undefined} title={selectable ? 'Click to select line (Shift for range)' : undefined}>
        {gutter}
      </span>
      <span className="code">{display(line.text)}</span>
    </div>
  )
}

export function DiffView() {
  const diff = useStore((s) => s.diff)!
  const status = useStore((s) => s.snap?.status)
  const { target, data, error } = diff
  const [mode, setMode] = useState(loadMode)
  const [selection, setSelection] = useState<LineSelection>(new Map())
  const [anchor, setAnchor] = useState<{ hunk: number; line: number } | null>(null)
  const [forceLarge, setForceLarge] = useState(false)

  useEffect(() => {
    setSelection(new Map())
    setAnchor(null)
  }, [data])
  useEffect(() => setForceLarge(false), [target.path])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { dialog, menu } = useStore.getState()
      if ((e.target as HTMLElement | null)?.closest?.('.terminal-panel')) return
      if (e.key === 'Escape' && !dialog && !menu) closeDiff()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const changeMode = (m: 'unified' | 'split') => {
    setMode(m)
    try {
      localStorage.setItem('gitlane.diffMode', m)
    } catch {
      /* storage unavailable */
    }
  }

  const editable =
    (target.kind === 'unstaged' && !target.untracked && !target.conflicted) || target.kind === 'staged'
  const partial = !!data && editable && canPartiallyApply(data)
  const selectedCount = [...selection.values()].reduce((n, s) => n + s.size, 0)
  const totalLines = useMemo(() => data?.hunks.reduce((n, h) => n + h.lines.length, 0) ?? 0, [data])

  // The FileChange behind this diff, for file-level buttons.
  const file: FileChange | undefined = useMemo(() => {
    if (!status || target.kind === 'commit') return undefined
    const lists = target.kind === 'staged' ? status.staged : target.conflicted ? status.conflicted : status.unstaged
    return lists.find((f) => f.path === target.path)
  }, [status, target])

  const toggleLine = (hunk: DiffHunk, hi: number, li: number, shift: boolean) => {
    if (!isChange(hunk.lines[li])) return
    setSelection((prev) => {
      const next = new Map(prev)
      const lines = new Set(next.get(hi) ?? [])
      if (shift && anchor?.hunk === hi) {
        const [from, to] = [Math.min(anchor.line, li), Math.max(anchor.line, li)]
        for (let i = from; i <= to; i++) if (isChange(hunk.lines[i])) lines.add(i)
      } else if (lines.has(li)) {
        lines.delete(li)
      } else {
        lines.add(li)
      }
      if (lines.size) next.set(hi, lines)
      else next.delete(hi)
      return next
    })
    setAnchor({ hunk: hi, line: li })
  }

  const applyHunk = (hi: number, m: ApplyMode) => A.applySelection(new Map([[hi, 'all']]), m)
  const applyLines = (m: ApplyMode) => A.applySelection(new Map<number, Set<number> | 'all'>(selection) as PatchSelection, m)

  const hunkButtons = (hi: number) =>
    target.kind === 'staged' ? (
      <button className="btn btn-sm" onClick={() => applyHunk(hi, 'unstage')}>
        Unstage hunk
      </button>
    ) : (
      <>
        <button className="btn btn-sm btn-stage" onClick={() => applyHunk(hi, 'stage')}>
          Stage hunk
        </button>
        <button className="btn btn-sm btn-danger" onClick={() => applyHunk(hi, 'discard')}>
          Discard hunk
        </button>
      </>
    )

  const kindLabel =
    target.kind === 'commit'
      ? target.sha.endsWith('^3')
        ? `untracked in stash ${shortSha(target.sha)}`
        : `commit ${shortSha(target.sha)}`
      : target.kind === 'staged'
        ? 'staged'
        : target.conflicted
          ? 'conflicted'
          : target.untracked
            ? 'untracked'
            : 'unstaged'

  const dir = dirname(target.path)
  let body
  if (error) body = <div className="diff-msg error">{error}</div>
  else if (!data) body = <div className="diff-msg">Loading diff…</div>
  else if (data.binary) body = <div className="diff-msg">Binary file — no preview available.</div>
  else if (data.hunks.length === 0) body = <div className="diff-msg">No content changes (empty file or mode change only).</div>
  else if (totalLines > LARGE_DIFF_LINES && !forceLarge)
    body = (
      <div className="diff-msg">
        This diff is large ({totalLines.toLocaleString()} lines).{' '}
        <button className="btn btn-sm" onClick={() => setForceLarge(true)}>
          Show it anyway
        </button>
      </div>
    )
  else
    body = data.hunks.map((hunk, hi) => {
      const picked = selection.get(hi)
      return (
        <div className="hunk" key={hi}>
          <div className="hunk-head">
            <span className="hunk-title">{hunk.header}</span>
            {partial && <span className="hunk-actions">{hunkButtons(hi)}</span>}
          </div>
          {mode === 'unified'
            ? hunk.lines.map((line, li) => (
                <Line
                  key={li}
                  line={line}
                  selected={!!picked?.has(li)}
                  selectable={partial && isChange(line)}
                  onSelect={(e) => toggleLine(hunk, hi, li, e.shiftKey)}
                />
              ))
            : splitRows(hunk.lines).map((row, ri) => (
                <div className="split-row" key={ri}>
                  {(['left', 'right'] as const).map((sideKey) => {
                    const li = row[sideKey]
                    const line = li === undefined ? undefined : hunk.lines[li]
                    return (
                      <Line
                        key={sideKey}
                        line={line}
                        side={sideKey === 'left' ? 'old' : 'new'}
                        selected={li !== undefined && !!picked?.has(li) && line?.type !== ' '}
                        selectable={partial && !!line && isChange(line)}
                        onSelect={(e) => li !== undefined && toggleLine(hunk, hi, li, e.shiftKey)}
                      />
                    )
                  })}
                </div>
              ))}
        </div>
      )
    })

  return (
    <div className="diff-view">
      <div className="diff-header">
        <span className="diff-path" title={target.path}>
          {dir && <span className="dir">{dir}/</span>}
          <span className="name">{basename(target.path)}</span>
        </span>
        <span className="diff-kind">{kindLabel}</span>
        <div className="diff-actions">
          {selectedCount > 0 &&
            (target.kind === 'staged' ? (
              <button className="btn btn-sm btn-primary" onClick={() => applyLines('unstage')}>
                Unstage {plural(selectedCount, 'line')}
              </button>
            ) : (
              <>
                <button className="btn btn-sm btn-primary" onClick={() => applyLines('stage')}>
                  Stage {plural(selectedCount, 'line')}
                </button>
                <button className="btn btn-sm btn-danger" onClick={() => applyLines('discard')}>
                  Discard {plural(selectedCount, 'line')}
                </button>
              </>
            ))}
          {file && target.kind === 'unstaged' && !target.conflicted && (
            <>
              <button className="btn btn-sm btn-stage" onClick={() => A.stageFiles([file])}>
                Stage file
              </button>
              <button className="btn btn-sm btn-danger" onClick={() => A.discardFiles([file])}>
                Discard file
              </button>
            </>
          )}
          {file && target.kind === 'unstaged' && target.conflicted && (
            <>
              <button className="btn btn-sm" onClick={() => A.resolveConflict([file], 'ours')}>
                Take ours
              </button>
              <button className="btn btn-sm" onClick={() => A.resolveConflict([file], 'theirs')}>
                Take theirs
              </button>
              <button className="btn btn-sm btn-stage" onClick={() => A.stageFiles([file])}>
                Mark resolved
              </button>
            </>
          )}
          {file && target.kind === 'staged' && (
            <button className="btn btn-sm" onClick={() => A.unstageFiles([file])}>
              Unstage file
            </button>
          )}
          {target.kind !== 'commit' && (
            <button className="icon-btn" title="Open file" onClick={() => A.openFile(target.path)}>
              <Icon name="file" size={14} />
            </button>
          )}
          <span className="seg">
            <button className={cls(mode === 'unified' && 'on')} onClick={() => changeMode('unified')}>
              Unified
            </button>
            <button className={cls(mode === 'split' && 'on')} onClick={() => changeMode('split')}>
              Split
            </button>
          </span>
          <button className="icon-btn" title="Close (Esc)" onClick={closeDiff}>
            <Icon name="close" size={14} />
          </button>
        </div>
      </div>
      {partial && <div className="diff-hint">Tip: click line numbers to pick individual lines (Shift-click for a range).</div>}
      <div className={cls('diff-body', mode === 'split' && 'split')}>{body}</div>
    </div>
  )
}
