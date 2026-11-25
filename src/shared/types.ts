// Types shared between the Electron main process and the renderer.

export interface Commit {
  sha: string
  parents: string[]
  author: string
  email: string
  /** Author date, unix seconds. */
  date: number
  subject: string
}

export type RefType = 'head' | 'remote' | 'tag'

export interface Ref {
  /** Full ref name, e.g. refs/heads/main */
  name: string
  /** Short name, e.g. main, origin/main, v1.0.0 */
  short: string
  type: RefType
  /** Commit the ref points to (peeled for annotated tags). */
  sha: string
  /** Remote name, for remote-tracking branches. */
  remote?: string
  /** Upstream short name (e.g. origin/main), for local branches. */
  upstream?: string
  ahead?: number
  behind?: number
  /** Upstream is configured but no longer exists on the remote. */
  gone?: boolean
  /** This local branch is checked out. */
  current?: boolean
}

export interface Stash {
  index: number
  /** stash@{n} */
  ref: string
  sha: string
  parents: string[]
  message: string
  date: number
}

export type FileStatus = 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U' | '?'

export interface FileChange {
  path: string
  oldPath?: string
  status: FileStatus
  /** Revision to diff instead of the selected commit (untracked files stored in a stash). */
  rev?: string
}

export type RepoOperation = 'none' | 'merge' | 'rebase' | 'cherry-pick' | 'revert'

export interface Status {
  /** Checked-out branch, or null when HEAD is detached. */
  branch: string | null
  /** HEAD commit, or null on an unborn branch. */
  head: string | null
  upstream: string | null
  ahead: number
  behind: number
  staged: FileChange[]
  unstaged: FileChange[]
  conflicted: FileChange[]
  operation: RepoOperation
}

export interface CommitDetails extends Commit {
  /** Full raw commit message. */
  message: string
  committer: string
  committerEmail: string
  committerDate: number
  files: FileChange[]
}

export interface RepoSnapshot {
  commits: Commit[]
  refs: Ref[]
  stashes: Stash[]
  remotes: string[]
  status: Status
}

export type DiffTarget =
  | { kind: 'unstaged'; path: string; untracked?: boolean; conflicted?: boolean }
  | { kind: 'staged'; path: string; oldPath?: string }
  | { kind: 'commit'; sha: string; path: string; oldPath?: string }

export type DiffLineType = ' ' | '+' | '-' | '\\'

export interface DiffLine {
  type: DiffLineType
  text: string
  oldNo?: number
  newNo?: number
}

export interface DiffHunk {
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

export interface FileDiff {
  /** Raw header lines (diff --git, index, ---, +++ ...). */
  header: string[]
  hunks: DiffHunk[]
  binary: boolean
}

export type PullRequestState = 'open' | 'closed' | 'merged'

export interface PullRequest {
  number: number
  title: string
  state: PullRequestState
  draft: boolean
  url: string
  author: string
  /** Branch the PR merges from. */
  headRef: string
  /** owner/name of the repository holding the head branch (null if that fork was deleted). */
  headRepo: string | null
  /** Branch the PR merges into. */
  baseRef: string
  updatedAt: string
}

export interface GitHubInfo {
  host: string
  /** owner/name of the repository whose pull requests are shown (upstream > origin > first). */
  repo: string
  /** e.g. https://github.com/owner/name */
  webUrl: string
  /** Remote name → owner/name, for every remote hosted on GitHub. */
  remotes: Record<string, string>
  /** Default branch of `repo`, when GitHub could tell us. */
  defaultBranch: string | null
  authenticated: boolean
}

export interface CommitPullRequests {
  prs: PullRequest[]
  /** Explains an empty result, e.g. the commit was never pushed. */
  notice?: string
}

// ------------------------------------------------------------------ GitHub pull requests (full)

export interface GhUser {
  login: string
  avatarUrl: string
  name?: string
}

export interface GhLabel {
  name: string
  color: string
  description?: string
}

export type PrFilter = 'review-requested' | 'assigned' | 'created' | 'involves' | 'all'
export type PrListState = 'open' | 'closed'
export type CheckState = 'success' | 'failure' | 'pending' | 'neutral' | 'skipped'
export type ReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
export type ReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING'
export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'
export type MergeMethod = 'MERGE' | 'SQUASH' | 'REBASE'
export type DiffSide = 'LEFT' | 'RIGHT'

export interface PrListItem {
  number: number
  title: string
  state: PullRequestState
  draft: boolean
  url: string
  author: GhUser | null
  headRef: string
  headRepo: string | null
  baseRef: string
  updatedAt: string
  reviewDecision: ReviewDecision
  checkState: CheckState | null
  comments: number
}

export interface PrListResult {
  viewer: string
  items: PrListItem[]
  counts: Record<PrFilter, number>
}

export interface PrComment {
  id: string
  databaseId: number
  kind: 'issue' | 'review'
  author: GhUser | null
  body: string
  bodyHTML: string
  createdAt: string
  viewerCanUpdate: boolean
  viewerCanDelete: boolean
  /** Part of the viewer's unsubmitted review. */
  pending: boolean
}

export interface PrReviewThread {
  id: string
  path: string
  /** Line in the current diff; null when the thread is outdated. */
  line: number | null
  startLine: number | null
  originalLine: number | null
  side: DiffSide
  isResolved: boolean
  isOutdated: boolean
  viewerCanResolve: boolean
  viewerCanUnresolve: boolean
  viewerCanReply: boolean
  /** Review the thread was started in. */
  reviewId: string | null
  diffHunk: string
  comments: PrComment[]
}

export type PrTimelineItem =
  | { type: 'comment'; comment: PrComment }
  | { type: 'review'; id: string; author: GhUser | null; state: ReviewState; body: string; bodyHTML: string; createdAt: string }
  | { type: 'commit'; oid: string; abbreviatedOid: string; headline: string; author: string; createdAt: string }
  | { type: 'event'; kind: string; actor: GhUser | null; text: string; createdAt: string }

export interface PrCheck {
  name: string
  state: CheckState
  description: string | null
  url: string | null
}

export interface PrCommit {
  oid: string
  abbreviatedOid: string
  headline: string
  author: string
  avatarUrl: string | null
  date: string
  checkState: CheckState | null
}

export interface PrReviewer {
  login: string
  avatarUrl: string | null
  isTeam: boolean
  /** Latest submitted review state, if any. */
  state: ReviewState | null
  /** A review is currently requested from them. */
  requested: boolean
}

export interface PrDetail {
  id: string
  number: number
  title: string
  body: string
  bodyHTML: string
  url: string
  state: PullRequestState
  draft: boolean
  createdAt: string
  mergedAt: string | null
  mergedBy: GhUser | null
  author: GhUser | null
  headRef: string
  headRepo: string | null
  headOid: string
  baseRef: string
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  mergeStateStatus: string
  reviewDecision: ReviewDecision
  additions: number
  deletions: number
  changedFiles: number
  labels: GhLabel[]
  assignees: GhUser[]
  reviewers: PrReviewer[]
  commits: PrCommit[]
  checks: PrCheck[]
  checkState: CheckState | null
  timeline: PrTimelineItem[]
  timelineTotal: number
  threads: PrReviewThread[]
  pendingReview: { id: string; comments: number } | null
  viewer: { login: string; avatarUrl: string; canUpdate: boolean; isAuthor: boolean; canMerge: boolean }
  mergeMethods: MergeMethod[]
  deleteBranchOnMerge: boolean
}

export interface PrFile {
  path: string
  previousPath?: string
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged'
  additions: number
  deletions: number
  /** Null when GitHub doesn't provide a patch (binary or very large files). */
  diff: FileDiff | null
}

/** Identifies a PR for mutations: GraphQL node id plus number for REST calls. */
export interface PrRef {
  id: string
  number: number
}

export interface NewReviewComment {
  path: string
  line: number
  side: DiffSide
  startLine?: number
  startSide?: DiffSide
  body: string
  /** single: publish now; review: add to the viewer's pending review (created if needed). */
  mode: 'single' | 'review'
  commitId: string
  pendingReviewId?: string
}

export interface NewPullRequest {
  /** Branch name, or owner:branch for forks. */
  head: string
  base: string
  title: string
  body: string
  draft: boolean
}

/** What to do with uncommitted changes when switching branches. */
export type DirtyPolicy = 'stash' | 'stash-reapply' | 'carry'

export type SwitchTarget =
  /** An existing local branch. */
  | { kind: 'branch'; branch: string }
  /** Create a local branch tracking a remote branch. */
  | { kind: 'track'; branch: string; remoteRef: string }
  /** Move an existing local branch to startPoint (e.g. origin/dev) and check it out. */
  | { kind: 'reset'; branch: string; startPoint: string }
  /** Detached HEAD at a commit or tag. */
  | { kind: 'detach'; rev: string }

export interface SwitchResult {
  /** Uncommitted changes were stashed before switching. */
  stashed: boolean
  /** ...and put back on the new branch. */
  reapplied: boolean
  /** Re-applying conflicted; the changes stay in the stash. */
  reapplyConflict: boolean
  stashMessage: string | null
  /** Branch checked out afterwards (null when detached). */
  branch: string | null
}

export type PullMode = 'merge' | 'ff-only' | 'rebase'
export type ResetMode = 'soft' | 'mixed' | 'hard'
export type ApplyMode = 'stage' | 'unstage' | 'discard'

export interface PushOptions {
  remote: string
  remoteBranch: string
  setUpstream?: boolean
  force?: boolean
}

/** Operations on one repository, implemented in the main process. */
export interface RepoApi {
  snapshot(limit: number): Promise<RepoSnapshot>
  status(): Promise<Status>
  commitDetails(sha: string, isStash?: boolean): Promise<CommitDetails>
  diff(target: DiffTarget): Promise<FileDiff>
  pendingMessage(): Promise<string>
  lastCommitMessage(): Promise<string>

  stage(paths: string[]): Promise<void>
  stageAll(): Promise<void>
  unstage(paths: string[]): Promise<void>
  unstageAll(): Promise<void>
  discard(files: FileChange[]): Promise<void>
  discardAll(): Promise<void>
  applyPatch(patch: string, mode: ApplyMode): Promise<void>
  commit(message: string, amend: boolean): Promise<void>

  checkout(ref: string): Promise<void>
  /** Switch branches, handling uncommitted changes according to policy. */
  switchTo(target: SwitchTarget, policy: DirtyPolicy): Promise<SwitchResult>
  /** Commits only on left and only on right (git rev-list --left-right --count left...right). */
  compareRefs(left: string, right: string): Promise<{ left: number; right: number }>
  checkoutRemoteBranch(remoteBranch: string, localName: string): Promise<void>
  createBranch(name: string, startPoint: string, checkout: boolean): Promise<void>
  renameBranch(oldName: string, newName: string): Promise<void>
  deleteBranch(name: string, force: boolean): Promise<void>
  deleteRemoteBranch(remote: string, branch: string): Promise<void>
  merge(ref: string, noFastForward: boolean): Promise<void>
  rebase(onto: string): Promise<void>
  cherryPick(sha: string): Promise<void>
  revert(sha: string): Promise<void>
  reset(sha: string, mode: ResetMode): Promise<void>

  createTag(name: string, sha: string, message?: string): Promise<void>
  deleteTag(name: string): Promise<void>
  pushTag(remote: string, name: string): Promise<void>
  deleteRemoteTag(remote: string, name: string): Promise<void>

  stashSave(message: string, includeUntracked: boolean): Promise<void>
  stashApply(index: number): Promise<void>
  stashPop(index: number): Promise<void>
  stashDrop(index: number): Promise<void>

  fetch(): Promise<void>
  pull(mode: PullMode): Promise<void>
  push(branch: string, options: PushOptions): Promise<void>

  continueOperation(): Promise<void>
  abortOperation(): Promise<void>
  skipRebaseCommit(): Promise<void>
  resolveWith(paths: string[], side: 'ours' | 'theirs'): Promise<void>
  ignore(pattern: string): Promise<void>

  githubInfo(): Promise<GitHubInfo | null>
  openPullRequests(force?: boolean): Promise<PullRequest[]>
  pullRequestsForCommit(sha: string): Promise<CommitPullRequests>

  pullRequestList(filter: PrFilter, state: PrListState): Promise<PrListResult>
  pullRequestDetail(number: number): Promise<PrDetail>
  pullRequestFiles(number: number): Promise<PrFile[]>
  assignableUsers(query: string): Promise<GhUser[]>
  /** People who can be @mentioned in this repository (what github.com's autocomplete uses). */
  mentionableUsers(query: string): Promise<GhUser[]>
  repoLabels(): Promise<GhLabel[]>
  renderMarkdown(text: string): Promise<string>
  prAddComment(pr: PrRef, body: string): Promise<void>
  prEditComment(kind: 'issue' | 'review', id: string, body: string): Promise<void>
  prDeleteComment(kind: 'issue' | 'review', id: string): Promise<void>
  prAddReviewComment(pr: PrRef, comment: NewReviewComment): Promise<void>
  prReplyToThread(pr: PrRef, threadId: string, firstCommentId: number, body: string, pendingReviewId?: string): Promise<void>
  prResolveThread(threadId: string, resolved: boolean): Promise<void>
  prSubmitReview(pr: PrRef, event: ReviewEvent, body: string, pendingReviewId?: string): Promise<void>
  prDiscardReview(reviewId: string): Promise<void>
  prUpdate(pr: PrRef, fields: { title?: string; body?: string }): Promise<void>
  prSetState(pr: PrRef, state: 'open' | 'closed'): Promise<void>
  prSetDraft(pr: PrRef, draft: boolean): Promise<void>
  prMerge(pr: PrRef, method: MergeMethod, options: { headline?: string; body?: string; expectedHeadOid: string; deleteBranch?: { repo: string; branch: string } }): Promise<void>
  prSetReviewers(pr: PrRef, add: string[], remove: string[]): Promise<void>
  prSetAssignees(pr: PrRef, add: string[], remove: string[]): Promise<void>
  prSetLabels(pr: PrRef, add: string[], remove: string[]): Promise<void>
  createPullRequest(pr: NewPullRequest): Promise<{ number: number; url: string }>
  checkoutPullRequest(number: number, headRef: string, headRepo: string | null, policy?: DirtyPolicy): Promise<SwitchResult>
}

/** App-level operations (not bound to a repository). */
export interface AppApi {
  initialRepo(): Promise<string | null>
  recentRepos(): Promise<string[]>
  forgetRepo(path: string): Promise<string[]>
  pickDirectory(title: string): Promise<string | null>
  openRepo(path: string): Promise<string>
  initRepo(path: string): Promise<string>
  cloneRepo(url: string, parentDir: string): Promise<string>
  openTerminal(path: string): Promise<void>
  openPath(path: string): Promise<void>
  revealPath(path: string): Promise<void>
  copyText(text: string): Promise<void>
  openExternal(url: string): Promise<void>
}

export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: string }

export interface RepoChangeEvent {
  path: string
  kind: 'status' | 'all'
}

export interface TerminalBridge {
  create(opts: { cwd: string; cols: number; rows: number }): Promise<{ id: number; shell: string }>
  write(id: number, data: string): void
  resize(id: number, cols: number, rows: number): void
  kill(id: number): void
  onData(cb: (id: number, data: string) => void): () => void
  onExit(cb: (id: number, code: number) => void): () => void
}

/** What the preload script exposes on window.bridge. */
export interface Bridge {
  app(method: string, args: unknown[]): Promise<ApiResult<unknown>>
  repo(path: string, method: string, args: unknown[]): Promise<ApiResult<unknown>>
  onRepoChanged(cb: (e: RepoChangeEvent) => void): () => void
  terminal: TerminalBridge
  agent(method: string, args: unknown[]): Promise<ApiResult<unknown>>
  onAgentEvent(cb: (e: import('./agent').AgentEvent) => void): () => void
}
