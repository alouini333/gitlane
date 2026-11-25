import type { CheckState, PullRequestState, ReviewDecision, ReviewState } from '../../../shared/types'
import { cls } from '../util'
import { Icon } from './Icon'

export function prStateKey(state: PullRequestState, draft: boolean) {
  return state === 'open' ? (draft ? 'draft' : 'open') : state
}

/** Colored pull-request glyph for open / draft / merged / closed. */
export function PrStateIcon({ state, draft, size = 14 }: { state: PullRequestState; draft: boolean; size?: number }) {
  const key = prStateKey(state, draft)
  return (
    <span className={cls('pr-glyph', `pr-${key}`)} title={key[0].toUpperCase() + key.slice(1)}>
      <Icon name={state === 'merged' ? 'merge' : 'pr'} size={size} />
    </span>
  )
}

/** Pill like GitHub's "Open" / "Draft" / "Merged" / "Closed". */
export function PrStateBadge({ state, draft }: { state: PullRequestState; draft: boolean }) {
  const key = prStateKey(state, draft)
  return (
    <span className={cls('pr-state', `pr-${key}`)}>
      <Icon name={state === 'merged' ? 'merge' : 'pr'} size={12} />
      {key[0].toUpperCase() + key.slice(1)}
    </span>
  )
}

const CHECK_TITLE: Record<CheckState, string> = {
  success: 'Checks passed',
  failure: 'Checks failed',
  pending: 'Checks running',
  neutral: 'Neutral',
  skipped: 'Skipped'
}

export function CheckIcon({ state, size = 12 }: { state: CheckState | null; size?: number }) {
  if (!state) return null
  const icon = state === 'success' ? 'check' : state === 'failure' ? 'close' : state === 'pending' ? 'dot' : 'minus'
  return (
    <span className={cls('check-icon', `ck-${state}`)} title={CHECK_TITLE[state]}>
      <Icon name={icon} size={size} />
    </span>
  )
}

export function ReviewDecisionBadge({ decision }: { decision: ReviewDecision }) {
  if (!decision) return null
  const [label, key] =
    decision === 'APPROVED' ? ['Approved', 'approved'] : decision === 'CHANGES_REQUESTED' ? ['Changes requested', 'changes'] : ['Review required', 'required']
  return <span className={cls('review-badge', `rv-${key}`)}>{label}</span>
}

export function ReviewStateIcon({ state }: { state: ReviewState | null }) {
  if (state === 'APPROVED')
    return (
      <span className="check-icon ck-success" title="Approved">
        <Icon name="check" size={13} />
      </span>
    )
  if (state === 'CHANGES_REQUESTED')
    return (
      <span className="check-icon ck-failure" title="Requested changes">
        <Icon name="diffIcon" size={13} />
      </span>
    )
  if (state === 'COMMENTED')
    return (
      <span className="check-icon ck-neutral" title="Commented">
        <Icon name="comment" size={13} />
      </span>
    )
  return (
    <span className="check-icon ck-pending" title="Awaiting review">
      <Icon name="dot" size={13} />
    </span>
  )
}
