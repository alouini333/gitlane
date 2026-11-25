import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent
} from 'react'
import type { Commit, PullRequest, Ref, Stash } from '../../../shared/types'
import { abortOperation, checkoutRef, continueOperation, skipRebaseCommit } from '../actions'
import { prForRef } from '../github'
import { computeLayout, type Anchor, type GraphRow, type Segment } from '../graph/layout'
import { commitMenu, refMenu, stashMenu } from '../menus'
import { loadMore, select, showMenu, useStore } from '../store'
import { cls, formatDate, formatShortDate, hasChanges, laneColor, plural, shortSha } from '../util'
import { Icon } from './Icon'
import { PrChip } from './PullRequests'

const ROW_H = 28
const LANE_W = 16
const GRAPH_PAD = 8
const MAX_GRAPH_W = 320
const WIP_SHA = '__wip__'

type ItemKind = 'wip' | 'commit' | 'stash'

interface Item {
  kind: ItemKind
  sha: string
  parents: string[]
  commit?: Commit
  stash?: Stash
}

/** Commits in display order, plus a WIP row on top and stashes just above their base commit. */
function buildItems(commits: Commit[], stashes: Stash[], wip: boolean, head: string | null): Item[] {
  const items: Item[] = []
  if (wip) items.push({ kind: 'wip', sha: WIP_SHA, parents: head ? [head] : [] })
  const byBase = new Map<string, Stash[]>()
  for (const s of stashes) {
    const base = s.parents[0]
    if (base) byBase.set(base, [...(byBase.get(base) ?? []), s])
  }
  for (const commit of commits) {
    for (const s of byBase.get(commit.sha) ?? []) items.push({ kind: 'stash', sha: s.sha, parents: [commit.sha], stash: s })
    items.push({ kind: 'commit', sha: commit.sha, parents: commit.parents, commit })
  }
  return items
}

interface Label {
  key: string
  text: string
  primary: Ref
  all: Ref[]
  local: boolean
  remote: boolean
  tag: boolean
  current: boolean
  pr?: PullRequest
}

/** Merge a local branch and its same-named remote branches into one label. */
function makeLabels(refs: Ref[]): Label[] {
  const labels: Label[] = []
  const remotes = refs.filter((r) => r.type === 'remote')
  const used = new Set<Ref>()
  for (const local of refs.filter((r) => r.type === 'head')) {
    const same = remotes.filter((r) => r.short.slice((r.remote?.length ?? 0) + 1) === local.short)
    same.forEach((r) => used.add(r))
    labels.push({ key: local.name, text: local.short, primary: local, all: [local, ...same], local: true, remote: same.length > 0, tag: false, current: !!local.current })
  }
  for (const r of remotes) {
    if (!used.has(r)) labels.push({ key: r.name, text: r.short, primary: r, all: [r], local: false, remote: true, tag: false, current: false })
  }
  for (const t of refs.filter((r) => r.type === 'tag')) {
    labels.push({ key: t.name, text: t.short, primary: t, all: [t], local: false, remote: false, tag: true, current: false })
  }
  return labels.sort((a, b) => Number(b.current) - Number(a.current) || Number(a.tag) - Number(b.tag))
}

// ------------------------------------------------------------------ drawing

const xOf = (col: number) => GRAPH_PAD + col * LANE_W + LANE_W / 2
const yOf = (a: Anchor) => (a === 'top' ? 0 : a === 'mid' ? ROW_H / 2 : ROW_H)

function segmentPath(s: Segment): string {
  const x1 = xOf(s.fromCol)
  const x2 = xOf(s.toCol)
  const y1 = yOf(s.fromY)
  const y2 = yOf(s.toY)
  if (x1 === x2) return `M${x1} ${y1}V${y2}`
  const mid = ROW_H / 2
  const dir = Math.sign(x2 - x1)
  const r = Math.min(7, Math.abs(x2 - x1), mid)
  if (s.fromY === 'top' && s.toY === 'mid') {
    // Lane comes down, then turns into the node.
    return `M${x1} 0V${mid - r}Q${x1} ${mid} ${x1 + dir * r} ${mid}H${x2}`
  }
  if (s.fromY === 'mid' && s.toY === 'bottom') {
    // Leaves the node sideways, then turns down into its lane.
    return `M${x1} ${mid}H${x2 - dir * r}Q${x2} ${mid} ${x2} ${mid + r}V${ROW_H}`
  }
  const ym = (y1 + y2) / 2
  return `M${x1} ${y1}C${x1} ${ym} ${x2} ${ym} ${x2} ${y2}`
}

function RowGraph({ row, item, width, isHead }: { row: GraphRow; item: Item; width: number; isHead: boolean }) {
  const cx = xOf(row.col)
  const cy = ROW_H / 2
  const color = laneColor(row.color)
  const bg = { fill: 'var(--bg)' }
  return (
    <svg width={width} height={ROW_H} className="row-graph">
      {row.segments.map((s, i) => (
        <path
          key={i}
          d={segmentPath(s)}
          stroke={laneColor(s.color)}
          strokeWidth={2}
          fill="none"
          strokeDasharray={s.dashed ? '3 3' : undefined}
        />
      ))}
      {item.kind === 'wip' ? (
        <circle cx={cx} cy={cy} r={6} style={bg} stroke={color} strokeWidth={2} strokeDasharray="2.5 2" />
      ) : item.kind === 'stash' ? (
        <rect x={cx - 5.5} y={cy - 5.5} width={11} height={11} rx={2} style={bg} stroke={color} strokeWidth={1.8} strokeDasharray="2.5 1.5" />
      ) : (
        <>
          {isHead && <circle cx={cx} cy={cy} r={9} fill="none" stroke="var(--text)" strokeWidth={1.5} />}
          <circle cx={cx} cy={cy} r={item.parents.length > 1 ? 4.5 : 6} fill={color} stroke="var(--bg)" strokeWidth={1.5} />
        </>
      )}
    </svg>
  )
}

// ------------------------------------------------------------------ rows

function selectItem(item: Item) {
  if (item.kind === 'wip') select({ kind: 'wip' })
  else select({ kind: 'commit', sha: item.sha, stash: item.kind === 'stash' })
}

function onRowMenu(e: MouseEvent, item: Item) {
  selectItem(item)
  if (item.commit) showMenu(e, commitMenu(item.commit))
  else if (item.stash) showMenu(e, stashMenu(item.stash))
  else e.preventDefault()
}

function RefCell({ labels, color, detached }: { labels: Label[]; color: string; detached: boolean }) {
  if (labels.length === 0 && !detached) return null
  const [first, ...rest] = labels
  return (
    <div className="ref-cell">
      {detached && <span className="ref-pill head-pill">HEAD</span>}
      {first && <RefPill label={first} color={color} />}
      {rest.length > 0 && (
        <button
          className="ref-more"
          title={rest.map((l) => l.text).join('\n')}
          onClick={(e) => {
            e.stopPropagation()
            showMenu(
              e,
              rest.map((l) => ({ label: `${l.tag ? 'tag' : 'branch'}: ${l.text}`, action: () => showMenu(e, refMenu(l.primary)) }))
            )
          }}
        >
          +{rest.length}
        </button>
      )}
    </div>
  )
}

function RefPill({ label, color }: { label: Label; color: string }) {
  return (
    <span
      className={cls('ref-pill', label.current && 'current', label.tag && 'tag')}
      style={{ '--c': color } as CSSProperties}
      title={label.all.map((r) => r.short).join(', ')}
      onDoubleClick={(e) => {
        e.stopPropagation()
        void checkoutRef(label.primary)
      }}
      onContextMenu={(e) => {
        e.stopPropagation()
        showMenu(e, refMenu(label.primary))
      }}
    >
      {label.current && <Icon name="check" size={11} />}
      <span className="ref-text">{label.text}</span>
      {label.local && <Icon name="laptop" size={11} />}
      {label.remote && <Icon name="cloud" size={11} />}
      {label.tag && <Icon name="tag" size={11} />}
      {label.pr && <PrChip pr={label.pr} />}
    </span>
  )
}

interface RowProps {
  item: Item
  row: GraphRow
  top: number
  selected: boolean
  dim: boolean
  isHead: boolean
  detached: boolean
  labels: Label[]
  graphWidth: number
  wipText: string
}

const Row = memo(function Row({ item, row, top, selected, dim, isHead, detached, labels, graphWidth, wipText }: RowProps) {
  const color = laneColor(row.color)
  const c = item.commit
  return (
    <div
      className={cls('g-row', selected && 'selected', dim && 'dim', item.kind !== 'commit' && `g-${item.kind}`, isHead && 'head')}
      style={{ top, '--lane': color } as CSSProperties}
      onMouseDown={() => selectItem(item)}
      onContextMenu={(e) => onRowMenu(e, item)}
    >
      <div className="c-refs">{item.kind === 'commit' && <RefCell labels={labels} color={color} detached={detached} />}</div>
      <div className="c-graph">
        <RowGraph row={row} item={item} width={graphWidth} isHead={isHead} />
      </div>
      <div className="c-msg">
        {item.kind === 'wip' ? (
          <span className="wip-text">{wipText}</span>
        ) : item.kind === 'stash' ? (
          <span className="stash-text">{item.stash!.message}</span>
        ) : (
          c!.subject
        )}
      </div>
      <div className="c-author">{c?.author ?? ''}</div>
      <div className="c-date" title={c ? formatDate(c.date) : undefined}>
        {c ? formatShortDate(c.date) : item.stash ? formatShortDate(item.stash.date) : ''}
      </div>
      <div className="c-sha">{item.kind === 'wip' ? '' : shortSha(item.sha)}</div>
    </div>
  )
})

// ------------------------------------------------------------------ banner

export function OperationBanner() {
  const status = useStore((s) => s.snap?.status)
  if (!status || status.operation === 'none') return null
  const op = status.operation
  const conflicts = status.conflicted.length
  const name = { merge: 'Merge', rebase: 'Rebase', 'cherry-pick': 'Cherry-pick', revert: 'Revert', none: '' }[op]
  return (
    <div className={cls('op-banner', conflicts > 0 && 'has-conflicts')}>
      <Icon name="warning" />
      <span>
        <strong>{name} in progress.</strong>{' '}
        {conflicts > 0
          ? `Resolve ${plural(conflicts, 'conflicted file')}, stage them, then continue.`
          : 'All conflicts resolved — continue to finish.'}
      </span>
      <span className="op-actions">
        <button className="btn btn-primary btn-sm" disabled={conflicts > 0} onClick={continueOperation}>
          {op === 'merge' ? 'Commit merge' : 'Continue'}
        </button>
        {op === 'rebase' && (
          <button className="btn btn-sm" onClick={skipRebaseCommit}>
            Skip commit
          </button>
        )}
        <button className="btn btn-sm btn-danger" onClick={abortOperation}>
          Abort
        </button>
      </span>
    </div>
  )
}

// ------------------------------------------------------------------ graph

export function Graph() {
  const snap = useStore((s) => s.snap)!
  const selection = useStore((s) => s.selection)
  const draftSummary = useStore((s) => s.draft.summary)
  const scrollRequest = useStore((s) => s.scrollRequest)
  const github = useStore((s) => s.github)
  const { commits, stashes, refs, status, remotes } = snap
  const wip = hasChanges(status)

  const items = useMemo(() => buildItems(commits, stashes, wip, status.head), [commits, stashes, wip, status.head])
  const layout = useMemo(
    () => computeLayout(items.map((i) => ({ sha: i.sha, parents: i.parents, dashed: i.kind === 'wip' }))),
    [items]
  )
  const indexBySha = useMemo(() => new Map(items.map((it, i) => [it.sha, i])), [items])
  const labelsBySha = useMemo(() => {
    const grouped = new Map<string, Ref[]>()
    for (const r of refs) grouped.set(r.sha, [...(grouped.get(r.sha) ?? []), r])
    const withPr = (label: Label): Label => {
      if (label.tag || !github?.openPrs.length) return label
      const pr = label.all.map((r) => prForRef(r, refs, remotes, github)).find(Boolean)
      return pr ? { ...label, pr } : label
    }
    return new Map([...grouped].map(([sha, list]) => [sha, makeLabels(list).map(withPr)]))
  }, [refs, remotes, github])
  const graphWidth = Math.min(MAX_GRAPH_W, Math.max(56, GRAPH_PAD * 2 + layout.width * LANE_W))

  const wipText = useMemo(() => {
    if (!wip) return ''
    const files = new Set([...status.staged, ...status.unstaged, ...status.conflicted].map((f) => f.path))
    return `${draftSummary.trim() || '// WIP'}  ·  ${plural(files.size, 'file')} changed`
  }, [wip, status, draftSummary])

  // --- virtual scrolling
  const scrollRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ top: 0, height: 800 })
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewport({ top: el.scrollTop, height: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const onScroll = () => {
    const el = scrollRef.current!
    setViewport({ top: el.scrollTop, height: el.clientHeight })
    if (el.scrollTop + el.clientHeight > el.scrollHeight - ROW_H * 40) void loadMore()
  }
  const first = Math.max(0, Math.floor(viewport.top / ROW_H) - 10)
  const last = Math.min(items.length, Math.ceil((viewport.top + viewport.height) / ROW_H) + 10)

  const selectedIndex =
    selection?.kind === 'wip' ? (indexBySha.get(WIP_SHA) ?? -1) : selection ? (indexBySha.get(selection.sha) ?? -1) : -1

  const scrollToIndex = useCallback((i: number, center = false) => {
    const el = scrollRef.current
    if (!el || i < 0) return
    const top = i * ROW_H
    const visible = top >= el.scrollTop && top + ROW_H <= el.scrollTop + el.clientHeight
    if (center && !visible) el.scrollTop = top - el.clientHeight / 2 + ROW_H / 2
    else if (top < el.scrollTop) el.scrollTop = top
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight
  }, [])

  useEffect(() => {
    if (!scrollRequest) return
    const i = indexBySha.get(scrollRequest.sha)
    if (i !== undefined) scrollToIndex(i, true)
  }, [scrollRequest])

  // --- search (Cmd/Ctrl+F)
  const [search, setSearch] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('.terminal-panel')) return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setSearch((s) => s ?? '')
        setTimeout(() => searchRef.current?.select(), 0)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const query = search?.trim().toLowerCase() ?? ''
  const matches = useMemo(() => {
    if (!query) return null
    const found: number[] = []
    items.forEach((it, i) => {
      const text = it.commit
        ? `${it.commit.subject}\n${it.commit.author}\n${it.commit.email}\n${it.commit.sha}`
        : (it.stash?.message ?? '')
      if (text.toLowerCase().includes(query)) found.push(i)
    })
    return found
  }, [items, query])
  const matchSet = useMemo(() => (matches ? new Set(matches) : null), [matches])
  const jump = (dir: 1 | -1) => {
    if (!matches?.length) return
    const next =
      dir === 1
        ? (matches.find((i) => i > selectedIndex) ?? matches[0])
        : ([...matches].reverse().find((i) => i < selectedIndex) ?? matches[matches.length - 1])
    selectItem(items[next])
    scrollToIndex(next, true)
  }

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const next = Math.max(0, Math.min(items.length - 1, selectedIndex + (e.key === 'ArrowDown' ? 1 : -1)))
    if (items[next]) {
      selectItem(items[next])
      scrollToIndex(next)
    }
  }

  const detached = status.branch === null
  const style = { '--graph-w': `${graphWidth}px` } as CSSProperties

  return (
    <div className="graph" style={style}>
      <div className="g-header">
        <div className="c-refs">BRANCH / TAG</div>
        <div className="c-graph">GRAPH</div>
        <div className="c-msg">
          COMMIT MESSAGE
          {search !== null && (
            <span className="g-search" onMouseDown={(e) => e.stopPropagation()}>
              <Icon name="search" size={11} />
              <input
                ref={searchRef}
                value={search}
                placeholder="Search message, author, SHA"
                spellCheck={false}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') jump(e.shiftKey ? -1 : 1)
                  if (e.key === 'Escape') setSearch(null)
                }}
              />
              {matches && <span className="g-search-count">{matches.length}</span>}
              <button className="icon-btn" onClick={() => setSearch(null)}>
                <Icon name="close" size={10} />
              </button>
            </span>
          )}
        </div>
        <div className="c-author">AUTHOR</div>
        <div className="c-date">DATE</div>
        <div className="c-sha">SHA</div>
      </div>
      <div className="g-scroll" ref={scrollRef} onScroll={onScroll} tabIndex={0} onKeyDown={onKeyDown}>
        {items.length === 0 ? (
          <div className="empty-state">This repository has no commits yet. Make some changes and commit them.</div>
        ) : (
          <div className="g-canvas" style={{ height: items.length * ROW_H }}>
            {items.slice(first, last).map((item, k) => {
              const i = first + k
              return (
                <Row
                  key={item.sha}
                  item={item}
                  row={layout.rows[i]}
                  top={i * ROW_H}
                  selected={i === selectedIndex}
                  dim={!!matchSet && !matchSet.has(i)}
                  isHead={item.kind === 'commit' && item.sha === status.head}
                  detached={detached && item.kind === 'commit' && item.sha === status.head}
                  labels={labelsBySha.get(item.sha) ?? NO_LABELS}
                  graphWidth={graphWidth}
                  wipText={item.kind === 'wip' ? wipText : ''}
                />
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

const NO_LABELS: Label[] = []
