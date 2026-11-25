// Full pull-request workflow over the GitHub API: lists, details, reviews, comments, merging.
import type {
  CheckState,
  GhLabel,
  GhUser,
  GitHubInfo,
  MergeMethod,
  NewPullRequest,
  NewReviewComment,
  PrCheck,
  PrComment,
  PrDetail,
  PrFile,
  PrFilter,
  PrListItem,
  PrListResult,
  PrListState,
  PrRef,
  PrReviewThread,
  PrReviewer,
  PrTimelineItem,
  ReviewDecision,
  ReviewEvent,
  ReviewState
} from '../shared/types'
import { parseDiff } from './git/parsers'
import { GitHubError, clearGitHubCache, getGitHubInfo, graphql, repoPath, request } from './github'

async function requireInfo(path: string): Promise<GitHubInfo> {
  const info = await getGitHubInfo(path)
  if (!info) throw new Error('This repository has no GitHub remote.')
  return info
}

// ------------------------------------------------------------------ raw GraphQL shapes

interface RawActor {
  login: string
  avatarUrl?: string
}

interface RawCheckContext {
  __typename: 'CheckRun' | 'StatusContext'
  name?: string
  status?: string
  conclusion?: string | null
  detailsUrl?: string | null
  title?: string | null
  checkSuite?: { workflowRun?: { workflow?: { name?: string } | null } | null } | null
  context?: string
  state?: string
  targetUrl?: string | null
  description?: string | null
}

interface RawRollup {
  state: string
  contexts?: { nodes: RawCheckContext[] }
}

interface RawComment {
  id: string
  databaseId: number
  author: RawActor | null
  body: string
  bodyHTML: string
  createdAt: string
  viewerCanUpdate: boolean
  viewerCanDelete: boolean
  state?: string
  diffHunk?: string
  pullRequestReview?: { id: string } | null
}

interface RawTimelineNode {
  __typename: string
  id?: string
  actor?: RawActor | null
  author?: RawActor | null
  createdAt?: string
  submittedAt?: string | null
  state?: string
  body?: string
  bodyHTML?: string
  databaseId?: number
  viewerCanUpdate?: boolean
  viewerCanDelete?: boolean
  commit?: { oid?: string; abbreviatedOid: string; messageHeadline?: string; committedDate?: string; author?: { name?: string; user?: RawActor | null } | null } | null
  requestedReviewer?: { login?: string; name?: string } | null
  label?: { name: string } | null
  assignee?: { login?: string } | null
  previousTitle?: string
  currentTitle?: string
  headRefName?: string
}

// ------------------------------------------------------------------ mapping helpers

const user = (a: RawActor | null | undefined): GhUser | null => (a ? { login: a.login, avatarUrl: a.avatarUrl ?? '' } : null)

export function rollupState(state: string | undefined | null): CheckState | null {
  switch (state) {
    case 'SUCCESS':
      return 'success'
    case 'FAILURE':
    case 'ERROR':
      return 'failure'
    case 'PENDING':
    case 'EXPECTED':
      return 'pending'
    default:
      return null
  }
}

export function mapCheck(n: RawCheckContext): PrCheck {
  if (n.__typename === 'CheckRun') {
    let state: CheckState = 'pending'
    if (n.status === 'COMPLETED') {
      state =
        n.conclusion === 'SUCCESS'
          ? 'success'
          : n.conclusion === 'SKIPPED'
            ? 'skipped'
            : n.conclusion === 'NEUTRAL' || n.conclusion === 'CANCELLED' || n.conclusion === 'STALE'
              ? 'neutral'
              : 'failure'
    }
    const workflow = n.checkSuite?.workflowRun?.workflow?.name
    return { name: workflow ? `${workflow} / ${n.name}` : (n.name ?? 'check'), state, description: n.title ?? null, url: n.detailsUrl ?? null }
  }
  return {
    name: n.context ?? 'status',
    state: rollupState(n.state) ?? 'neutral',
    description: n.description ?? null,
    url: n.targetUrl ?? null
  }
}

function mapComment(c: RawComment, kind: 'issue' | 'review'): PrComment {
  return {
    id: c.id,
    databaseId: c.databaseId,
    kind,
    author: user(c.author),
    body: c.body,
    bodyHTML: c.bodyHTML,
    createdAt: c.createdAt,
    viewerCanUpdate: c.viewerCanUpdate,
    viewerCanDelete: c.viewerCanDelete,
    pending: c.state === 'PENDING'
  }
}

/** Timeline node → display item (null for nodes we don't show). */
export function mapTimelineNode(n: RawTimelineNode, baseRef: string, headRef: string): PrTimelineItem | null {
  const actor = user(n.actor)
  const at = n.createdAt ?? ''
  const event = (kind: string, text: string): PrTimelineItem => ({ type: 'event', kind, actor, text, createdAt: at })
  switch (n.__typename) {
    case 'IssueComment':
      return { type: 'comment', comment: mapComment(n as unknown as RawComment, 'issue') }
    case 'PullRequestReview':
      if (n.state === 'PENDING') return null
      return {
        type: 'review',
        id: n.id ?? '',
        author: user(n.author),
        state: (n.state ?? 'COMMENTED') as ReviewState,
        body: n.body ?? '',
        bodyHTML: n.bodyHTML ?? '',
        createdAt: n.submittedAt ?? at
      }
    case 'PullRequestCommit': {
      const c = n.commit
      if (!c) return null
      return {
        type: 'commit',
        oid: c.oid ?? '',
        abbreviatedOid: c.abbreviatedOid,
        headline: c.messageHeadline ?? '',
        author: c.author?.user?.login ?? c.author?.name ?? '',
        createdAt: c.committedDate ?? at
      }
    }
    case 'MergedEvent':
      return event('merged', `merged commit ${n.commit?.abbreviatedOid ?? ''} into ${baseRef}`)
    case 'ClosedEvent':
      return event('closed', 'closed this pull request')
    case 'ReopenedEvent':
      return event('reopened', 'reopened this pull request')
    case 'HeadRefForcePushedEvent':
      return event('force-pushed', `force-pushed the ${headRef} branch`)
    case 'HeadRefDeletedEvent':
      return event('branch-deleted', `deleted the ${n.headRefName ?? headRef} branch`)
    case 'ReviewRequestedEvent':
      return event('review-requested', `requested a review from ${n.requestedReviewer?.login ?? n.requestedReviewer?.name ?? 'someone'}`)
    case 'ReviewDismissedEvent':
      return event('review-dismissed', 'dismissed a review')
    case 'ReadyForReviewEvent':
      return event('ready', 'marked this pull request as ready for review')
    case 'ConvertToDraftEvent':
      return event('draft', 'marked this pull request as draft')
    case 'LabeledEvent':
      return event('labeled', `added the ${n.label?.name ?? ''} label`)
    case 'UnlabeledEvent':
      return event('unlabeled', `removed the ${n.label?.name ?? ''} label`)
    case 'AssignedEvent':
      return event('assigned', `assigned ${n.assignee?.login ?? 'someone'}`)
    case 'UnassignedEvent':
      return event('unassigned', `unassigned ${n.assignee?.login ?? 'someone'}`)
    case 'RenamedTitleEvent':
      return event('renamed', `changed the title from “${n.previousTitle ?? ''}” to “${n.currentTitle ?? ''}”`)
    default:
      return null
  }
}

// ------------------------------------------------------------------ list

const PR_LIST_FIELDS = `
  number title state isDraft url updatedAt
  author { login avatarUrl }
  headRefName baseRefName headRepository { nameWithOwner }
  reviewDecision
  comments { totalCount }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
`

const FILTERS: Record<PrFilter, string> = {
  'review-requested': 'review-requested:@me',
  assigned: 'assignee:@me',
  created: 'author:@me',
  involves: 'involves:@me',
  all: ''
}

interface RawListNode {
  number?: number
  title: string
  state: string
  isDraft: boolean
  url: string
  updatedAt: string
  author: RawActor | null
  headRefName: string
  baseRefName: string
  headRepository: { nameWithOwner: string } | null
  reviewDecision: ReviewDecision
  comments: { totalCount: number }
  commits: { nodes: { commit: { statusCheckRollup: RawRollup | null } }[] }
}

export function searchQuery(repo: string, filter: PrFilter, state: PrListState): string {
  return [`repo:${repo}`, 'is:pr', `is:${state}`, 'archived:false', FILTERS[filter], 'sort:updated-desc'].filter(Boolean).join(' ')
}

export async function listPullRequests(path: string, filter: PrFilter, state: PrListState): Promise<PrListResult> {
  const info = await requireInfo(path)
  const q = (f: PrFilter) => searchQuery(info.repo, f, state)
  type Count = { issueCount: number }
  // Two requests in parallel: the counts are cheap, the item list is what GitHub search is slow at.
  const [counts, list] = await Promise.all([
    graphql<{ viewer: { login: string }; rr: Count; as: Count; cr: Count; inv: Count; all: Count }>(
      info.host,
      `query($rr: String!, $as: String!, $cr: String!, $inv: String!, $all: String!) {
        viewer { login }
        rr: search(query: $rr, type: ISSUE, first: 1) { issueCount }
        as: search(query: $as, type: ISSUE, first: 1) { issueCount }
        cr: search(query: $cr, type: ISSUE, first: 1) { issueCount }
        inv: search(query: $inv, type: ISSUE, first: 1) { issueCount }
        all: search(query: $all, type: ISSUE, first: 1) { issueCount }
      }`,
      { rr: q('review-requested'), as: q('assigned'), cr: q('created'), inv: q('involves'), all: q('all') }
    ),
    graphql<{ results: { nodes: RawListNode[] } }>(
      info.host,
      `query($q: String!) { results: search(query: $q, type: ISSUE, first: 30) { nodes { ... on PullRequest { ${PR_LIST_FIELDS} } } } }`,
      { q: q(filter) }
    )
  ])
  const data = { ...counts, ...list }

  const items: PrListItem[] = data.results.nodes
    .filter((n) => typeof n.number === 'number')
    .map((n) => ({
      number: n.number!,
      title: n.title,
      state: n.state === 'MERGED' ? 'merged' : n.state === 'OPEN' ? 'open' : 'closed',
      draft: n.isDraft,
      url: n.url,
      author: user(n.author),
      headRef: n.headRefName,
      headRepo: n.headRepository?.nameWithOwner ?? null,
      baseRef: n.baseRefName,
      updatedAt: n.updatedAt,
      reviewDecision: n.reviewDecision,
      checkState: rollupState(n.commits.nodes[0]?.commit.statusCheckRollup?.state),
      comments: n.comments.totalCount
    }))
  return {
    viewer: data.viewer.login,
    items,
    counts: {
      'review-requested': data.rr.issueCount,
      assigned: data.as.issueCount,
      created: data.cr.issueCount,
      involves: data.inv.issueCount,
      all: data.all.issueCount
    }
  }
}

// ------------------------------------------------------------------ detail

const ACTOR = 'login avatarUrl'
const DETAIL_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  viewer { login avatarUrl }
  repository(owner: $owner, name: $name) {
    viewerPermission mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed deleteBranchOnMerge
    pullRequest(number: $number) {
      id number title body bodyHTML url state isDraft createdAt mergedAt
      mergedBy { ${ACTOR} }
      author { ${ACTOR} }
      headRefName headRefOid baseRefName headRepository { nameWithOwner }
      mergeable mergeStateStatus reviewDecision viewerCanUpdate viewerDidAuthor
      additions deletions changedFiles
      labels(first: 30) { nodes { name color description } }
      assignees(first: 20) { nodes { ${ACTOR} } }
      reviewRequests(first: 30) { nodes { requestedReviewer { __typename ... on User { ${ACTOR} } ... on Bot { ${ACTOR} } ... on Mannequin { ${ACTOR} } ... on Team { name slug } } } }
      latestReviews(first: 30) { nodes { author { ${ACTOR} } state } }
      reviews(first: 1, states: [PENDING]) { nodes { id comments { totalCount } } }
      commits(first: 100) { nodes { commit {
        oid abbreviatedOid messageHeadline committedDate
        author { name user { ${ACTOR} } }
        statusCheckRollup { state }
      } } }
      checks: commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { name status conclusion detailsUrl title checkSuite { workflowRun { workflow { name } } } }
        ... on StatusContext { context state targetUrl description }
      } } } } } }
      timelineItems(first: 100, itemTypes: [ISSUE_COMMENT, PULL_REQUEST_REVIEW, PULL_REQUEST_COMMIT, MERGED_EVENT, CLOSED_EVENT,
        REOPENED_EVENT, HEAD_REF_FORCE_PUSHED_EVENT, HEAD_REF_DELETED_EVENT, REVIEW_REQUESTED_EVENT, REVIEW_DISMISSED_EVENT,
        READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT, LABELED_EVENT, UNLABELED_EVENT, ASSIGNED_EVENT, UNASSIGNED_EVENT,
        RENAMED_TITLE_EVENT]) {
        totalCount
        nodes {
          __typename
          ... on IssueComment { id databaseId author { ${ACTOR} } body bodyHTML createdAt viewerCanUpdate viewerCanDelete }
          ... on PullRequestReview { id author { ${ACTOR} } state body bodyHTML createdAt submittedAt }
          ... on PullRequestCommit { commit { oid abbreviatedOid messageHeadline committedDate author { name user { ${ACTOR} } } } }
          ... on MergedEvent { actor { ${ACTOR} } createdAt commit { abbreviatedOid } }
          ... on ClosedEvent { actor { ${ACTOR} } createdAt }
          ... on ReopenedEvent { actor { ${ACTOR} } createdAt }
          ... on HeadRefForcePushedEvent { actor { ${ACTOR} } createdAt }
          ... on HeadRefDeletedEvent { actor { ${ACTOR} } createdAt headRefName }
          ... on ReviewRequestedEvent { actor { ${ACTOR} } createdAt requestedReviewer { ... on User { login } ... on Bot { login } ... on Mannequin { login } ... on Team { name } } }
          ... on ReviewDismissedEvent { actor { ${ACTOR} } createdAt }
          ... on ReadyForReviewEvent { actor { ${ACTOR} } createdAt }
          ... on ConvertToDraftEvent { actor { ${ACTOR} } createdAt }
          ... on LabeledEvent { actor { ${ACTOR} } createdAt label { name } }
          ... on UnlabeledEvent { actor { ${ACTOR} } createdAt label { name } }
          ... on AssignedEvent { actor { ${ACTOR} } createdAt assignee { ... on User { login } ... on Bot { login } } }
          ... on UnassignedEvent { actor { ${ACTOR} } createdAt assignee { ... on User { login } ... on Bot { login } } }
          ... on RenamedTitleEvent { actor { ${ACTOR} } createdAt previousTitle currentTitle }
        }
      }
      reviewThreads(first: 100) { nodes {
        id isResolved isOutdated path line startLine originalLine diffSide
        viewerCanResolve viewerCanUnresolve viewerCanReply
        comments(first: 100) { nodes {
          id databaseId author { ${ACTOR} } body bodyHTML createdAt viewerCanUpdate viewerCanDelete state diffHunk
          pullRequestReview { id }
        } }
      } }
    }
  }
}`

interface RawThread {
  id: string
  isResolved: boolean
  isOutdated: boolean
  path: string
  line: number | null
  startLine: number | null
  originalLine: number | null
  diffSide: 'LEFT' | 'RIGHT'
  viewerCanResolve: boolean
  viewerCanUnresolve: boolean
  viewerCanReply: boolean
  comments: { nodes: RawComment[] }
}

interface RawDetail {
  viewer: { login: string; avatarUrl?: string }
  repository: {
    viewerPermission: string | null
    mergeCommitAllowed: boolean
    squashMergeAllowed: boolean
    rebaseMergeAllowed: boolean
    deleteBranchOnMerge: boolean
    pullRequest: {
      id: string
      number: number
      title: string
      body: string
      bodyHTML: string
      url: string
      state: string
      isDraft: boolean
      createdAt: string
      mergedAt: string | null
      mergedBy: RawActor | null
      author: RawActor | null
      headRefName: string
      headRefOid: string
      baseRefName: string
      headRepository: { nameWithOwner: string } | null
      mergeable: PrDetail['mergeable']
      mergeStateStatus: string
      reviewDecision: ReviewDecision
      viewerCanUpdate: boolean
      viewerDidAuthor: boolean
      additions: number
      deletions: number
      changedFiles: number
      labels: { nodes: GhLabel[] }
      assignees: { nodes: RawActor[] }
      reviewRequests: { nodes: { requestedReviewer: { __typename: string; login?: string; avatarUrl?: string; name?: string; slug?: string } | null }[] }
      latestReviews: { nodes: { author: RawActor | null; state: ReviewState }[] }
      reviews: { nodes: { id: string; comments: { totalCount: number } }[] }
      commits: {
        nodes: {
          commit: {
            oid: string
            abbreviatedOid: string
            messageHeadline: string
            committedDate: string
            author: { name?: string; user?: RawActor | null } | null
            statusCheckRollup: RawRollup | null
          }
        }[]
      }
      checks: { nodes: { commit: { statusCheckRollup: RawRollup | null } }[] }
      timelineItems: { totalCount: number; nodes: RawTimelineNode[] }
      reviewThreads: { nodes: RawThread[] }
    } | null
  } | null
}

export function mapDetail(data: RawDetail): PrDetail {
  const repo = data.repository
  const pr = repo?.pullRequest
  if (!repo || !pr) throw new Error('Pull request not found.')

  const reviewers = new Map<string, PrReviewer>()
  for (const r of pr.latestReviews.nodes) {
    if (!r.author) continue
    reviewers.set(r.author.login, { login: r.author.login, avatarUrl: r.author.avatarUrl ?? null, isTeam: false, state: r.state, requested: false })
  }
  for (const { requestedReviewer: rr } of pr.reviewRequests.nodes) {
    if (!rr) continue
    const isTeam = rr.__typename === 'Team'
    const login = isTeam ? (rr.slug ?? rr.name ?? 'team') : (rr.login ?? '?')
    const existing = reviewers.get(login)
    reviewers.set(login, { login, avatarUrl: rr.avatarUrl ?? existing?.avatarUrl ?? null, isTeam, state: existing?.state ?? null, requested: true })
  }

  const threads: PrReviewThread[] = pr.reviewThreads.nodes.map((t) => {
    const first = t.comments.nodes[0]
    return {
      id: t.id,
      path: t.path,
      line: t.line,
      startLine: t.startLine,
      originalLine: t.originalLine,
      side: t.diffSide,
      isResolved: t.isResolved,
      isOutdated: t.isOutdated,
      viewerCanResolve: t.viewerCanResolve,
      viewerCanUnresolve: t.viewerCanUnresolve,
      viewerCanReply: t.viewerCanReply,
      reviewId: first?.pullRequestReview?.id ?? null,
      diffHunk: first?.diffHunk ?? '',
      comments: t.comments.nodes.map((c) => mapComment(c, 'review'))
    }
  })

  const permission = repo.viewerPermission ?? 'READ'
  const mergeMethods: MergeMethod[] = []
  if (repo.mergeCommitAllowed) mergeMethods.push('MERGE')
  if (repo.squashMergeAllowed) mergeMethods.push('SQUASH')
  if (repo.rebaseMergeAllowed) mergeMethods.push('REBASE')
  const rollup = pr.checks.nodes[0]?.commit.statusCheckRollup ?? null
  const pending = pr.reviews.nodes[0]

  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    bodyHTML: pr.bodyHTML,
    url: pr.url,
    state: pr.state === 'MERGED' ? 'merged' : pr.state === 'OPEN' ? 'open' : 'closed',
    draft: pr.isDraft,
    createdAt: pr.createdAt,
    mergedAt: pr.mergedAt,
    mergedBy: user(pr.mergedBy),
    author: user(pr.author),
    headRef: pr.headRefName,
    headRepo: pr.headRepository?.nameWithOwner ?? null,
    headOid: pr.headRefOid,
    baseRef: pr.baseRefName,
    mergeable: pr.mergeable,
    mergeStateStatus: pr.mergeStateStatus,
    reviewDecision: pr.reviewDecision,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    labels: pr.labels.nodes,
    assignees: pr.assignees.nodes.map((a) => user(a)!),
    reviewers: [...reviewers.values()],
    commits: pr.commits.nodes.map(({ commit: c }) => ({
      oid: c.oid,
      abbreviatedOid: c.abbreviatedOid,
      headline: c.messageHeadline,
      author: c.author?.user?.login ?? c.author?.name ?? '',
      avatarUrl: c.author?.user?.avatarUrl ?? null,
      date: c.committedDate,
      checkState: rollupState(c.statusCheckRollup?.state)
    })),
    checks: (rollup?.contexts?.nodes ?? []).map(mapCheck),
    checkState: rollupState(rollup?.state),
    timeline: pr.timelineItems.nodes
      .map((n) => mapTimelineNode(n, pr.baseRefName, pr.headRefName))
      .filter((i): i is PrTimelineItem => i !== null),
    timelineTotal: pr.timelineItems.totalCount,
    threads,
    pendingReview: pending ? { id: pending.id, comments: pending.comments.totalCount } : null,
    viewer: {
      login: data.viewer.login,
      avatarUrl: data.viewer.avatarUrl ?? '',
      canUpdate: pr.viewerCanUpdate,
      isAuthor: pr.viewerDidAuthor,
      canMerge: ['ADMIN', 'MAINTAIN', 'WRITE'].includes(permission)
    },
    mergeMethods,
    deleteBranchOnMerge: repo.deleteBranchOnMerge
  }
}

export async function pullRequestDetail(path: string, number: number): Promise<PrDetail> {
  const info = await requireInfo(path)
  const [owner, name] = info.repo.split('/')
  return mapDetail(await graphql<RawDetail>(info.host, DETAIL_QUERY, { owner, name, number }))
}

// ------------------------------------------------------------------ files

interface RawFile {
  filename: string
  previous_filename?: string
  status: PrFile['status']
  additions: number
  deletions: number
  patch?: string
}

export function mapFile(f: RawFile): PrFile {
  const from = f.previous_filename ?? f.filename
  const diff = f.patch ? parseDiff(`diff --git a/${from} b/${f.filename}\n--- a/${from}\n+++ b/${f.filename}\n${f.patch}\n`) : null
  return { path: f.filename, previousPath: f.previous_filename, status: f.status, additions: f.additions, deletions: f.deletions, diff }
}

export async function pullRequestFiles(path: string, number: number): Promise<PrFile[]> {
  const info = await requireInfo(path)
  const files: PrFile[] = []
  for (let page = 1; page <= 10; page++) {
    const batch = await request<RawFile[]>(info.host, `/repos/${repoPath(info.repo)}/pulls/${number}/files?per_page=100&page=${page}`)
    files.push(...batch.map(mapFile))
    if (batch.length < 100) break
  }
  return files
}

// ------------------------------------------------------------------ pickers & markdown

export async function assignableUsers(path: string, query: string): Promise<GhUser[]> {
  const info = await requireInfo(path)
  const [owner, name] = info.repo.split('/')
  const data = await graphql<{ repository: { assignableUsers: { nodes: (RawActor & { name: string | null })[] } } }>(
    info.host,
    `query($owner: String!, $name: String!, $q: String) {
      repository(owner: $owner, name: $name) { assignableUsers(first: 30, query: $q) { nodes { login name avatarUrl } } }
    }`,
    { owner, name, q: query || null }
  )
  return data.repository.assignableUsers.nodes.map((u) => ({ login: u.login, avatarUrl: u.avatarUrl ?? '', name: u.name ?? undefined }))
}

export async function mentionableUsers(path: string, query: string): Promise<GhUser[]> {
  const info = await requireInfo(path)
  const [owner, name] = info.repo.split('/')
  const data = await graphql<{ repository: { mentionableUsers: { nodes: (RawActor & { name: string | null })[] } } }>(
    info.host,
    `query($owner: String!, $name: String!, $q: String) {
      repository(owner: $owner, name: $name) { mentionableUsers(first: 8, query: $q) { nodes { login name avatarUrl } } }
    }`,
    { owner, name, q: query || null }
  )
  return data.repository.mentionableUsers.nodes.map((u) => ({ login: u.login, avatarUrl: u.avatarUrl ?? '', name: u.name ?? undefined }))
}

export async function repoLabels(path: string): Promise<GhLabel[]> {
  const info = await requireInfo(path)
  const [owner, name] = info.repo.split('/')
  const data = await graphql<{ repository: { labels: { nodes: GhLabel[] } } }>(
    info.host,
    `query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) { labels(first: 100, orderBy: { field: NAME, direction: ASC }) { nodes { name color description } } }
    }`,
    { owner, name }
  )
  return data.repository.labels.nodes
}

export async function renderMarkdown(path: string, text: string): Promise<string> {
  const info = await requireInfo(path)
  if (!text.trim()) return ''
  return request<string>(info.host, '/markdown', { method: 'POST', body: { text, mode: 'gfm', context: info.repo }, raw: true })
}

// ------------------------------------------------------------------ mutations

async function mutate(path: string, query: string, variables: Record<string, unknown>): Promise<void> {
  const info = await requireInfo(path)
  await graphql(info.host, query, variables)
}

const pullsPath = (info: GitHubInfo, number: number) => `/repos/${repoPath(info.repo)}/pulls/${number}`
const issuePath = (info: GitHubInfo, number: number) => `/repos/${repoPath(info.repo)}/issues/${number}`

export const addComment = (path: string, pr: PrRef, body: string) =>
  mutate(path, 'mutation($id: ID!, $body: String!) { addComment(input: { subjectId: $id, body: $body }) { clientMutationId } }', {
    id: pr.id,
    body
  })

export function editComment(path: string, kind: 'issue' | 'review', id: string, body: string) {
  return kind === 'issue'
    ? mutate(path, 'mutation($id: ID!, $body: String!) { updateIssueComment(input: { id: $id, body: $body }) { clientMutationId } }', { id, body })
    : mutate(
        path,
        'mutation($id: ID!, $body: String!) { updatePullRequestReviewComment(input: { pullRequestReviewCommentId: $id, body: $body }) { clientMutationId } }',
        { id, body }
      )
}

export function deleteComment(path: string, kind: 'issue' | 'review', id: string) {
  return kind === 'issue'
    ? mutate(path, 'mutation($id: ID!) { deleteIssueComment(input: { id: $id }) { clientMutationId } }', { id })
    : mutate(path, 'mutation($id: ID!) { deletePullRequestReviewComment(input: { id: $id }) { clientMutationId } }', { id })
}

export async function addReviewComment(path: string, pr: PrRef, c: NewReviewComment): Promise<void> {
  const info = await requireInfo(path)
  const range = c.startLine !== undefined && c.startLine < c.line ? { startLine: c.startLine, startSide: c.startSide ?? c.side } : {}
  if (c.mode === 'single' && !c.pendingReviewId) {
    await request(info.host, `${pullsPath(info, pr.number)}/comments`, {
      method: 'POST',
      body: {
        body: c.body,
        commit_id: c.commitId,
        path: c.path,
        line: c.line,
        side: c.side,
        ...('startLine' in range ? { start_line: range.startLine, start_side: range.startSide } : {})
      }
    })
    return
  }
  let reviewId = c.pendingReviewId
  if (!reviewId) {
    const created = await graphql<{ addPullRequestReview: { pullRequestReview: { id: string } } }>(
      info.host,
      'mutation($id: ID!, $oid: GitObjectID) { addPullRequestReview(input: { pullRequestId: $id, commitOID: $oid }) { pullRequestReview { id } } }',
      { id: pr.id, oid: c.commitId }
    )
    reviewId = created.addPullRequestReview.pullRequestReview.id
  }
  await graphql(
    info.host,
    `mutation($review: ID!, $path: String!, $line: Int!, $side: DiffSide!, $startLine: Int, $startSide: DiffSide, $body: String!) {
      addPullRequestReviewThread(input: { pullRequestReviewId: $review, path: $path, line: $line, side: $side,
        startLine: $startLine, startSide: $startSide, body: $body }) { thread { id } }
    }`,
    { review: reviewId, path: c.path, line: c.line, side: c.side, startLine: null, startSide: null, ...range, body: c.body }
  )
}

export async function replyToThread(path: string, pr: PrRef, threadId: string, firstCommentId: number, body: string, pendingReviewId?: string) {
  const info = await requireInfo(path)
  if (pendingReviewId) {
    // With a review in progress, replies join it (like on github.com).
    await graphql(
      info.host,
      'mutation($thread: ID!, $review: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, pullRequestReviewId: $review, body: $body }) { clientMutationId } }',
      { thread: threadId, review: pendingReviewId, body }
    )
    return
  }
  await request(info.host, `${pullsPath(info, pr.number)}/comments/${firstCommentId}/replies`, { method: 'POST', body: { body } })
}

export const resolveThread = (path: string, threadId: string, resolved: boolean) =>
  mutate(
    path,
    resolved
      ? 'mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { clientMutationId } }'
      : 'mutation($id: ID!) { unresolveReviewThread(input: { threadId: $id }) { clientMutationId } }',
    { id: threadId }
  )

export function submitReview(path: string, pr: PrRef, event: ReviewEvent, body: string, pendingReviewId?: string) {
  return pendingReviewId
    ? mutate(
        path,
        'mutation($review: ID!, $event: PullRequestReviewEvent!, $body: String) { submitPullRequestReview(input: { pullRequestReviewId: $review, event: $event, body: $body }) { clientMutationId } }',
        { review: pendingReviewId, event, body: body || null }
      )
    : mutate(
        path,
        'mutation($id: ID!, $event: PullRequestReviewEvent!, $body: String) { addPullRequestReview(input: { pullRequestId: $id, event: $event, body: $body }) { clientMutationId } }',
        { id: pr.id, event, body: body || null }
      )
}

export const discardReview = (path: string, reviewId: string) =>
  mutate(path, 'mutation($id: ID!) { deletePullRequestReview(input: { pullRequestReviewId: $id }) { clientMutationId } }', { id: reviewId })

export const updatePullRequest = (path: string, pr: PrRef, fields: { title?: string; body?: string }) =>
  mutate(
    path,
    'mutation($id: ID!, $title: String, $body: String) { updatePullRequest(input: { pullRequestId: $id, title: $title, body: $body }) { clientMutationId } }',
    { id: pr.id, title: fields.title ?? null, body: fields.body ?? null }
  )

export const setPullRequestState = (path: string, pr: PrRef, state: 'open' | 'closed') =>
  mutate(
    path,
    state === 'closed'
      ? 'mutation($id: ID!) { closePullRequest(input: { pullRequestId: $id }) { clientMutationId } }'
      : 'mutation($id: ID!) { reopenPullRequest(input: { pullRequestId: $id }) { clientMutationId } }',
    { id: pr.id }
  )

export const setDraft = (path: string, pr: PrRef, draft: boolean) =>
  mutate(
    path,
    draft
      ? 'mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { clientMutationId } }'
      : 'mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }',
    { id: pr.id }
  )

export async function mergePullRequest(
  path: string,
  pr: PrRef,
  method: MergeMethod,
  opts: { headline?: string; body?: string; expectedHeadOid: string; deleteBranch?: { repo: string; branch: string } }
) {
  const info = await requireInfo(path)
  await graphql(
    info.host,
    `mutation($id: ID!, $method: PullRequestMergeMethod!, $headline: String, $body: String, $oid: GitObjectID) {
      mergePullRequest(input: { pullRequestId: $id, mergeMethod: $method, commitHeadline: $headline, commitBody: $body, expectedHeadOid: $oid }) { clientMutationId }
    }`,
    { id: pr.id, method, headline: opts.headline || null, body: opts.body ?? null, oid: opts.expectedHeadOid }
  )
  if (opts.deleteBranch) {
    const { repo, branch } = opts.deleteBranch
    try {
      await request(info.host, `/repos/${repoPath(repo)}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE' })
    } catch (e) {
      // Already deleted (e.g. auto-delete on merge) is fine.
      if (!(e instanceof GitHubError) || e.status !== 422) throw e
    }
  }
  clearGitHubCache(path)
}

async function addRemove(host: string, base: string, field: string, add: string[], remove: string[]) {
  if (add.length) await request(host, base, { method: 'POST', body: { [field]: add } })
  if (remove.length) await request(host, base, { method: 'DELETE', body: { [field]: remove } })
}

export async function setReviewers(path: string, pr: PrRef, add: string[], remove: string[]) {
  const info = await requireInfo(path)
  await addRemove(info.host, `${pullsPath(info, pr.number)}/requested_reviewers`, 'reviewers', add, remove)
}

export async function setAssignees(path: string, pr: PrRef, add: string[], remove: string[]) {
  const info = await requireInfo(path)
  await addRemove(info.host, `${issuePath(info, pr.number)}/assignees`, 'assignees', add, remove)
}

export async function setLabels(path: string, pr: PrRef, add: string[], remove: string[]) {
  const info = await requireInfo(path)
  if (add.length) await request(info.host, `${issuePath(info, pr.number)}/labels`, { method: 'POST', body: { labels: add } })
  for (const label of remove) {
    await request(info.host, `${issuePath(info, pr.number)}/labels/${encodeURIComponent(label)}`, { method: 'DELETE' })
  }
}

export async function createPullRequest(path: string, pr: NewPullRequest): Promise<{ number: number; url: string }> {
  const info = await requireInfo(path)
  const created = await request<{ number: number; html_url: string }>(info.host, `/repos/${repoPath(info.repo)}/pulls`, {
    method: 'POST',
    body: { title: pr.title, head: pr.head, base: pr.base, body: pr.body, draft: pr.draft }
  })
  clearGitHubCache(path)
  return { number: created.number, url: created.html_url }
}
