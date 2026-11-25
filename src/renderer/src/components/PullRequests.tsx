import { useEffect } from 'react'
import type { PullRequest, Ref } from '../../../shared/types'
import { openUrl } from '../actions'
import { canCreatePr, createPullRequestDialog } from '../prActions'
import { mergePullRequests, prForRef, prStateLabel, remoteBranchOf } from '../github'
import { loadCommitPrs, openPr, refreshPullRequests, useStore } from '../store'
import { cls } from '../util'
import { Icon } from './Icon'

/** Compact "#123" badge for a branch with an open pull request; click opens it on GitHub. */
export function PrChip({ pr }: { pr: PullRequest }) {
  const { key, label } = prStateLabel(pr)
  return (
    <span
      className={cls('pr-chip', `pr-${key}`)}
      title={`${label} pull request #${pr.number}: ${pr.title}\nClick to open`}
      onClick={(e) => {
        e.stopPropagation()
        openPr(pr.number)
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <Icon name="pr" size={10} />
      {pr.number}
    </span>
  )
}

/** Open PR for a ref, read from the store (stable identity, safe in selectors). */
export function useRefPr(ref: Ref): PullRequest | undefined {
  return useStore((s) => (s.snap && s.github ? prForRef(ref, s.snap.refs, s.snap.remotes, s.github) : undefined))
}

function PrRow({ pr }: { pr: PullRequest }) {
  const { key, label } = prStateLabel(pr)
  return (
    <button className="pr-row" onClick={() => openPr(pr.number)} title="Open pull request">
      <span className={cls('pr-state', `pr-${key}`)}>
        <Icon name="pr" size={11} />
        {label}
      </span>
      <span className="pr-body">
        <span className="pr-title">
          <span className="pr-number">#{pr.number}</span> {pr.title}
        </span>
        <span className="pr-meta">
          {pr.author && <>{pr.author} · </>}
          {pr.baseRef} ← {pr.headRef}
        </span>
      </span>
      <span
        className="pr-ext"
        title="Open on GitHub"
        onClick={(e) => {
          e.stopPropagation()
          openUrl(pr.url)
        }}
      >
        <Icon name="external" size={12} />
      </span>
    </button>
  )
}

/** "Pull requests" block in the commit panel. */
export function PullRequestSection({ sha }: { sha: string }) {
  const github = useStore((s) => s.github)
  const entry = useStore((s) => s.commitPrs[sha])
  const snap = useStore((s) => s.snap)
  const hasInfo = !!github?.info

  useEffect(() => {
    if (hasInfo) void loadCommitPrs(sha)
  }, [sha, hasInfo])

  if (!github?.info || !snap) return null
  const info = github.info

  // Branches pointing at this commit: their open PRs count too, and pushed ones without a PR get a "create" link.
  const branches = snap.refs.filter((r) => r.sha === sha && r.type !== 'tag')
  const branchPrs = branches.map((r) => prForRef(r, snap.refs, snap.remotes, github)).filter((p): p is PullRequest => !!p)
  const prs = mergePullRequests(entry?.prs ?? [], branchPrs)

  const createFor = new Map<string, Ref>()
  for (const ref of branches) {
    const target = remoteBranchOf(ref, snap.refs, snap.remotes, info)
    const name = target?.branch ?? ref.short
    if (prs.some((p) => p.headRef === name) || !canCreatePr(ref) || createFor.has(name)) continue
    createFor.set(name, ref)
  }

  const loading = !entry || entry.loading
  return (
    <div className="pr-section">
      <div className="section-head">
        <span className="pr-heading">
          <Icon name="pr" size={12} /> Pull requests
        </span>
        <button className="icon-btn" title="Refresh from GitHub" onClick={() => refreshPullRequests(sha)}>
          {loading ? <span className="spinner" /> : <Icon name="refresh" size={12} />}
        </button>
      </div>
      {prs.map((pr) => (
        <PrRow key={pr.number} pr={pr} />
      ))}
      {prs.length === 0 && loading && <div className="pr-empty">Checking {info.host}…</div>}
      {prs.length === 0 && !loading && !entry?.error && (
        <div className="pr-empty">{entry?.notice ?? 'No pull request contains this commit.'}</div>
      )}
      {entry?.error && <div className="pr-error">{entry.error}</div>}
      {!entry?.error && github.error && <div className="pr-error">{github.error}</div>}
      {[...createFor].map(([branch, ref]) => (
        <button key={branch} className="btn btn-sm pr-create" onClick={() => createPullRequestDialog(ref)}>
          <Icon name="plus" size={11} /> Create pull request for {branch}
        </button>
      ))}
    </div>
  )
}
