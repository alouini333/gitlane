// Context menu definitions for commits, refs, stashes and files.
import type { Commit, FileChange, Ref, Stash } from '../../shared/types'
import * as A from './actions'
import { prForRef } from './github'
import { canCreatePr, checkoutPr, createPullRequestDialog } from './prActions'
import { openDiff, openPr, type MenuItem, useStore } from './store'
import { useSettings } from './settings'
import { shortSha } from './util'

const sep: MenuItem = { separator: true }
const status = () => useStore.getState().snap!.status
const head = () => status().branch ?? 'HEAD'

export function commitMenu(commit: Commit): MenuItem[] {
  const isHead = commit.sha === status().head
  const s = shortSha(commit.sha)
  return [
    { label: `Checkout ${s} (detached)`, action: () => A.checkoutCommit(commit.sha), disabled: isHead },
    { label: 'Create branch here…', action: () => A.createBranchAt(commit.sha) },
    { label: 'Create tag here…', action: () => A.createTag(commit.sha, false) },
    { label: 'Create annotated tag here…', action: () => A.createTag(commit.sha, true) },
    sep,
    { label: `Cherry-pick ${s} onto ${head()}`, action: () => A.cherryPick(commit), disabled: isHead },
    { label: `Revert ${s}`, action: () => A.revertCommit(commit) },
    { label: `Merge ${s} into ${head()}`, action: () => A.mergeIntoCurrent(commit.sha), disabled: isHead },
    { label: `Rebase ${head()} onto ${s}`, action: () => A.rebaseCurrentOnto(commit.sha), disabled: isHead },
    sep,
    { label: `Reset ${head()} to here — soft`, action: () => A.resetTo(commit, 'soft') },
    { label: `Reset ${head()} to here — mixed`, action: () => A.resetTo(commit, 'mixed') },
    { label: `Reset ${head()} to here — hard`, action: () => A.resetTo(commit, 'hard'), danger: true },
    sep,
    { label: 'Copy commit SHA', action: () => A.copy(commit.sha, 'SHA copied') },
    { label: 'Copy commit message', action: () => A.copy(commit.subject, 'Message copied') }
  ]
}

/** "Open pull request #N" or "Create pull request" for branches on a GitHub remote. */
function pullRequestItems(ref: Ref): MenuItem[] {
  const { snap, github } = useStore.getState()
  if (!snap || !github?.info) return []
  const pr = prForRef(ref, snap.refs, snap.remotes, github)
  if (pr)
    return [
      sep,
      { label: `Open pull request #${pr.number}`, action: () => openPr(pr.number) },
      { label: `Review files of #${pr.number}`, action: () => openPr(pr.number, 'files') },
      { label: `Open #${pr.number} on GitHub`, action: () => A.openUrl(pr.url) },
      { label: `Check out #${pr.number}`, action: () => checkoutPr(pr), disabled: ref.current }
    ]
  return canCreatePr(ref) ? [sep, { label: 'Create pull request…', action: () => createPullRequestDialog(ref) }] : []
}

export function refMenu(ref: Ref): MenuItem[] {
  const current = head()
  if (ref.type === 'head') {
    const upstream = ref.upstream ? useStore.getState().snap?.refs.find((r) => r.type === 'remote' && r.short === ref.upstream) : undefined
    return [
      { label: `Checkout ${ref.short}`, action: () => A.checkoutRef(ref), disabled: ref.current },
      ...(upstream && upstream.sha !== ref.sha
        ? [{ label: `Reset ${ref.short} to ${upstream.short}`, action: () => A.resetLocalToRemote(upstream), danger: true }]
        : []),
      sep,
      { label: `Merge ${ref.short} into ${current}`, action: () => A.mergeIntoCurrent(ref.short), disabled: ref.current },
      { label: `Rebase ${current} onto ${ref.short}`, action: () => A.rebaseCurrentOnto(ref.short), disabled: ref.current },
      sep,
      { label: `Push ${ref.short}`, action: () => A.pushBranch(ref.short) },
      { label: `Force push ${ref.short} (with lease)`, action: () => A.pushBranch(ref.short, true), danger: true },
      ...pullRequestItems(ref),
      sep,
      { label: `Create branch from ${ref.short}…`, action: () => A.createBranchAt(ref.short, ref.short) },
      { label: `Rename ${ref.short}…`, action: () => A.renameBranch(ref) },
      { label: `Delete ${ref.short}`, action: () => A.deleteBranch(ref), danger: true, disabled: ref.current },
      sep,
      { label: 'Copy branch name', action: () => A.copy(ref.short, 'Branch name copied') }
    ]
  }
  if (ref.type === 'remote') {
    const local = A.remoteBranchName(ref)
    const existing = useStore.getState().snap?.refs.find((r) => r.type === 'head' && r.short === local)
    const differs = !!existing && existing.sha !== ref.sha
    const resets = differs && useSettings.getState().remoteDoubleClick === 'reset'
    return [
      { label: resets ? `Check out ${local} (reset to ${ref.short})` : `Check out ${local}`, action: () => A.checkoutRef(ref) },
      ...(differs && !resets ? [{ label: `Reset ${local} to ${ref.short}`, action: () => A.resetLocalToRemote(ref), danger: true }] : []),
      sep,
      { label: `Merge ${ref.short} into ${current}`, action: () => A.mergeIntoCurrent(ref.short) },
      { label: `Rebase ${current} onto ${ref.short}`, action: () => A.rebaseCurrentOnto(ref.short) },
      ...pullRequestItems(ref),
      sep,
      { label: `Create branch from ${ref.short}…`, action: () => A.createBranchAt(ref.short, ref.short) },
      { label: `Delete ${ref.short} from remote`, action: () => A.deleteRemoteBranch(ref), danger: true },
      sep,
      { label: 'Copy branch name', action: () => A.copy(ref.short, 'Branch name copied') }
    ]
  }
  return [
    { label: `Checkout tag ${ref.short} (detached)`, action: () => A.checkoutRef(ref) },
    { label: `Create branch from ${ref.short}…`, action: () => A.createBranchAt(ref.name, ref.short) },
    sep,
    { label: `Push ${ref.short} to remote`, action: () => A.pushTag(ref) },
    { label: `Delete ${ref.short}`, action: () => A.deleteTag(ref), danger: true },
    { label: `Delete ${ref.short} from remote`, action: () => A.deleteRemoteTag(ref), danger: true },
    sep,
    { label: 'Copy tag name', action: () => A.copy(ref.short, 'Tag name copied') }
  ]
}

export function stashMenu(stash: Stash): MenuItem[] {
  return [
    { label: 'Apply stash', action: () => A.applyStash(stash) },
    { label: 'Pop stash', action: () => A.popStash(stash) },
    { label: 'Delete stash', action: () => A.dropStash(stash), danger: true },
    sep,
    { label: 'Create branch from stash base…', action: () => A.createBranchAt(stash.parents[0] ?? stash.sha) }
  ]
}

export type WipFileKind = 'unstaged' | 'staged' | 'conflicted'

export function wipFileMenu(file: FileChange, kind: WipFileKind): MenuItem[] {
  const common: MenuItem[] = [
    sep,
    { label: 'Open file', action: () => A.openFile(file.path), disabled: file.status === 'D' },
    { label: 'Reveal in Finder', action: () => A.revealFile(file.path), disabled: file.status === 'D' },
    { label: 'Copy file path', action: () => A.copy(file.path, 'Path copied') }
  ]
  if (kind === 'conflicted') {
    return [
      { label: 'Show conflict', action: () => openDiff({ kind: 'unstaged', path: file.path, conflicted: true }) },
      { label: 'Mark as resolved (stage)', action: () => A.stageFiles([file]) },
      { label: 'Resolve using ours', action: () => A.resolveConflict([file], 'ours') },
      { label: 'Resolve using theirs', action: () => A.resolveConflict([file], 'theirs') },
      ...common
    ]
  }
  if (kind === 'staged') {
    return [{ label: 'Unstage', action: () => A.unstageFiles([file]) }, ...common]
  }
  return [
    { label: 'Stage', action: () => A.stageFiles([file]) },
    { label: 'Discard changes', action: () => A.discardFiles([file]), danger: true },
    { label: 'Ignore…', action: () => A.ignorePath(file.path) },
    ...common
  ]
}

export function commitFileMenu(file: FileChange): MenuItem[] {
  return [
    { label: 'Open current version', action: () => A.openFile(file.path), disabled: file.status === 'D' },
    { label: 'Reveal in Finder', action: () => A.revealFile(file.path) },
    { label: 'Copy file path', action: () => A.copy(file.path, 'Path copied') }
  ]
}
