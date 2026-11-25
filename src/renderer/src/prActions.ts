// Pull request actions with their dialogs: create, review, merge, checkout, edit, pickers.
import type { MergeMethod, PrDetail, PrRef, Ref, ReviewEvent, SwitchResult } from '../../shared/types'
import { dirtyPolicy, pushBranch, reportSwitch } from './actions'
import { isDefaultBranch, remoteBranchOf } from './github'
import {
  ask,
  confirm,
  loadGitHub,
  loadPrList,
  openPicker,
  openPr,
  prRun,
  run,
  toast,
  useStore,
  type PickerOption
} from './store'
import { errorMessage, plural } from './util'
import { repoApi } from './api'

const state = () => useStore.getState()
export const prRef = (pr: { id: string; number: number }): PrRef => ({ id: pr.id, number: pr.number })

/** owner:branch label like GitHub shows for the head of a PR. */
export function headLabel(pr: { headRef: string; headRepo: string | null }, baseRepo?: string): string {
  if (!pr.headRepo) return pr.headRef
  const owner = pr.headRepo.split('/')[0]
  return baseRepo && pr.headRepo.toLowerCase() === baseRepo.toLowerCase() ? pr.headRef : `${owner}:${pr.headRef}`
}

// ------------------------------------------------------------------ create

/** Can a pull request be opened from this branch (GitHub remote available, not the default branch)? */
export function canCreatePr(ref: Ref): boolean {
  const { snap, github } = state()
  if (!snap || !github?.info || (ref.type !== 'head' && ref.type !== 'remote')) return false
  const target = remoteBranchOf(ref, snap.refs, snap.remotes, github.info)
  if (target) return !!github.info.remotes[target.remote] && !isDefaultBranch(target, github.info)
  return ref.type === 'head' && ref.short !== github.info.defaultBranch // not pushed yet: we push first
}

export async function createPullRequestDialog(ref?: Ref) {
  const { snap, github } = state()
  const info = github?.info
  if (!snap || !info) {
    toast('error', 'This repository has no GitHub remote.')
    return
  }
  if (!info.authenticated) {
    toast('error', 'Sign in with the GitHub CLI ("gh auth login") to create pull requests.')
    return
  }
  const branchRef = ref ?? snap.refs.find((r) => r.type === 'head' && r.current)
  if (!branchRef) {
    toast('error', 'Check out a branch first (HEAD is detached).')
    return
  }

  let target = remoteBranchOf(branchRef, snap.refs, snap.remotes, info)
  if (target ? isDefaultBranch(target, info) : branchRef.short === info.defaultBranch) {
    toast('info', `${branchRef.short} is the default branch. Switch to a feature branch to open a pull request.`)
    return
  }
  if (!target && branchRef.type === 'head') {
    const ok = await confirm({
      title: `Push ${branchRef.short} first?`,
      message: 'This branch is not on GitHub yet. It will be pushed, then you can open the pull request.',
      confirmLabel: 'Push branch'
    })
    if (!ok) return
    await pushBranch(branchRef.short)
    const fresh = state().snap!
    const pushed = fresh.refs.find((r) => r.name === branchRef.name)
    target = pushed ? remoteBranchOf(pushed, fresh.refs, fresh.remotes, info) : null
    if (!target) return
  }
  if (!target) return
  const headRepo = info.remotes[target.remote]
  if (!headRepo) {
    toast('error', `${target.remote} is not a GitHub remote.`)
    return
  }
  const existing = state().github?.openPrs.find((p) => p.headRef === target!.branch && p.headRepo?.toLowerCase() === headRepo.toLowerCase())
  if (existing) {
    toast('info', `#${existing.number} is already open for ${target.branch}.`)
    openPr(existing.number)
    return
  }

  // Base candidates: branches of the repository PRs are opened against.
  const baseRemotes = Object.keys(info.remotes).filter((r) => info.remotes[r].toLowerCase() === info.repo.toLowerCase())
  const bases = new Set<string>()
  if (info.defaultBranch) bases.add(info.defaultBranch)
  for (const r of snap.refs) {
    if (r.type !== 'remote' || !r.remote || !baseRemotes.includes(r.remote)) continue
    const name = r.short.slice(r.remote.length + 1)
    if (name !== target.branch && name !== 'HEAD') bases.add(name)
  }
  if (bases.size === 0) bases.add('main')

  const tip = snap.commits.find((c) => c.sha === branchRef.sha)
  const res = await ask({
    title: 'Create pull request',
    message: `${headLabel({ headRef: target.branch, headRepo }, info.repo)} → ${info.repo}`,
    fields: [
      { key: 'title', label: 'Title', initial: tip?.subject ?? target.branch.replace(/[-_/]+/g, ' ') },
      { key: 'base', label: 'Base branch', options: [...bases] },
      { key: 'body', label: 'Description (Markdown)', multiline: true, placeholder: 'What does this change and why?' }
    ],
    checkbox: { label: 'Create as draft', initial: false },
    confirmLabel: 'Create pull request'
  })
  if (!res || !res.values.title.trim()) return

  const head = headRepo.toLowerCase() === info.repo.toLowerCase() ? target.branch : `${headRepo.split('/')[0]}:${target.branch}`
  const path = state().repoPath!
  useStore.setState({ busy: 'Creating pull request' })
  try {
    const created = await repoApi(path).createPullRequest({
      head,
      base: res.values.base,
      title: res.values.title.trim(),
      body: res.values.body,
      draft: res.checked
    })
    toast('success', `Created pull request #${created.number}`)
    openPr(created.number)
    void loadGitHub(true)
    void loadPrList(true)
  } catch (e) {
    toast('error', errorMessage(e))
  } finally {
    useStore.setState({ busy: null })
  }
}

// ------------------------------------------------------------------ open PR actions

export async function checkoutPr(pr: { number: number; headRef: string; headRepo: string | null }) {
  const policy = await dirtyPolicy(`#${pr.number}`)
  if (!policy) return
  const out: { result?: SwitchResult } = {}
  const ok = await run(`Checking out #${pr.number}`, async (api) => {
    out.result = await api.checkoutPullRequest(pr.number, pr.headRef, pr.headRepo, policy)
  })
  if (ok && out.result) {
    toast('success', `Checked out ${out.result.branch}`)
    reportSwitch(out.result, out.result.branch ?? `#${pr.number}`)
  }
}

export async function editTitle(pr: PrDetail) {
  const res = await ask({ title: 'Edit title', fields: [{ key: 'title', label: 'Title', initial: pr.title }], confirmLabel: 'Save' })
  const title = res?.values.title.trim()
  if (title && title !== pr.title) await prRun('Updating title', (api) => api.prUpdate(prRef(pr), { title }), { badges: true })
}

const REVIEW_CHOICES: { label: string; event: ReviewEvent }[] = [
  { label: 'Comment — general feedback', event: 'COMMENT' },
  { label: 'Approve — approve merging these changes', event: 'APPROVE' },
  { label: 'Request changes — must be addressed before merging', event: 'REQUEST_CHANGES' }
]

export async function reviewDialog(pr: PrDetail) {
  const pending = pr.pendingReview
  const choices = pr.viewer.isAuthor ? REVIEW_CHOICES.slice(0, 1) : REVIEW_CHOICES
  const res = await ask({
    title: 'Finish your review',
    message: [
      pending ? `Includes ${plural(pending.comments, 'pending comment')}.` : '',
      pr.viewer.isAuthor ? 'You can only comment on your own pull request.' : ''
    ]
      .filter(Boolean)
      .join(' '),
    fields: [
      { key: 'event', label: 'Review type', options: choices.map((c) => c.label) },
      { key: 'body', label: 'Summary (Markdown)', multiline: true, placeholder: 'Leave a comment' }
    ],
    confirmLabel: 'Submit review'
  })
  if (!res) return
  const event = choices.find((c) => c.label === res.values.event)?.event ?? 'COMMENT'
  const body = res.values.body.trim()
  if (event !== 'APPROVE' && !body && !pending?.comments) {
    toast('error', event === 'COMMENT' ? 'Write a comment or add line comments before submitting.' : 'Explain what needs to change.')
    return
  }
  const done = { APPROVE: 'Approved', REQUEST_CHANGES: 'Requested changes', COMMENT: 'Review submitted' }[event]
  await prRun('Submitting review', (api) => api.prSubmitReview(prRef(pr), event, body, pending?.id), { success: done, files: true })
}

export async function discardPendingReview(pr: PrDetail) {
  if (!pr.pendingReview) return
  const ok = await confirm({
    title: 'Discard pending review?',
    message: `${plural(pr.pendingReview.comments, 'pending comment')} will be deleted.`,
    confirmLabel: 'Discard review',
    danger: true
  })
  if (ok) await prRun('Discarding review', (api) => api.prDiscardReview(pr.pendingReview!.id), { files: true })
}

const METHOD_LABEL: Record<MergeMethod, string> = { MERGE: 'Create a merge commit', SQUASH: 'Squash and merge', REBASE: 'Rebase and merge' }
export const mergeMethodLabel = (m: MergeMethod) => METHOD_LABEL[m]

export function preferredMergeMethod(pr: PrDetail): MergeMethod | null {
  try {
    const saved = localStorage.getItem('gitlane.mergeMethod') as MergeMethod | null
    if (saved && pr.mergeMethods.includes(saved)) return saved
  } catch {
    /* storage unavailable */
  }
  return pr.mergeMethods[0] ?? null
}

export async function mergeDialog(pr: PrDetail, method: MergeMethod) {
  try {
    localStorage.setItem('gitlane.mergeMethod', method)
  } catch {
    /* storage unavailable */
  }
  const info = state().github?.info
  const sameRepo = !!pr.headRepo && !!info && pr.headRepo.toLowerCase() === info.repo.toLowerCase()
  const head = headLabel(pr, info?.repo)
  const headline =
    method === 'MERGE' ? `Merge pull request #${pr.number} from ${pr.headRepo?.split('/')[0] ?? ''}/${pr.headRef}` : `${pr.title} (#${pr.number})`
  const body = method === 'MERGE' ? pr.title : pr.commits.map((c) => `* ${c.headline}`).join('\n')

  const res = await ask({
    title: `${METHOD_LABEL[method]} #${pr.number}?`,
    message: `${head} → ${pr.baseRef}`,
    fields:
      method === 'REBASE'
        ? []
        : [
            { key: 'headline', label: 'Commit message', initial: headline },
            { key: 'body', label: 'Extended description', multiline: true, initial: body }
          ],
    checkbox: sameRepo && pr.viewer.canMerge && !pr.deleteBranchOnMerge ? { label: `Delete ${pr.headRef} after merging`, initial: true } : undefined,
    confirmLabel: `Confirm ${METHOD_LABEL[method].toLowerCase()}`
  })
  if (!res) return
  await prRun(
    'Merging',
    (api) =>
      api.prMerge(prRef(pr), method, {
        headline: res.values.headline,
        body: res.values.body,
        expectedHeadOid: pr.headOid,
        deleteBranch: res.checked && pr.headRepo ? { repo: pr.headRepo, branch: pr.headRef } : undefined
      }),
    { success: `Merged #${pr.number}`, badges: true }
  )
}

export async function setPrState(pr: PrDetail, next: 'open' | 'closed', comment = '') {
  if (next === 'closed') {
    const ok = await confirm({ title: `Close #${pr.number} without merging?`, confirmLabel: 'Close pull request', danger: true })
    if (!ok) return false
  }
  return prRun(
    next === 'closed' ? 'Closing' : 'Reopening',
    async (api) => {
      if (comment.trim()) await api.prAddComment(prRef(pr), comment)
      await api.prSetState(prRef(pr), next)
    },
    { badges: true }
  )
}

export function toggleDraft(pr: PrDetail) {
  return prRun(pr.draft ? 'Marking ready for review' : 'Converting to draft', (api) => api.prSetDraft(prRef(pr), !pr.draft), { badges: true })
}

// ------------------------------------------------------------------ pickers

function anchor(e: { currentTarget: EventTarget }) {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  return { x: Math.max(8, rect.right - 280), y: rect.bottom + 4 }
}

const userOption = (u: { login: string; avatarUrl: string; name?: string }): PickerOption => ({
  key: u.login,
  label: u.login,
  detail: u.name,
  avatarUrl: u.avatarUrl
})

async function usersFor(query: string, exclude?: string): Promise<PickerOption[]> {
  const users = await repoApi(state().repoPath!).assignableUsers(query)
  return users.filter((u) => u.login !== exclude).map(userOption)
}

export function pickReviewers(e: { currentTarget: EventTarget }, pr: PrDetail) {
  openPicker({
    title: 'Request reviews from',
    ...anchor(e),
    selected: pr.reviewers.filter((r) => r.requested && !r.isTeam).map((r) => r.login),
    load: (q) => usersFor(q, pr.author?.login),
    onApply: (add, remove) => void prRun('Updating reviewers', (api) => api.prSetReviewers(prRef(pr), add, remove))
  })
}

export function pickAssignees(e: { currentTarget: EventTarget }, pr: PrDetail) {
  openPicker({
    title: 'Assign up to 10 people',
    ...anchor(e),
    selected: pr.assignees.map((a) => a.login),
    load: (q) => usersFor(q),
    onApply: (add, remove) => void prRun('Updating assignees', (api) => api.prSetAssignees(prRef(pr), add, remove))
  })
}

export function pickLabels(e: { currentTarget: EventTarget }, pr: PrDetail) {
  let all: PickerOption[] | null = null
  openPicker({
    title: 'Apply labels',
    ...anchor(e),
    selected: pr.labels.map((l) => l.name),
    load: async (q) => {
      all ??= (await repoApi(state().repoPath!).repoLabels()).map((l) => ({ key: l.name, label: l.name, detail: l.description, color: `#${l.color}` }))
      const query = q.toLowerCase()
      return all.filter((o) => o.label.toLowerCase().includes(query))
    },
    onApply: (add, remove) => void prRun('Updating labels', (api) => api.prSetLabels(prRef(pr), add, remove))
  })
}

export async function assignSelf(pr: PrDetail) {
  await prRun('Assigning', (api) => api.prSetAssignees(prRef(pr), [pr.viewer.login], []))
}
