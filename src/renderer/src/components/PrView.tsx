import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { DiffLine, DiffSide, PrComment, PrDetail, PrFile, PrReviewThread, PrTimelineItem } from '../../../shared/types'
import { copy, openUrl } from '../actions'
import {
  checkoutPr,
  discardPendingReview,
  editTitle,
  headLabel,
  mergeDialog,
  mergeMethodLabel,
  preferredMergeMethod,
  prRef,
  reviewDialog,
  setPrState,
  toggleDraft
} from '../prActions'
import { closePr, loadPrDetail, loadPrFiles, prRun, selectSha, setPrTab, showMenu, useStore, type PrTab } from '../store'
import { cls, formatDate, plural, relativeTime } from '../util'
import { Icon } from './Icon'
import { GhAvatar, Markdown, MarkdownEditor } from './Markdown'
import { CheckIcon, PrStateBadge, ReviewStateIcon } from './PrBits'

const ago = (iso: string) => (iso ? relativeTime(Date.parse(iso) / 1000) : '')
const isTyping = () => {
  const el = document.activeElement
  return el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement || el instanceof HTMLSelectElement
}

// ------------------------------------------------------------------ comments

interface CardProps {
  author: PrComment['author']
  createdAt: string
  bodyHTML: string
  body: string
  prAuthor?: string
  pending?: boolean
  label?: ReactNode
  canEdit: boolean
  canDelete: boolean
  onSave: (body: string) => Promise<boolean>
  onDelete?: () => void
  compact?: boolean
}

function CommentCard(p: CardProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(p.body)
  const save = async () => {
    if (await p.onSave(draft)) setEditing(false)
  }
  return (
    <div className={cls('c-card', p.compact && 'compact', p.pending && 'pending')}>
      <div className="c-head">
        <GhAvatar user={p.author} size={p.compact ? 18 : 22} />
        <strong>{p.author?.login ?? 'ghost'}</strong>
        <span className="muted">{p.label ?? 'commented'}</span>
        <span className="muted" title={p.createdAt ? formatDate(Date.parse(p.createdAt) / 1000) : ''}>
          {ago(p.createdAt)}
        </span>
        {p.pending && <span className="tag tag-pending">Pending</span>}
        {p.prAuthor && p.author?.login === p.prAuthor && <span className="tag">Author</span>}
        <span className="spacer" />
        {(p.canEdit || p.canDelete) && !editing && (
          <button
            className="icon-btn"
            onClick={(e) =>
              showMenu(e, [
                { label: 'Edit', action: () => (setDraft(p.body), setEditing(true)), disabled: !p.canEdit },
                { label: 'Copy Markdown', action: () => copy(p.body, 'Comment copied') },
                { separator: true },
                { label: 'Delete', action: p.onDelete, danger: true, disabled: !p.canDelete || !p.onDelete }
              ])
            }
          >
            <Icon name="more" size={14} />
          </button>
        )}
      </div>
      {editing ? (
        <div className="c-edit">
          <MarkdownEditor value={draft} onChange={setDraft} onSubmit={save} autoFocus />
          <div className="composer-actions">
            <button className="btn btn-sm" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button className="btn btn-sm btn-primary" onClick={save}>
              Update comment
            </button>
          </div>
        </div>
      ) : p.bodyHTML.trim() ? (
        <Markdown html={p.bodyHTML} className="c-body" />
      ) : (
        <div className="c-body muted">
          <em>No description provided.</em>
        </div>
      )}
    </div>
  )
}

function ReviewComment({ comment, pr }: { comment: PrComment; pr: PrDetail }) {
  return (
    <CommentCard
      compact
      author={comment.author}
      createdAt={comment.createdAt}
      body={comment.body}
      bodyHTML={comment.bodyHTML}
      prAuthor={pr.author?.login}
      pending={comment.pending}
      label=""
      canEdit={comment.viewerCanUpdate}
      canDelete={comment.viewerCanDelete}
      onSave={(body) => prRun('Updating comment', (api) => api.prEditComment('review', comment.id, body), { files: true })}
      onDelete={() => prRun('Deleting comment', (api) => api.prDeleteComment('review', comment.id), { files: true })}
    />
  )
}

/** Last few lines of a thread's diff hunk, for context in the conversation. */
function HunkSnippet({ hunk }: { hunk: string }) {
  const lines = hunk.split('\n').filter((l) => !l.startsWith('@@')).slice(-4)
  return (
    <div className="hunk-snippet">
      {lines.map((l, i) => (
        <div key={i} className={cls('dl', l[0] === '+' && 'add', l[0] === '-' && 'del')}>
          <span className="sign">{l[0] === '+' || l[0] === '-' ? l[0] : ''}</span>
          <span className="code">{l.slice(1) || ' '}</span>
        </div>
      ))}
    </div>
  )
}

function ThreadCard({ thread, pr, withContext }: { thread: PrReviewThread; pr: PrDetail; withContext?: boolean }) {
  const [expanded, setExpanded] = useState(!thread.isResolved)
  const [replying, setReplying] = useState(false)
  const [text, setText] = useState('')
  const pending = pr.pendingReview?.id

  const reply = async () => {
    if (!text.trim()) return
    const ok = await prRun(
      'Replying',
      (api) => api.prReplyToThread(prRef(pr), thread.id, thread.comments[0]?.databaseId ?? 0, text, pending),
      { files: true }
    )
    if (ok) {
      setText('')
      setReplying(false)
    }
  }
  const lineLabel = thread.line
    ? thread.startLine && thread.startLine !== thread.line
      ? `lines ${thread.startLine}–${thread.line}`
      : `line ${thread.line}`
    : thread.originalLine
      ? `originally line ${thread.originalLine}`
      : ''

  return (
    <div className={cls('thread', thread.isResolved && 'resolved')}>
      <div className="thread-head" onClick={() => setExpanded((v) => !v)}>
        <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={10} />
        <Icon name="file" size={12} />
        <span className="thread-path">{thread.path}</span>
        <span className="muted">{lineLabel}</span>
        {thread.isOutdated && <span className="tag">Outdated</span>}
        {thread.isResolved && <span className="tag tag-resolved">Resolved</span>}
        <span className="spacer" />
        {!expanded && <span className="muted">{plural(thread.comments.length, 'comment')}</span>}
      </div>
      {expanded && (
        <>
          {withContext && thread.diffHunk && <HunkSnippet hunk={thread.diffHunk} />}
          {thread.comments.map((c) => (
            <ReviewComment key={c.id} comment={c} pr={pr} />
          ))}
          <div className="thread-actions">
            {thread.viewerCanReply &&
              (replying ? (
                <div className="thread-reply">
                  <MarkdownEditor value={text} onChange={setText} onSubmit={reply} placeholder="Reply…" autoFocus minHeight={60} />
                  <div className="composer-actions">
                    <button className="btn btn-sm" onClick={() => setReplying(false)}>
                      Cancel
                    </button>
                    <button className="btn btn-sm btn-primary" disabled={!text.trim()} onClick={reply}>
                      {pending ? 'Add review comment' : 'Reply'}
                    </button>
                  </div>
                </div>
              ) : (
                <button className="reply-stub" onClick={() => setReplying(true)}>
                  Reply…
                </button>
              ))}
            {(thread.isResolved ? thread.viewerCanUnresolve : thread.viewerCanResolve) && !replying && (
              <button
                className="btn btn-sm"
                onClick={() => prRun(thread.isResolved ? 'Unresolving' : 'Resolving', (api) => api.prResolveThread(thread.id, !thread.isResolved), { files: true })}
              >
                {thread.isResolved ? 'Unresolve conversation' : 'Resolve conversation'}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ conversation

type TimelineBlock = PrTimelineItem | { type: 'commits'; items: Extract<PrTimelineItem, { type: 'commit' }>[] }

function groupTimeline(items: PrTimelineItem[]): TimelineBlock[] {
  const blocks: TimelineBlock[] = []
  for (const item of items) {
    const last = blocks[blocks.length - 1]
    if (item.type === 'commit') {
      if (last?.type === 'commits') last.items.push(item)
      else blocks.push({ type: 'commits', items: [item] })
    } else blocks.push(item)
  }
  return blocks
}

const REVIEW_VERB: Record<string, string> = {
  APPROVED: 'approved these changes',
  CHANGES_REQUESTED: 'requested changes',
  COMMENTED: 'reviewed',
  DISMISSED: 'reviewed (dismissed)'
}

function MergeBox({ pr }: { pr: PrDetail }) {
  if (pr.state === 'merged') {
    return (
      <div className="merge-box merged">
        <Icon name="merge" size={16} />
        <div>
          <strong>Pull request successfully merged</strong>
          <div className="muted">
            {pr.mergedBy ? `${pr.mergedBy.login} merged ` : 'Merged '}
            {ago(pr.mergedAt ?? '')} into {pr.baseRef}
          </div>
        </div>
      </div>
    )
  }
  if (pr.state === 'closed') {
    return (
      <div className="merge-box closed">
        <Icon name="pr" size={16} />
        <div>
          <strong>Closed with unmerged commits</strong>
          <div className="muted">This pull request is closed.</div>
        </div>
        {pr.viewer.canUpdate && (
          <button className="btn btn-sm" onClick={() => setPrState(pr, 'open')}>
            Reopen pull request
          </button>
        )}
      </div>
    )
  }

  const rows: { icon: string; tone: string; title: string; detail?: string }[] = []
  if (pr.reviewDecision === 'APPROVED') rows.push({ icon: 'check', tone: 'ok', title: 'Changes approved' })
  else if (pr.reviewDecision === 'CHANGES_REQUESTED') rows.push({ icon: 'close', tone: 'bad', title: 'Changes requested', detail: 'A reviewer requested changes.' })
  else if (pr.reviewDecision === 'REVIEW_REQUIRED') rows.push({ icon: 'dot', tone: 'warn', title: 'Review required', detail: 'At least one approving review is required.' })

  if (pr.checkState === 'success') rows.push({ icon: 'check', tone: 'ok', title: 'All checks have passed' })
  else if (pr.checkState === 'failure') rows.push({ icon: 'close', tone: 'bad', title: 'Some checks were not successful' })
  else if (pr.checkState === 'pending') rows.push({ icon: 'dot', tone: 'warn', title: 'Some checks haven’t completed yet' })

  if (pr.mergeable === 'CONFLICTING') rows.push({ icon: 'close', tone: 'bad', title: 'This branch has conflicts that must be resolved', detail: `Merge ${pr.baseRef} into ${pr.headRef} locally, then push.` })
  else if (pr.mergeStateStatus === 'BEHIND') rows.push({ icon: 'dot', tone: 'warn', title: 'This branch is out-of-date with the base branch' })
  else if (pr.mergeStateStatus === 'BLOCKED') rows.push({ icon: 'dot', tone: 'warn', title: 'Merging is blocked', detail: 'Branch protection rules are not satisfied yet.' })
  else if (pr.mergeable === 'UNKNOWN') rows.push({ icon: 'dot', tone: 'warn', title: 'Checking for merge conflicts…' })
  else rows.push({ icon: 'check', tone: 'ok', title: 'No conflicts with the base branch' })

  const method = preferredMergeMethod(pr)
  const canMerge = pr.viewer.canMerge && !pr.draft && pr.mergeable !== 'CONFLICTING' && !!method

  return (
    <div className="merge-box">
      {rows.map((r, i) => (
        <div key={i} className={cls('merge-row', `tone-${r.tone}`)}>
          <span className="merge-icon">
            <Icon name={r.icon} size={14} />
          </span>
          <div>
            <strong>{r.title}</strong>
            {r.detail && <div className="muted">{r.detail}</div>}
          </div>
        </div>
      ))}
      <div className="merge-actions">
        {pr.draft ? (
          pr.viewer.canUpdate && (
            <>
              <span className="muted">This pull request is still a work in progress.</span>
              <button className="btn btn-primary" onClick={() => toggleDraft(pr)}>
                Ready for review
              </button>
            </>
          )
        ) : pr.viewer.canMerge && method ? (
          <span className="split-btn merge-split">
            <button className="btn btn-merge" disabled={!canMerge} onClick={() => mergeDialog(pr, method)}>
              {mergeMethodLabel(method)}
            </button>
            <button
              className="btn btn-merge caret"
              disabled={!canMerge || pr.mergeMethods.length < 2}
              onClick={(e) => showMenu(e, pr.mergeMethods.map((m) => ({ label: mergeMethodLabel(m), action: () => mergeDialog(pr, m) })))}
            >
              <Icon name="chevronDown" size={11} />
            </button>
          </span>
        ) : (
          <span className="muted">Only people with write access can merge.</span>
        )}
      </div>
    </div>
  )
}

function NewComment({ pr }: { pr: PrDetail }) {
  const [text, setText] = useState('')
  const submit = async () => {
    if (!text.trim()) return
    if (await prRun('Commenting', (api) => api.prAddComment(prRef(pr), text))) setText('')
  }
  const toggle = async () => {
    const next = pr.state === 'open' ? 'closed' : 'open'
    if (await setPrState(pr, next, text)) setText('')
  }
  return (
    <div className="new-comment">
      <GhAvatar user={{ login: pr.viewer.login, avatarUrl: pr.viewer.avatarUrl }} size={28} />
      <div className="new-comment-box">
        <MarkdownEditor value={text} onChange={setText} onSubmit={submit} placeholder="Leave a comment" />
        <div className="composer-actions">
          {pr.viewer.canUpdate && pr.state !== 'merged' && (
            <button className="btn" onClick={toggle}>
              {pr.state === 'open' ? (text.trim() ? 'Close with comment' : 'Close pull request') : text.trim() ? 'Reopen with comment' : 'Reopen pull request'}
            </button>
          )}
          <button className="btn btn-commit-sm" disabled={!text.trim()} onClick={submit}>
            Comment
          </button>
        </div>
      </div>
    </div>
  )
}

function PendingReviewBanner({ pr }: { pr: PrDetail }) {
  if (!pr.pendingReview) return null
  return (
    <div className="pending-banner">
      <Icon name="comment" size={14} />
      <span>
        You have a pending review with {plural(pr.pendingReview.comments, 'comment')}. Others can’t see them until you submit.
      </span>
      <span className="spacer" />
      <button className="btn btn-sm" onClick={() => discardPendingReview(pr)}>
        Discard
      </button>
      <button className="btn btn-sm btn-primary" onClick={() => reviewDialog(pr)}>
        Submit review
      </button>
    </div>
  )
}

function Conversation({ pr }: { pr: PrDetail }) {
  const threadsByReview = useMemo(() => {
    const map = new Map<string, PrReviewThread[]>()
    for (const t of pr.threads) {
      const key = t.reviewId ?? ''
      map.set(key, [...(map.get(key) ?? []), t])
    }
    return map
  }, [pr.threads])
  const shownReviews = new Set(pr.timeline.filter((i) => i.type === 'review').map((i) => (i as { id: string }).id))
  const orphanThreads = pr.threads.filter((t) => !t.comments.some((c) => c.pending) && !(t.reviewId && shownReviews.has(t.reviewId)))

  return (
    <div className="conversation">
      <PendingReviewBanner pr={pr} />
      <CommentCard
        author={pr.author}
        createdAt={pr.createdAt}
        body={pr.body}
        bodyHTML={pr.bodyHTML}
        label="opened this pull request"
        canEdit={pr.viewer.canUpdate}
        canDelete={false}
        onSave={(body) => prRun('Updating description', (api) => api.prUpdate(prRef(pr), { body }))}
      />
      {groupTimeline(pr.timeline).map((block, i) => {
        switch (block.type) {
          case 'comment': {
            const c = block.comment
            return (
              <CommentCard
                key={c.id}
                author={c.author}
                createdAt={c.createdAt}
                body={c.body}
                bodyHTML={c.bodyHTML}
                prAuthor={pr.author?.login}
                canEdit={c.viewerCanUpdate}
                canDelete={c.viewerCanDelete}
                onSave={(body) => prRun('Updating comment', (api) => api.prEditComment('issue', c.id, body))}
                onDelete={() => prRun('Deleting comment', (api) => api.prDeleteComment('issue', c.id))}
              />
            )
          }
          case 'review': {
            const threads = threadsByReview.get(block.id) ?? []
            if (!block.body.trim() && threads.length === 0 && block.state === 'COMMENTED') return null
            return (
              <div key={block.id} className="tl-review">
                <div className="tl-line">
                  <ReviewStateIcon state={block.state} />
                  <GhAvatar user={block.author} size={18} />
                  <strong>{block.author?.login ?? 'ghost'}</strong>
                  <span className="muted">
                    {REVIEW_VERB[block.state] ?? 'reviewed'} {ago(block.createdAt)}
                  </span>
                </div>
                {block.body.trim() && <Markdown html={block.bodyHTML} className="tl-review-body" />}
                {threads.map((t) => (
                  <ThreadCard key={t.id} thread={t} pr={pr} withContext />
                ))}
              </div>
            )
          }
          case 'commits':
            return (
              <div key={`commits-${i}`} className="tl-commits">
                <div className="tl-line muted">
                  <Icon name="branch" size={13} /> {plural(block.items.length, 'commit')} added
                </div>
                {block.items.map((c) => (
                  <div key={c.oid} className="tl-commit">
                    <span className="tl-commit-msg">{c.headline}</span>
                    <code>{c.abbreviatedOid}</code>
                  </div>
                ))}
              </div>
            )
          case 'event':
            return (
              <div key={`ev-${i}`} className={cls('tl-line', 'tl-event', `ev-${block.kind}`)}>
                <Icon name={block.kind === 'merged' ? 'merge' : block.kind.includes('label') ? 'tag' : 'dot'} size={12} />
                <GhAvatar user={block.actor} size={16} />
                <strong>{block.actor?.login ?? 'ghost'}</strong>
                <span className="muted">
                  {block.text} {ago(block.createdAt)}
                </span>
              </div>
            )
          default:
            return null
        }
      })}
      {pr.timelineTotal > 100 && (
        <div className="tl-line muted">
          Showing the first 100 events. <button className="link-btn small" onClick={() => openUrl(pr.url)}>See all on GitHub</button>
        </div>
      )}
      {orphanThreads.length > 0 && (
        <div className="tl-review">
          <div className="tl-line muted">Other review conversations</div>
          {orphanThreads.map((t) => (
            <ThreadCard key={t.id} thread={t} pr={pr} withContext />
          ))}
        </div>
      )}
      <MergeBox pr={pr} />
      <NewComment pr={pr} />
    </div>
  )
}

// ------------------------------------------------------------------ commits & checks

function Commits({ pr }: { pr: PrDetail }) {
  const local = useStore((s) => s.snap?.commits)
  const localSet = useMemo(() => new Set(local?.map((c) => c.sha)), [local])
  return (
    <div className="pr-list-view">
      {pr.commits.map((c) => (
        <div
          key={c.oid}
          className="pr-commit-row"
          onClick={() => (localSet.has(c.oid) ? selectSha(c.oid) : openUrl(`${pr.url}/commits/${c.oid}`))}
          title={localSet.has(c.oid) ? 'Show in graph' : 'Not in your local history; opens on GitHub'}
        >
          <GhAvatar user={{ login: c.author, avatarUrl: c.avatarUrl }} size={20} />
          <span className="pr-commit-msg">{c.headline}</span>
          <CheckIcon state={c.checkState} />
          <span className="muted">
            {c.author} · {ago(c.date)}
          </span>
          <code>{c.abbreviatedOid}</code>
        </div>
      ))}
      {pr.commits.length === 0 && <div className="empty-state">No commits.</div>}
    </div>
  )
}

function Checks({ pr }: { pr: PrDetail }) {
  const order = { failure: 0, pending: 1, success: 2, neutral: 3, skipped: 4 }
  const checks = [...pr.checks].sort((a, b) => order[a.state] - order[b.state] || a.name.localeCompare(b.name))
  const count = (s: string) => checks.filter((c) => c.state === s).length
  return (
    <div className="pr-list-view">
      {checks.length > 0 && (
        <div className="checks-summary">
          <CheckIcon state={pr.checkState} size={14} />
          <span>
            {count('success')} successful, {count('failure')} failing, {count('pending')} in progress
            {count('skipped') + count('neutral') > 0 ? `, ${count('skipped') + count('neutral')} skipped or neutral` : ''}
          </span>
        </div>
      )}
      {checks.map((c, i) => (
        <div key={i} className="check-row">
          <CheckIcon state={c.state} size={14} />
          <span className="check-name">{c.name}</span>
          {c.description && <span className="muted check-desc">{c.description}</span>}
          <span className="spacer" />
          {c.url && (
            <button className="link-btn small" onClick={() => openUrl(c.url!)}>
              Details
            </button>
          )}
        </div>
      ))}
      {checks.length === 0 && <div className="empty-state">No checks were reported for the latest commit.</div>}
    </div>
  )
}

// ------------------------------------------------------------------ files changed

interface Composer {
  side: DiffSide
  line: number
  startLine?: number
}

const anchorOf = (l: DiffLine): { side: DiffSide; line: number } | null =>
  l.type === '-' ? { side: 'LEFT', line: l.oldNo! } : l.type === '+' || l.type === ' ' ? { side: 'RIGHT', line: l.newNo! } : null

function FileCard({ file, pr, threads }: { file: PrFile; pr: PrDetail; threads: PrReviewThread[] }) {
  const lineCount = file.diff?.hunks.reduce((n, h) => n + h.lines.length, 0) ?? 0
  const [open, setOpen] = useState(lineCount <= 800)
  const [composer, setComposer] = useState<Composer | null>(null)
  const [text, setText] = useState('')

  const anchored = useMemo(() => {
    const map = new Map<string, PrReviewThread[]>()
    for (const t of threads) if (t.line !== null) map.set(`${t.side}:${t.line}`, [...(map.get(`${t.side}:${t.line}`) ?? []), t])
    return map
  }, [threads])

  // Threads that don't attach to any visible line (outdated, or outside the shown hunks).
  const floating = useMemo(() => {
    const visible = new Set<string>()
    for (const h of file.diff?.hunks ?? [])
      for (const l of h.lines) {
        if (l.newNo !== undefined) visible.add(`RIGHT:${l.newNo}`)
        if (l.oldNo !== undefined) visible.add(`LEFT:${l.oldNo}`)
      }
    return threads.filter((t) => t.line === null || !visible.has(`${t.side}:${t.line}`))
  }, [threads, file.diff])

  const startComment = (l: DiffLine, extend: boolean) => {
    const a = anchorOf(l)
    if (!a) return
    if (extend && composer && composer.side === a.side && a.line !== composer.line) {
      const lo = Math.min(composer.startLine ?? composer.line, a.line)
      const hi = Math.max(composer.line, a.line)
      setComposer({ side: a.side, line: hi, startLine: lo })
    } else setComposer({ side: a.side, line: a.line })
  }

  const submit = async (mode: 'single' | 'review') => {
    if (!composer || !text.trim()) return
    const ok = await prRun(
      mode === 'single' ? 'Commenting' : 'Adding review comment',
      (api) =>
        api.prAddReviewComment(prRef(pr), {
          path: file.path,
          line: composer.line,
          side: composer.side,
          startLine: composer.startLine,
          startSide: composer.startLine ? composer.side : undefined,
          body: text,
          mode,
          commitId: pr.headOid,
          pendingReviewId: pr.pendingReview?.id
        }),
      { files: true }
    )
    if (ok) {
      setComposer(null)
      setText('')
    }
  }

  const inRange = (a: { side: DiffSide; line: number } | null) =>
    !!a && !!composer && a.side === composer.side && a.line >= (composer.startLine ?? composer.line) && a.line <= composer.line

  const renderThreads = (keys: string[]) =>
    keys.flatMap((k) => anchored.get(k) ?? []).map((t) => <ThreadCard key={t.id} thread={t} pr={pr} />)

  return (
    <div className="file-card">
      <div className="file-card-head" onClick={() => setOpen((v) => !v)}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={10} />
        <span className={cls('file-status', `fs-${file.status}`)}>{file.status}</span>
        <span className="file-card-path" title={file.path}>
          {file.previousPath ? `${file.previousPath} → ` : ''}
          {file.path}
        </span>
        {threads.length > 0 && (
          <span className="muted file-threads">
            <Icon name="comment" size={11} /> {threads.length}
          </span>
        )}
        <span className="spacer" />
        <span className="adds">+{file.additions}</span>
        <span className="dels">−{file.deletions}</span>
      </div>
      {open && (
        <div className="file-card-body">
          {floating.map((t) => (
            <ThreadCard key={t.id} thread={t} pr={pr} withContext />
          ))}
          {!file.diff ? (
            <div className="diff-msg">
              No diff available (binary or very large file).{' '}
              <button className="link-btn small" onClick={() => openUrl(`${pr.url}/files`)}>
                View on GitHub
              </button>
            </div>
          ) : (
            file.diff.hunks.map((hunk, hi) => (
              <div key={hi} className="pr-hunk">
                <div className="hunk-head">
                  <span className="hunk-title">{hunk.header}</span>
                </div>
                {hunk.lines.map((l, li) => {
                  const a = anchorOf(l)
                  const keys = l.type === ' ' ? [`RIGHT:${l.newNo}`, `LEFT:${l.oldNo}`] : a ? [`${a.side}:${a.line}`] : []
                  const composerHere = composer && a && composer.side === a.side && composer.line === a.line
                  return (
                    <div key={li}>
                      <div className={cls('dl', l.type === '+' && 'add', l.type === '-' && 'del', l.type === '\\' && 'meta', inRange(a) && 'range')}>
                        <span className="gutter">
                          <span className="ln">{l.oldNo ?? ''}</span>
                          <span className="ln">{l.newNo ?? ''}</span>
                          {a && (
                            <button
                              className="add-comment"
                              title="Comment on this line (Shift-click another line for a range)"
                              onMouseDown={(e) => {
                                e.preventDefault()
                                startComment(l, e.shiftKey)
                              }}
                            >
                              +
                            </button>
                          )}
                          <span className="sign">{l.type === '+' || l.type === '-' ? l.type : ''}</span>
                        </span>
                        <span className="code">{l.type === '\\' ? l.text : l.text.replace(/\r$/, '') || ' '}</span>
                      </div>
                      {renderThreads(keys)}
                      {composerHere && (
                        <div className="inline-composer">
                          <div className="muted small">
                            {composer.startLine ? `Commenting on lines ${composer.startLine}–${composer.line}` : `Commenting on line ${composer.line}`}
                          </div>
                          <MarkdownEditor
                            value={text}
                            onChange={setText}
                            onSubmit={() => submit(pr.pendingReview ? 'review' : 'single')}
                            placeholder="Leave a comment (```suggestion blocks work too)"
                            autoFocus
                            minHeight={70}
                          />
                          <div className="composer-actions">
                            <button className="btn btn-sm" onClick={() => setComposer(null)}>
                              Cancel
                            </button>
                            {pr.pendingReview ? (
                              <button className="btn btn-sm btn-primary" disabled={!text.trim()} onClick={() => submit('review')}>
                                Add review comment
                              </button>
                            ) : (
                              <>
                                <button className="btn btn-sm" disabled={!text.trim()} onClick={() => submit('single')}>
                                  Add single comment
                                </button>
                                <button className="btn btn-sm btn-primary" disabled={!text.trim()} onClick={() => submit('review')}>
                                  Start a review
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

function Files({ pr }: { pr: PrDetail }) {
  const files = useStore((s) => s.prFiles[pr.number])
  useEffect(() => {
    if (!files) void loadPrFiles(pr.number)
  }, [pr.number, files])
  const byPath = useMemo(() => {
    const map = new Map<string, PrReviewThread[]>()
    for (const t of pr.threads) map.set(t.path, [...(map.get(t.path) ?? []), t])
    return map
  }, [pr.threads])

  if (!files?.data) {
    return <div className="empty-state">{files?.error ?? 'Loading files…'}</div>
  }
  return (
    <div className="pr-files">
      <PendingReviewBanner pr={pr} />
      <div className="files-summary muted">
        {plural(files.data.length, 'file')} changed · <span className="adds">+{pr.additions}</span> <span className="dels">−{pr.deletions}</span>
        <span className="spacer" />
        Click + next to a line to comment · Shift-click for a range
      </div>
      {files.data.map((f) => (
        <FileCard key={f.path} file={f} pr={pr} threads={byPath.get(f.path) ?? []} />
      ))}
    </div>
  )
}

// ------------------------------------------------------------------ view

const TABS: { key: PrTab; label: string }[] = [
  { key: 'conversation', label: 'Conversation' },
  { key: 'commits', label: 'Commits' },
  { key: 'checks', label: 'Checks' },
  { key: 'files', label: 'Files changed' }
]

export function PrView() {
  const view = useStore((s) => s.prView)!
  const entry = useStore((s) => s.prDetails[view.number])
  const repo = useStore((s) => s.github?.info?.repo)
  const pr = entry?.data
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scroller.current?.scrollTo(0, 0)
  }, [view.number, view.tab])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { dialog, menu, picker } = useStore.getState()
      if (e.key === 'Escape' && !dialog && !menu && !picker && !isTyping()) closePr()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!pr) {
    return (
      <div className="pr-view">
        <div className="pr-header">
          <div className="pr-title-row">
            <h1>#{view.number}</h1>
            <span className="spacer" />
            <button className="icon-btn" onClick={closePr} title="Close (Esc)">
              <Icon name="close" size={14} />
            </button>
          </div>
        </div>
        <div className="empty-state">
          {entry?.error ? (
            <>
              <div className="error-text">{entry.error}</div>
              <button className="btn btn-sm" onClick={() => loadPrDetail(view.number)}>
                Retry
              </button>
            </>
          ) : (
            'Loading pull request…'
          )}
        </div>
      </div>
    )
  }

  const counts: Record<PrTab, number> = {
    conversation: pr.timeline.filter((i) => i.type === 'comment' || i.type === 'review').length,
    commits: pr.commits.length,
    checks: pr.checks.length,
    files: pr.changedFiles
  }

  return (
    <div className="pr-view">
      <div className="pr-header">
        <div className="pr-title-row">
          <h1 title={pr.title}>
            {pr.title} <span className="pr-num">#{pr.number}</span>
          </h1>
          <span className="spacer" />
          {pr.viewer.canUpdate && (
            <button className="btn btn-sm" onClick={() => editTitle(pr)}>
              Edit
            </button>
          )}
          <button className="btn btn-sm" onClick={() => checkoutPr(pr)} title={`Check out ${pr.headRef} locally`}>
            <Icon name="branch" size={12} /> Checkout
          </button>
          <button className="icon-btn" title="Open on GitHub" onClick={() => openUrl(pr.url)}>
            <Icon name="external" size={14} />
          </button>
          <button className="icon-btn" title="Refresh" onClick={() => loadPrDetail(pr.number)}>
            {entry?.loading ? <span className="spinner" /> : <Icon name="refresh" size={14} />}
          </button>
          <button className="icon-btn" title="Close (Esc)" onClick={closePr}>
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="pr-subtitle">
          <PrStateBadge state={pr.state} draft={pr.draft} />
          <strong>{pr.author?.login ?? 'ghost'}</strong>
          <span className="muted">{pr.state === 'merged' ? 'merged' : 'wants to merge'}</span>
          {plural(pr.commits.length, 'commit')}
          <span className="muted">into</span>
          <code className="branch-code">{pr.baseRef}</code>
          <span className="muted">from</span>
          <code className="branch-code" onClick={() => copy(pr.headRef, 'Branch name copied')} title="Copy branch name">
            {headLabel(pr, repo)}
          </code>
        </div>
      </div>
      <div className="pr-tabs">
        {TABS.map((t) => (
          <button key={t.key} className={cls('pr-tab', view.tab === t.key && 'on')} onClick={() => setPrTab(t.key)}>
            {t.label}
            <span className="pr-tab-count">{counts[t.key]}</span>
            {t.key === 'checks' && <CheckIcon state={pr.checkState} />}
          </button>
        ))}
        <span className="spacer" />
        <span className="adds">+{pr.additions}</span>
        <span className="dels">−{pr.deletions}</span>
        {pr.state === 'open' && (
          <button className="btn btn-sm btn-primary" onClick={() => reviewDialog(pr)}>
            Review changes{pr.pendingReview ? ` (${pr.pendingReview.comments})` : ''}
          </button>
        )}
      </div>
      <div className="pr-scroll" ref={scroller}>
        {view.tab === 'conversation' && <Conversation pr={pr} />}
        {view.tab === 'commits' && <Commits pr={pr} />}
        {view.tab === 'checks' && <Checks pr={pr} />}
        {view.tab === 'files' && <Files pr={pr} />}
      </div>
    </div>
  )
}
