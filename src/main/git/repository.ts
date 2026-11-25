import { existsSync } from 'node:fs'
import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  ApplyMode,
  DirtyPolicy,
  SwitchResult,
  SwitchTarget,
  CommitDetails,
  CommitPullRequests,
  GhLabel,
  GhUser,
  GitHubInfo,
  MergeMethod,
  NewPullRequest,
  NewReviewComment,
  PrDetail,
  PrFile,
  PrFilter,
  PrListResult,
  PrListState,
  PrRef,
  PullRequest,
  ReviewEvent,
  DiffTarget,
  FileChange,
  FileDiff,
  PullMode,
  PushOptions,
  RepoApi,
  RepoOperation,
  RepoSnapshot,
  ResetMode,
  Status
} from '../../shared/types'
import {
  DETAILS_FORMAT,
  LOG_FORMAT,
  REF_FORMAT,
  STASH_FORMAT,
  parseCommitHeader,
  parseDiff,
  parseLog,
  parseNameStatus,
  parseRefs,
  parseStashes,
  parseStatus
} from './parsers'
import { runGit, type RunOptions } from './runner'
import * as github from '../github'
import * as prs from '../pullRequests'

// Make diff output independent of the user's diff.* config so patches can be re-applied.
const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/']

const gitDirCache = new Map<string, string>()

/** Resolve the top-level directory of the repository containing `path`. */
export async function resolveRepoRoot(path: string): Promise<string> {
  try {
    const top = (await runGit(path, ['rev-parse', '--show-toplevel'])).trim()
    if (!top) throw new Error('empty')
    return top
  } catch {
    throw new Error(`Not a Git repository (or a bare one): ${path}`)
  }
}

export class Repository implements RepoApi {
  constructor(readonly path: string) {}

  #git(args: string[], opts?: RunOptions): Promise<string> {
    return runGit(this.path, args, opts)
  }

  async #gitDir(): Promise<string> {
    let dir = gitDirCache.get(this.path)
    if (!dir) {
      dir = (await this.#git(['rev-parse', '--absolute-git-dir'])).trim()
      gitDirCache.set(this.path, dir)
    }
    return dir
  }

  async #hasCommits(): Promise<boolean> {
    try {
      await this.#git(['rev-parse', '--verify', '-q', 'HEAD'])
      return true
    } catch {
      return false
    }
  }

  async #operation(): Promise<RepoOperation> {
    const dir = await this.#gitDir()
    if (existsSync(join(dir, 'rebase-merge')) || existsSync(join(dir, 'rebase-apply'))) return 'rebase'
    if (existsSync(join(dir, 'MERGE_HEAD'))) return 'merge'
    if (existsSync(join(dir, 'CHERRY_PICK_HEAD'))) return 'cherry-pick'
    if (existsSync(join(dir, 'REVERT_HEAD'))) return 'revert'
    return 'none'
  }

  async #parentCount(sha: string): Promise<number> {
    const out = await this.#git(['rev-list', '--parents', '-n1', sha, '--'])
    return out.trim().split(' ').length - 1
  }

  // ---------------------------------------------------------------- reading

  async snapshot(limit: number): Promise<RepoSnapshot> {
    const [commits, refs, stashes, remotes, status] = await Promise.all([
      this.#log(limit),
      this.#git(['for-each-ref', `--format=${REF_FORMAT}`, 'refs/heads', 'refs/remotes', 'refs/tags']).then(parseRefs),
      this.#git(['stash', 'list', `--format=${STASH_FORMAT}`]).then(parseStashes),
      this.#git(['remote']).then((out) => out.split('\n').filter(Boolean)),
      this.status()
    ])
    return { commits, refs, stashes, remotes, status }
  }

  async #log(limit: number) {
    try {
      const out = await this.#git([
        'log',
        '--exclude=refs/stash',
        '--all',
        '--date-order',
        `-n${Math.max(1, Math.floor(limit))}`,
        `--format=${LOG_FORMAT}`
      ])
      return parseLog(out)
    } catch (e) {
      if (await this.#hasCommits()) throw e
      return [] // empty repository
    }
  }

  async status(): Promise<Status> {
    const [out, operation] = await Promise.all([
      // --no-optional-locks: don't refresh the index, which would re-trigger the file watcher.
      this.#git(['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']),
      this.#operation()
    ])
    return { ...parseStatus(out), operation }
  }

  async commitDetails(sha: string, isStash = false): Promise<CommitDetails> {
    const [header, files] = await Promise.all([
      this.#git(['show', '-s', `--format=${DETAILS_FORMAT}`, sha, '--']),
      this.#git(['show', '--format=', '--name-status', '-z', '-M', '--diff-merges=first-parent', sha, '--'])
    ])
    const details: CommitDetails = { ...parseCommitHeader(header), files: parseNameStatus(files) }
    if (isStash && details.parents.length > 2) {
      // The third parent of a stash commit holds its untracked files.
      const rev = `${sha}^3`
      const untracked = parseNameStatus(await this.#git(['show', '--format=', '--name-status', '-z', rev, '--']))
      details.files.push(...untracked.map((f): FileChange => ({ ...f, status: 'A', rev })))
    }
    return details
  }

  async diff(target: DiffTarget): Promise<FileDiff> {
    let out: string
    if (target.kind === 'unstaged') {
      if (target.untracked) {
        out = await this.#git(['diff', '--no-index', ...DIFF_FLAGS, '--', '/dev/null', target.path], { okCodes: [1] })
      } else if (target.conflicted) {
        // Show the conflicted file (with markers) relative to HEAD.
        out = await this.#git(['diff', ...DIFF_FLAGS, 'HEAD', '--', target.path])
      } else {
        out = await this.#git(['diff', ...DIFF_FLAGS, '--', target.path])
      }
    } else if (target.kind === 'staged') {
      const paths = target.oldPath ? [target.oldPath, target.path] : [target.path]
      out = await this.#git(['diff', '--cached', '-M', ...DIFF_FLAGS, '--', ...paths])
    } else {
      const paths = target.oldPath ? [target.oldPath, target.path] : [target.path]
      out = await this.#git(['show', '--format=', '-M', '--diff-merges=first-parent', ...DIFF_FLAGS, target.sha, '--', ...paths])
    }
    return parseDiff(out)
  }

  /** Message git prepared for a merge/cherry-pick/revert in progress. */
  async pendingMessage(): Promise<string> {
    try {
      const raw = await readFile(join(await this.#gitDir(), 'MERGE_MSG'), 'utf8')
      return raw
        .split('\n')
        .filter((l) => !l.startsWith('#'))
        .join('\n')
        .trim()
    } catch {
      return ''
    }
  }

  async lastCommitMessage(): Promise<string> {
    if (!(await this.#hasCommits())) return ''
    return (await this.#git(['log', '-1', '--format=%B'])).trim()
  }

  // ---------------------------------------------------------------- index & working tree

  async stage(paths: string[]): Promise<void> {
    if (paths.length) await this.#git(['add', '-A', '--', ...paths])
  }

  async stageAll(): Promise<void> {
    await this.#git(['add', '-A'])
  }

  async unstage(paths: string[]): Promise<void> {
    if (!paths.length) return
    if (await this.#hasCommits()) await this.#git(['reset', '-q', '--', ...paths])
    else await this.#git(['rm', '-r', '-q', '--cached', '--', ...paths])
  }

  async unstageAll(): Promise<void> {
    if (await this.#hasCommits()) await this.#git(['reset', '-q'])
    else await this.#git(['rm', '-r', '-q', '--cached', '.'])
  }

  async discard(files: FileChange[]): Promise<void> {
    const untracked = files.filter((f) => f.status === '?').map((f) => f.path)
    const tracked = files.filter((f) => f.status !== '?').map((f) => f.path)
    if (untracked.length) await this.#git(['clean', '-f', '-q', '--', ...untracked])
    if (tracked.length) await this.#git(['checkout', '-q', '--', ...tracked])
  }

  async discardAll(): Promise<void> {
    if (await this.#hasCommits()) await this.#git(['reset', '--hard', '-q'])
    await this.#git(['clean', '-f', '-d', '-q'])
  }

  async applyPatch(patch: string, mode: ApplyMode): Promise<void> {
    const args = ['apply', '--recount', '--whitespace=nowarn']
    if (mode !== 'discard') args.push('--cached')
    if (mode !== 'stage') args.push('--reverse')
    await this.#git([...args, '-'], { input: patch })
  }

  async commit(message: string, amend: boolean): Promise<void> {
    const args = ['commit', '-F', '-']
    if (amend) args.push('--amend')
    await this.#git(args, { input: message })
  }

  // ---------------------------------------------------------------- branches & history

  async checkout(ref: string): Promise<void> {
    await this.#git(['checkout', '-q', ref, '--'])
  }

  async compareRefs(left: string, right: string): Promise<{ left: number; right: number }> {
    const out = await this.#git(['rev-list', '--left-right', '--count', `${left}...${right}`, '--'])
    const [l, r] = out.trim().split(/\s+/).map(Number)
    return { left: l || 0, right: r || 0 }
  }

  /**
   * Run a branch switch with the working tree handled per policy: stash first (and optionally
   * re-apply afterwards), or carry changes over like plain git. If the switch itself fails,
   * stashed changes are put back so nothing is lost.
   */
  async #switching(label: string, policy: DirtyPolicy, op: () => Promise<string | null>): Promise<SwitchResult> {
    const status = await this.status()
    if (status.operation !== 'none') throw new Error(`Finish or abort the ${status.operation} in progress before switching branches.`)
    if (status.conflicted.length) throw new Error('Resolve the conflicted files before switching branches.')
    const dirty = status.staged.length + status.unstaged.length > 0
    const stashMessage = `Gitlane: auto-stash before switching to ${label}`
    let stashed = false
    if (dirty && policy !== 'carry') {
      await this.#git(['stash', 'push', '--include-untracked', '-m', stashMessage])
      stashed = true
    }
    let branch: string | null
    try {
      branch = await op()
    } catch (e) {
      if (stashed) {
        // Restore exactly what was there (including what was staged).
        await this.#git(['stash', 'pop', '--index']).catch(() => this.#git(['stash', 'pop']).catch(() => undefined))
      }
      throw e
    }
    let reapplied = false
    let reapplyConflict = false
    if (stashed && policy === 'stash-reapply') {
      try {
        await this.#git(['stash', 'pop'])
        reapplied = true
      } catch {
        reapplyConflict = true // git keeps the stash entry when popping conflicts
      }
    }
    return { stashed, reapplied, reapplyConflict, stashMessage: stashed ? stashMessage : null, branch }
  }

  switchTo(target: SwitchTarget, policy: DirtyPolicy): Promise<SwitchResult> {
    const label = target.kind === 'detach' ? target.rev : target.branch
    return this.#switching(label, policy, async () => {
      switch (target.kind) {
        case 'branch':
          await this.#git(['checkout', '-q', target.branch, '--'])
          return target.branch
        case 'track':
          await this.#git(['checkout', '-q', '-b', target.branch, '--track', target.remoteRef, '--'])
          return target.branch
        case 'reset':
          // -B moves the branch to startPoint (creating it if needed) and checks it out.
          await this.#git(['checkout', '-q', '-B', target.branch, target.startPoint, '--'])
          return target.branch
        case 'detach':
          await this.#git(['checkout', '-q', '--detach', target.rev, '--'])
          return null
      }
    })
  }

  async checkoutRemoteBranch(remoteBranch: string, localName: string): Promise<void> {
    await this.#git(['checkout', '-q', '-b', localName, '--track', remoteBranch, '--'])
  }

  async createBranch(name: string, startPoint: string, checkout: boolean): Promise<void> {
    if (checkout) await this.#git(['checkout', '-q', '-b', name, startPoint, '--'])
    else await this.#git(['branch', name, startPoint])
  }

  async renameBranch(oldName: string, newName: string): Promise<void> {
    await this.#git(['branch', '-m', oldName, newName])
  }

  async deleteBranch(name: string, force: boolean): Promise<void> {
    await this.#git(['branch', force ? '-D' : '-d', name])
  }

  async deleteRemoteBranch(remote: string, branch: string): Promise<void> {
    await this.#git(['push', remote, '--delete', branch])
  }

  async merge(ref: string, noFastForward: boolean): Promise<void> {
    const args = ['merge', '--no-edit']
    if (noFastForward) args.push('--no-ff')
    await this.#git([...args, ref])
  }

  async rebase(onto: string): Promise<void> {
    await this.#git(['rebase', onto])
  }

  async cherryPick(sha: string): Promise<void> {
    const mainline = (await this.#parentCount(sha)) > 1 ? ['-m', '1'] : []
    await this.#git(['cherry-pick', ...mainline, sha])
  }

  async revert(sha: string): Promise<void> {
    const mainline = (await this.#parentCount(sha)) > 1 ? ['-m', '1'] : []
    await this.#git(['revert', '--no-edit', ...mainline, sha])
  }

  async reset(sha: string, mode: ResetMode): Promise<void> {
    await this.#git(['reset', `--${mode}`, '-q', sha, '--'])
  }

  // ---------------------------------------------------------------- tags

  async createTag(name: string, sha: string, message?: string): Promise<void> {
    if (message) await this.#git(['tag', '-a', name, '-m', message, sha])
    else await this.#git(['tag', name, sha])
  }

  async deleteTag(name: string): Promise<void> {
    await this.#git(['tag', '-d', name])
  }

  async pushTag(remote: string, name: string): Promise<void> {
    await this.#git(['push', remote, `refs/tags/${name}`])
  }

  async deleteRemoteTag(remote: string, name: string): Promise<void> {
    await this.#git(['push', remote, '--delete', `refs/tags/${name}`])
  }

  // ---------------------------------------------------------------- stash

  async stashSave(message: string, includeUntracked: boolean): Promise<void> {
    const args = ['stash', 'push']
    if (includeUntracked) args.push('--include-untracked')
    if (message) args.push('-m', message)
    await this.#git(args)
  }

  async stashApply(index: number): Promise<void> {
    await this.#git(['stash', 'apply', `stash@{${index}}`])
  }

  async stashPop(index: number): Promise<void> {
    await this.#git(['stash', 'pop', `stash@{${index}}`])
  }

  async stashDrop(index: number): Promise<void> {
    await this.#git(['stash', 'drop', `stash@{${index}}`])
  }

  // ---------------------------------------------------------------- remotes

  async fetch(): Promise<void> {
    await this.#git(['fetch', '--all', '--prune'])
  }

  async pull(mode: PullMode): Promise<void> {
    const flag = mode === 'rebase' ? '--rebase' : mode === 'ff-only' ? '--ff-only' : '--no-rebase'
    await this.#git(['pull', flag])
  }

  async push(branch: string, options: PushOptions): Promise<void> {
    const args = ['push']
    if (options.force) args.push('--force-with-lease')
    if (options.setUpstream) args.push('--set-upstream')
    args.push(options.remote, `refs/heads/${branch}:refs/heads/${options.remoteBranch}`)
    await this.#git(args)
  }

  // ---------------------------------------------------------------- merge/rebase in progress

  async continueOperation(): Promise<void> {
    switch (await this.#operation()) {
      case 'rebase':
        return void (await this.#git(['rebase', '--continue']))
      case 'merge':
        return void (await this.#git(['commit', '--no-edit']))
      case 'cherry-pick':
        return void (await this.#git(['cherry-pick', '--continue']))
      case 'revert':
        return void (await this.#git(['revert', '--continue']))
    }
  }

  async abortOperation(): Promise<void> {
    switch (await this.#operation()) {
      case 'rebase':
        return void (await this.#git(['rebase', '--abort']))
      case 'merge':
        return void (await this.#git(['merge', '--abort']))
      case 'cherry-pick':
        return void (await this.#git(['cherry-pick', '--abort']))
      case 'revert':
        return void (await this.#git(['revert', '--abort']))
    }
  }

  async skipRebaseCommit(): Promise<void> {
    await this.#git(['rebase', '--skip'])
  }

  async resolveWith(paths: string[], side: 'ours' | 'theirs'): Promise<void> {
    if (!paths.length) return
    await this.#git(['checkout', `--${side}`, '--', ...paths])
    await this.#git(['add', '--', ...paths])
  }

  async ignore(pattern: string): Promise<void> {
    const file = join(this.path, '.gitignore')
    let prefix = ''
    try {
      const current = await readFile(file, 'utf8')
      if (current && !current.endsWith('\n')) prefix = '\n'
    } catch {
      /* no .gitignore yet */
    }
    await appendFile(file, `${prefix}${pattern}\n`)
  }

  // ---------------------------------------------------------------- GitHub

  githubInfo(): Promise<GitHubInfo | null> {
    return github.getGitHubInfo(this.path)
  }

  openPullRequests(force = false): Promise<PullRequest[]> {
    return github.listOpenPullRequests(this.path, force)
  }

  pullRequestsForCommit(sha: string): Promise<CommitPullRequests> {
    return github.pullRequestsForCommit(this.path, sha)
  }

  pullRequestList(filter: PrFilter, state: PrListState): Promise<PrListResult> {
    return prs.listPullRequests(this.path, filter, state)
  }

  pullRequestDetail(number: number): Promise<PrDetail> {
    return prs.pullRequestDetail(this.path, number)
  }

  pullRequestFiles(number: number): Promise<PrFile[]> {
    return prs.pullRequestFiles(this.path, number)
  }

  assignableUsers(query: string): Promise<GhUser[]> {
    return prs.assignableUsers(this.path, query)
  }

  mentionableUsers(query: string): Promise<GhUser[]> {
    return prs.mentionableUsers(this.path, query)
  }

  repoLabels(): Promise<GhLabel[]> {
    return prs.repoLabels(this.path)
  }

  renderMarkdown(text: string): Promise<string> {
    return prs.renderMarkdown(this.path, text)
  }

  prAddComment(pr: PrRef, body: string): Promise<void> {
    return prs.addComment(this.path, pr, body)
  }

  prEditComment(kind: 'issue' | 'review', id: string, body: string): Promise<void> {
    return prs.editComment(this.path, kind, id, body)
  }

  prDeleteComment(kind: 'issue' | 'review', id: string): Promise<void> {
    return prs.deleteComment(this.path, kind, id)
  }

  prAddReviewComment(pr: PrRef, comment: NewReviewComment): Promise<void> {
    return prs.addReviewComment(this.path, pr, comment)
  }

  prReplyToThread(pr: PrRef, threadId: string, firstCommentId: number, body: string, pendingReviewId?: string): Promise<void> {
    return prs.replyToThread(this.path, pr, threadId, firstCommentId, body, pendingReviewId)
  }

  prResolveThread(threadId: string, resolved: boolean): Promise<void> {
    return prs.resolveThread(this.path, threadId, resolved)
  }

  prSubmitReview(pr: PrRef, event: ReviewEvent, body: string, pendingReviewId?: string): Promise<void> {
    return prs.submitReview(this.path, pr, event, body, pendingReviewId)
  }

  prDiscardReview(reviewId: string): Promise<void> {
    return prs.discardReview(this.path, reviewId)
  }

  prUpdate(pr: PrRef, fields: { title?: string; body?: string }): Promise<void> {
    return prs.updatePullRequest(this.path, pr, fields)
  }

  prSetState(pr: PrRef, state: 'open' | 'closed'): Promise<void> {
    return prs.setPullRequestState(this.path, pr, state)
  }

  prSetDraft(pr: PrRef, draft: boolean): Promise<void> {
    return prs.setDraft(this.path, pr, draft)
  }

  prMerge(
    pr: PrRef,
    method: MergeMethod,
    options: { headline?: string; body?: string; expectedHeadOid: string; deleteBranch?: { repo: string; branch: string } }
  ): Promise<void> {
    return prs.mergePullRequest(this.path, pr, method, options)
  }

  prSetReviewers(pr: PrRef, add: string[], remove: string[]): Promise<void> {
    return prs.setReviewers(this.path, pr, add, remove)
  }

  prSetAssignees(pr: PrRef, add: string[], remove: string[]): Promise<void> {
    return prs.setAssignees(this.path, pr, add, remove)
  }

  prSetLabels(pr: PrRef, add: string[], remove: string[]): Promise<void> {
    return prs.setLabels(this.path, pr, add, remove)
  }

  createPullRequest(pr: NewPullRequest): Promise<{ number: number; url: string }> {
    return prs.createPullRequest(this.path, pr)
  }

  async #branchExists(name: string): Promise<boolean> {
    try {
      await this.#git(['rev-parse', '--verify', '-q', `refs/heads/${name}`])
      return true
    } catch {
      return false
    }
  }

  /** Check out a PR's branch: tracking branch for same-repo/known-fork PRs, otherwise pr/<number>. */
  checkoutPullRequest(number: number, headRef: string, headRepo: string | null, policy: DirtyPolicy = 'carry'): Promise<SwitchResult> {
    return this.#switching(`#${number}`, policy, () => this.#checkoutPr(number, headRef, headRepo))
  }

  async #checkoutPr(number: number, headRef: string, headRepo: string | null): Promise<string> {
    const info = await github.getGitHubInfo(this.path)
    if (!info) throw new Error('This repository has no GitHub remote.')
    const remoteFor = (repo: string) => Object.keys(info.remotes).find((r) => info.remotes[r].toLowerCase() === repo.toLowerCase())
    const headRemote = headRepo ? remoteFor(headRepo) : undefined

    if (headRemote) {
      await this.#git(['fetch', headRemote, `+refs/heads/${headRef}:refs/remotes/${headRemote}/${headRef}`])
      if (await this.#branchExists(headRef)) {
        await this.#git(['checkout', '-q', headRef, '--'])
        await this.#git(['merge', '--ff-only', '-q', `${headRemote}/${headRef}`]).catch(() => undefined)
      } else {
        await this.#git(['checkout', '-q', '-b', headRef, '--track', `${headRemote}/${headRef}`, '--'])
      }
      return headRef
    }

    const baseRemote = remoteFor(info.repo)
    if (!baseRemote) throw new Error(`No remote points at ${info.repo}.`)
    const branch = `pr/${number}`
    await this.#git(['fetch', baseRemote, `refs/pull/${number}/head`])
    if (await this.#branchExists(branch)) {
      await this.#git(['checkout', '-q', branch, '--'])
      await this.#git(['merge', '--ff-only', '-q', 'FETCH_HEAD']).catch(() => undefined)
    } else {
      await this.#git(['checkout', '-q', '-b', branch, 'FETCH_HEAD', '--'])
    }
    return branch
  }
}

/** Names of methods the renderer may call over IPC. */

export const REPO_METHODS = new Set(
  Object.getOwnPropertyNames(Repository.prototype).filter((n) => n !== 'constructor')
)
