import type { MouseEvent } from 'react'
import type { PrFilter, PrListItem } from '../../../shared/types'
import { copy, openUrl } from '../actions'
import { checkoutPr, createPullRequestDialog } from '../prActions'
import { loadPrList, openPr, setPrListFilter, showMenu, useStore } from '../store'
import { cls, relativeTime } from '../util'
import { Icon } from './Icon'
import { GhAvatar } from './Markdown'
import { CheckIcon, PrStateIcon, ReviewDecisionBadge } from './PrBits'

const FILTERS: { key: PrFilter; label: string }[] = [
  { key: 'review-requested', label: 'Review requests' },
  { key: 'assigned', label: 'Assigned to me' },
  { key: 'created', label: 'Created by me' },
  { key: 'involves', label: 'Involves me' },
  { key: 'all', label: 'All pull requests' }
]

function itemMenu(e: MouseEvent, pr: PrListItem) {
  showMenu(e, [
    { label: `Open #${pr.number}`, action: () => openPr(pr.number) },
    { label: 'Files changed', action: () => openPr(pr.number, 'files') },
    { separator: true },
    { label: `Check out ${pr.headRef}`, action: () => checkoutPr(pr) },
    { separator: true },
    { label: 'Open on GitHub', action: () => openUrl(pr.url) },
    { label: 'Copy link', action: () => copy(pr.url, 'Link copied') }
  ])
}

export function PullRequestList({ open, onToggle, query }: { open: boolean; onToggle: () => void; query: string }) {
  const info = useStore((s) => s.github?.info)
  const list = useStore((s) => s.prList)
  const openNumber = useStore((s) => s.prView?.number)
  if (!info) return null

  const counts = list.result?.counts
  const items = (list.result?.items ?? []).filter(
    (p) => !query || p.title.toLowerCase().includes(query) || String(p.number).includes(query) || p.headRef.toLowerCase().includes(query)
  )
  const reviewCount = counts?.['review-requested'] ?? 0

  return (
    <div className="side-section">
      <div className="side-header" onClick={onToggle}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={10} />
        <span>PULL REQUESTS</span>
        {reviewCount > 0 && (
          <span className="side-badge" title={`${reviewCount} review request(s)`}>
            {reviewCount}
          </span>
        )}
        <span className="side-header-actions" onClick={(e) => e.stopPropagation()}>
          <button className="icon-btn" title="Create pull request" onClick={() => createPullRequestDialog()}>
            <Icon name="plus" size={12} />
          </button>
          <button className="icon-btn" title="Refresh" onClick={() => loadPrList(true)}>
            {list.loading ? <span className="spinner" /> : <Icon name="refresh" size={12} />}
          </button>
        </span>
      </div>
      {open && (
        <div className="pr-list">
          {info.authenticated && (
            <div className="pr-filter">
              <select value={list.filter} onChange={(e) => setPrListFilter({ filter: e.target.value as PrFilter })}>
                {FILTERS.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                    {counts ? ` (${counts[f.key]})` : ''}
                  </option>
                ))}
              </select>
              <span className="seg">
                <button className={cls(list.state === 'open' && 'on')} onClick={() => setPrListFilter({ state: 'open' })}>
                  Open
                </button>
                <button className={cls(list.state === 'closed' && 'on')} onClick={() => setPrListFilter({ state: 'closed' })}>
                  Closed
                </button>
              </span>
            </div>
          )}
          {list.error && <div className="side-note error-text">{list.error}</div>}
          {!list.error && !list.result && list.loading && <div className="side-note">Loading pull requests…</div>}
          {!list.error && list.result && items.length === 0 && !list.loading && <div className="side-note">No pull requests here.</div>}
          {items.map((pr) => (
            <div
              key={pr.number}
              className={cls('pr-item', openNumber === pr.number && 'selected')}
              onClick={() => openPr(pr.number)}
              onContextMenu={(e) => itemMenu(e, pr)}
              title={`#${pr.number} ${pr.title}\n${pr.headRef} → ${pr.baseRef}`}
            >
              <PrStateIcon state={pr.state} draft={pr.draft} />
              <div className="pr-item-body">
                <div className="pr-item-title">{pr.title}</div>
                <div className="pr-item-meta">
                  <span>#{pr.number}</span>
                  <GhAvatar user={pr.author} size={14} />
                  <span className="pr-item-author">{pr.author?.login}</span>
                  <span>· {relativeTime(Date.parse(pr.updatedAt) / 1000)}</span>
                </div>
                {(pr.reviewDecision || pr.checkState || pr.comments > 0) && (
                  <div className="pr-item-meta">
                    <ReviewDecisionBadge decision={pr.reviewDecision} />
                    <CheckIcon state={pr.checkState} />
                    {pr.comments > 0 && (
                      <span className="pr-item-comments">
                        <Icon name="comment" size={11} /> {pr.comments}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
