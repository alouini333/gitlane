import type { ReactNode } from 'react'
import { copy, openUrl } from '../actions'
import { assignSelf, checkoutPr, headLabel, pickAssignees, pickLabels, pickReviewers, setPrState, toggleDraft } from '../prActions'
import { useStore } from '../store'
import { Icon } from './Icon'
import { GhAvatar } from './Markdown'
import { ReviewStateIcon } from './PrBits'

function Section({ title, onEdit, children }: { title: string; onEdit?: (e: React.MouseEvent) => void; children: ReactNode }) {
  return (
    <div className="prs-section">
      <div className="prs-head">
        <span>{title}</span>
        {onEdit && (
          <button className="icon-btn" title={`Edit ${title.toLowerCase()}`} onClick={onEdit}>
            <Icon name="gear" size={13} />
          </button>
        )}
      </div>
      {children}
    </div>
  )
}

/** GitHub-style metadata column shown in the right panel while a PR is open. */
export function PrSidebar() {
  const number = useStore((s) => s.prView?.number)
  const pr = useStore((s) => (number !== undefined ? s.prDetails[number]?.data : null))
  const repo = useStore((s) => s.github?.info?.repo)
  if (!pr) return <div className="panel panel-loading">Loading…</div>
  const canEdit = pr.viewer.canUpdate || pr.viewer.canMerge

  return (
    <div className="panel pr-sidebar">
      <Section title="Reviewers" onEdit={canEdit ? (e) => pickReviewers(e, pr) : undefined}>
        {pr.reviewers.length === 0 && <div className="prs-empty">No reviews yet</div>}
        {pr.reviewers.map((r) => (
          <div key={r.login} className="prs-row" title={r.requested ? 'Awaiting review' : (r.state ?? '')}>
            {r.isTeam ? <Icon name="repo" size={16} /> : <GhAvatar user={{ login: r.login, avatarUrl: r.avatarUrl }} size={18} />}
            <span className="prs-name">{r.login}</span>
            <ReviewStateIcon state={r.requested ? null : r.state} />
          </div>
        ))}
      </Section>

      <Section title="Assignees" onEdit={canEdit ? (e) => pickAssignees(e, pr) : undefined}>
        {pr.assignees.length === 0 && (
          <div className="prs-empty">
            No one —{' '}
            {canEdit ? (
              <button className="link-btn small" onClick={() => assignSelf(pr)}>
                assign yourself
              </button>
            ) : (
              'unassigned'
            )}
          </div>
        )}
        {pr.assignees.map((a) => (
          <div key={a.login} className="prs-row">
            <GhAvatar user={a} size={18} />
            <span className="prs-name">{a.login}</span>
          </div>
        ))}
      </Section>

      <Section title="Labels" onEdit={canEdit ? (e) => pickLabels(e, pr) : undefined}>
        {pr.labels.length === 0 && <div className="prs-empty">None yet</div>}
        <div className="prs-labels">
          {pr.labels.map((l) => (
            <span key={l.name} className="gh-label" style={{ ['--label' as string]: `#${l.color}` }} title={l.description}>
              {l.name}
            </span>
          ))}
        </div>
      </Section>

      <Section title="Branch">
        <div className="prs-branch">
          <code>{pr.baseRef}</code> ← <code>{headLabel(pr, repo)}</code>
        </div>
        <div className="prs-buttons">
          <button className="btn btn-sm" onClick={() => checkoutPr(pr)}>
            <Icon name="branch" size={12} /> Check out locally
          </button>
          <button className="btn btn-sm" onClick={() => copy(pr.headRef, 'Branch name copied')}>
            Copy branch name
          </button>
        </div>
      </Section>

      {pr.state === 'open' && pr.viewer.canUpdate && (
        <Section title="Status">
          <div className="prs-buttons">
            <button className="btn btn-sm" onClick={() => toggleDraft(pr)}>
              {pr.draft ? 'Ready for review' : 'Convert to draft'}
            </button>
            <button className="btn btn-sm btn-danger" onClick={() => setPrState(pr, 'closed')}>
              Close pull request
            </button>
          </div>
        </Section>
      )}

      <Section title="Links">
        <div className="prs-buttons">
          <button className="btn btn-sm" onClick={() => openUrl(pr.url)}>
            <Icon name="external" size={12} /> Open on GitHub
          </button>
          <button className="btn btn-sm" onClick={() => copy(pr.url, 'Link copied')}>
            Copy link
          </button>
        </div>
      </Section>
    </div>
  )
}
