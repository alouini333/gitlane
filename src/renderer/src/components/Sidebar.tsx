import { useMemo, useState, type ReactNode } from 'react'
import type { Ref, Stash } from '../../../shared/types'
import { checkoutRef } from '../actions'
import { refMenu, stashMenu } from '../menus'
import { selectSha, showMenu, useStore } from '../store'
import { cls } from '../util'
import { Icon } from './Icon'
import { PrChip, useRefPr } from './PullRequests'
import { PullRequestList } from './PullRequestList'

interface TreeNode {
  key: string
  label: string
  children: TreeNode[]
  ref?: Ref
}

/** Group refs into folders by "/" in their names (feature/a, feature/b → feature/{a,b}). */
function buildTree(refs: Ref[], nameOf: (r: Ref) => string, prefix: string): TreeNode[] {
  const root: TreeNode = { key: prefix, label: '', children: [] }
  for (const ref of refs) {
    const parts = nameOf(ref).split('/')
    let node = root
    parts.forEach((part, i) => {
      const key = `${node.key}/${part}`
      if (i === parts.length - 1) {
        node.children.push({ key: key + '#leaf', label: part, children: [], ref })
        return
      }
      let child = node.children.find((c) => c.key === key && !c.ref)
      if (!child) {
        child = { key, label: part, children: [] }
        node.children.push(child)
      }
      node = child
    })
  }
  const sort = (nodes: TreeNode[]): TreeNode[] =>
    nodes
      .sort((a, b) => Number(!!a.ref) - Number(!!b.ref) || a.label.localeCompare(b.label))
      .map((n) => ({ ...n, children: sort(n.children) }))
  return sort(root.children)
}

function useCollapsed(initial: string[] = []) {
  const [collapsed, setCollapsed] = useState(() => new Set(initial))
  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  return [collapsed, toggle] as const
}

export function Sidebar() {
  const snap = useStore((s) => s.snap)
  const selection = useStore((s) => s.selection)
  const [filter, setFilter] = useState('')
  const [collapsed, toggle] = useCollapsed(['section:tags'])
  const query = filter.trim().toLowerCase()

  const refs = useMemo(() => {
    const all = snap?.refs ?? []
    return query ? all.filter((r) => r.short.toLowerCase().includes(query)) : all
  }, [snap?.refs, query])

  const locals = refs.filter((r) => r.type === 'head')
  const tags = refs.filter((r) => r.type === 'tag')
  const remotes = snap?.remotes ?? []
  const stashes = (snap?.stashes ?? []).filter((s) => !query || s.message.toLowerCase().includes(query))
  const selectedSha = selection?.kind === 'commit' ? selection.sha : null

  const isOpen = (key: string) => query !== '' || !collapsed.has(key)

  const renderTree = (nodes: TreeNode[], depth: number): ReactNode =>
    nodes.map((node) =>
      node.ref ? (
        <RefItem key={node.key} ref_={node.ref} label={node.label} depth={depth} selected={node.ref.sha === selectedSha} />
      ) : (
        <div key={node.key}>
          <div className="side-item side-folder" style={{ paddingLeft: 10 + depth * 14 }} onClick={() => toggle(node.key)}>
            <Icon name={isOpen(node.key) ? 'chevronDown' : 'chevronRight'} size={10} />
            <Icon name="folder" size={12} />
            <span className="side-label">{node.label}</span>
          </div>
          {isOpen(node.key) && renderTree(node.children, depth + 1)}
        </div>
      )
    )

  const section = (key: string, title: string, count: number, body: ReactNode) => (
    <div className="side-section">
      <div className="side-header" onClick={() => toggle(key)}>
        <Icon name={isOpen(key) ? 'chevronDown' : 'chevronRight'} size={10} />
        <span>{title}</span>
        <span className="side-count">{count}</span>
      </div>
      {isOpen(key) && body}
    </div>
  )

  return (
    <aside className="sidebar">
      <div className="side-filter">
        <Icon name="search" size={12} />
        <input placeholder="Filter branches, tags, stashes" value={filter} onChange={(e) => setFilter(e.target.value)} spellCheck={false} />
        {filter && (
          <button className="icon-btn" onClick={() => setFilter('')}>
            <Icon name="close" size={10} />
          </button>
        )}
      </div>
      <div className="side-scroll">
        <PullRequestList open={isOpen('section:prs')} onToggle={() => toggle('section:prs')} query={query} />
        {section('section:local', 'LOCAL', locals.length, renderTree(buildTree(locals, (r) => r.short, 'local'), 1))}
        {section(
          'section:remote',
          'REMOTE',
          remotes.length,
          remotes.map((remote) => {
            const branches = refs.filter((r) => r.type === 'remote' && r.remote === remote)
            if (query && branches.length === 0) return null
            const key = `remote:${remote}`
            return (
              <div key={remote}>
                <div className="side-item side-folder" style={{ paddingLeft: 24 }} onClick={() => toggle(key)}>
                  <Icon name={isOpen(key) ? 'chevronDown' : 'chevronRight'} size={10} />
                  <Icon name="cloud" size={13} />
                  <span className="side-label">{remote}</span>
                </div>
                {isOpen(key) && renderTree(buildTree(branches, (r) => r.short.slice(remote.length + 1), key), 2)}
              </div>
            )
          })
        )}
        {section(
          'section:tags',
          'TAGS',
          tags.length,
          tags
            .slice()
            .sort((a, b) => b.short.localeCompare(a.short, undefined, { numeric: true }))
            .map((t) => <RefItem key={t.name} ref_={t} label={t.short} depth={1} selected={t.sha === selectedSha} />)
        )}
        {section(
          'section:stashes',
          'STASHES',
          stashes.length,
          stashes.map((s) => <StashItem key={s.sha} stash={s} selected={s.sha === selectedSha} />)
        )}
      </div>
    </aside>
  )
}

function RefItem({ ref_: ref, label, depth, selected }: { ref_: Ref; label: string; depth: number; selected: boolean }) {
  const pr = useRefPr(ref)
  const icon = ref.type === 'tag' ? 'tag' : ref.type === 'remote' ? 'branch' : ref.current ? 'check' : 'branch'
  return (
    <div
      className={cls('side-item', ref.current && 'current', selected && 'selected')}
      style={{ paddingLeft: 10 + depth * 14 }}
      onClick={() => selectSha(ref.sha)}
      onDoubleClick={() => checkoutRef(ref)}
      onContextMenu={(e) => showMenu(e, refMenu(ref))}
      title={ref.upstream ? `${ref.short} → ${ref.upstream}${ref.gone ? ' (gone)' : ''}` : ref.short}
    >
      <Icon name={icon} size={12} className={cls(ref.current && 'accent')} />
      <span className="side-label">{label}</span>
      {ref.gone && <span className="side-gone">gone</span>}
      {pr && <PrChip pr={pr} />}
      {(ref.behind ?? 0) > 0 && <span className="ab down">↓{ref.behind}</span>}
      {(ref.ahead ?? 0) > 0 && <span className="ab up">↑{ref.ahead}</span>}
    </div>
  )
}

function StashItem({ stash, selected }: { stash: Stash; selected: boolean }) {
  return (
    <div
      className={cls('side-item', selected && 'selected')}
      style={{ paddingLeft: 24 }}
      onClick={() => selectSha(stash.sha)}
      onContextMenu={(e) => showMenu(e, stashMenu(stash))}
      title={stash.message}
    >
      <Icon name="stashItem" size={12} />
      <span className="side-label">{stash.message.replace(/^(WIP on|On) [^:]+: /, '')}</span>
    </div>
  )
}
