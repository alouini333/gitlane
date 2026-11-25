// User-facing git actions: confirmation dialogs, prompts and follow-up handling.
import type { ApplyMode, Commit, DirtyPolicy, FileChange, PullMode, Ref, ResetMode, Stash, SwitchResult, SwitchTarget } from '../../shared/types'
import { buildPatch, type PatchSelection } from '../../shared/patch'
import { app, repoApi } from './api'
import { updateSettings, useSettings, type RemoteDoubleClick } from './settings'
import { ask, confirm, loadGitHub, openRepo, resetDraft, run, toast, useStore } from './store'
import { errorMessage, plural, shortSha } from './util'

const state = () => useStore.getState()
const snap = () => state().snap!
const currentBranch = () => snap().status.branch
const headLabel = () => currentBranch() ?? 'HEAD'

/** Branch name of a remote-tracking ref without the remote prefix. */
export const remoteBranchName = (ref: Ref) => ref.short.slice((ref.remote?.length ?? 0) + 1)

function splitUpstream(upstream: string): { remote: string; branch: string } | null {
  const remote = snap()
    .remotes.filter((r) => upstream.startsWith(r + '/'))
    .sort((a, b) => b.length - a.length)[0]
  return remote ? { remote, branch: upstream.slice(remote.length + 1) } : null
}

// ------------------------------------------------------------------ repositories

export async function openRepoDialog() {
  const dir = await app.pickDirectory('Open a Git repository')
  if (dir) await openRepo(dir)
}

export async function initRepoDialog() {
  const dir = await app.pickDirectory('Choose a folder for the new repository')
  if (!dir) return
  try {
    await openRepo(await app.initRepo(dir))
  } catch (e) {
    toast('error', errorMessage(e))
  }
}

export async function cloneRepoDialog() {
  const res = await ask({
    title: 'Clone a repository',
    fields: [{ key: 'url', label: 'Repository URL', placeholder: 'https://github.com/user/repo.git or git@host:user/repo.git' }],
    message: 'You will choose the parent folder next.',
    confirmLabel: 'Choose folder…'
  })
  const url = res?.values.url.trim()
  if (!url) return
  const dir = await app.pickDirectory('Clone into folder')
  if (!dir) return
  useStore.setState({ busy: 'Cloning…' })
  try {
    const path = await app.cloneRepo(url, dir)
    await openRepo(path)
    toast('success', 'Repository cloned')
  } catch (e) {
    toast('error', errorMessage(e))
  } finally {
    useStore.setState({ busy: null })
  }
}

// ------------------------------------------------------------------ branches

const POLICY_CHOICES: { policy: DirtyPolicy; label: string }[] = [
  { policy: 'stash', label: 'Stash them (find them later under Stashes)' },
  { policy: 'stash-reapply', label: 'Stash them, then re-apply on the new branch' },
  { policy: 'carry', label: 'Carry them over (Git default)' }
]

/** How to treat uncommitted changes for this switch, per Preferences (asking if set to "Ask"). Null = cancelled. */
export async function dirtyPolicy(target: string): Promise<DirtyPolicy | null> {
  const status = snap().status
  const changed = new Set([...status.staged, ...status.unstaged].map((f) => f.path)).size
  const setting = useSettings.getState().dirtySwitch
  if (setting !== 'ask') return setting
  if (changed === 0) return 'carry'
  const res = await ask({
    title: 'You have uncommitted changes',
    message: `${plural(changed, 'file')} changed. What should happen to them when switching to ${target}?`,
    fields: [{ key: 'policy', label: 'Your changes', options: POLICY_CHOICES.map((c) => c.label) }],
    checkbox: { label: 'Remember my choice (change it later in Preferences)', initial: false },
    confirmLabel: 'Switch'
  })
  if (!res) return null
  const policy = POLICY_CHOICES.find((c) => c.label === res.values.policy)?.policy ?? 'stash'
  if (res.checked) updateSettings({ dirtySwitch: policy })
  return policy
}

/** Tell the user where their uncommitted changes went. */
export function reportSwitch(result: SwitchResult, target: string) {
  if (!result.stashed) return
  if (result.reapplied) toast('info', `Your uncommitted changes were stashed and re-applied on ${target}.`)
  else if (result.reapplyConflict)
    toast('error', `Switched to ${target}, but your changes conflict with it. Resolve the conflicts; a copy stays under Stashes ("${result.stashMessage}").`)
  else toast('success', `Your uncommitted changes were stashed before switching to ${target}. Find them under Stashes.`)
}

async function switchBranch(target: SwitchTarget, label: string, progress: string): Promise<boolean> {
  const policy = await dirtyPolicy(label)
  if (!policy) return false
  const out: { result?: SwitchResult } = {}
  const ok = await run(progress, async (api) => {
    out.result = await api.switchTo(target, policy)
  })
  if (ok && out.result) reportSwitch(out.result, label)
  return ok
}

export async function checkoutRef(ref: Ref) {
  if (ref.type === 'head') {
    if (!ref.current) await switchBranch({ kind: 'branch', branch: ref.short }, ref.short, `Checking out ${ref.short}`)
  } else if (ref.type === 'remote') {
    await checkoutRemote(ref, useSettings.getState().remoteDoubleClick)
  } else {
    await switchBranch({ kind: 'detach', rev: ref.name }, ref.short, `Checking out ${ref.short}`)
  }
}

/** Reset the local branch to this remote branch and check it out, whatever the double-click preference. */
export const resetLocalToRemote = (ref: Ref) => checkoutRemote(ref, 'reset')

/**
 * Double-click on origin/dev: create dev if missing; otherwise check it out and, depending on the
 * preference, move it to origin/dev (asking first if that would drop commits only dev has).
 */
async function checkoutRemote(ref: Ref, mode: RemoteDoubleClick) {
  const local = remoteBranchName(ref)
  const existing = snap().refs.find((r) => r.type === 'head' && r.short === local)
  if (!existing) {
    await switchBranch({ kind: 'track', branch: local, remoteRef: ref.short }, local, `Checking out ${local}`)
    return
  }
  const justCheckout = () =>
    existing.current ? Promise.resolve(true) : switchBranch({ kind: 'branch', branch: local }, local, `Checking out ${local}`)
  if (existing.sha === ref.sha || mode === 'checkout') {
    await justCheckout()
    return
  }

  let localOnly = 0
  try {
    localOnly = (await repoApi(state().repoPath!).compareRefs(existing.name, ref.name)).left
  } catch (e) {
    toast('error', errorMessage(e))
    return
  }
  if (localOnly > 0) {
    const commits = plural(localOnly, 'commit')
    if (mode === 'ff') {
      if (await justCheckout()) toast('info', `${local} has ${commits} not on ${ref.short}, so it was checked out without resetting.`)
      return
    }
    const ok = await confirm({
      title: `Reset ${local} to ${ref.short}?`,
      message: `${local} has ${commits} that ${localOnly === 1 ? "isn't" : "aren't"} on ${ref.short}. Resetting removes ${
        localOnly === 1 ? 'it' : 'them'
      } from the branch (still recoverable from the reflog).`,
      confirmLabel: `Reset ${local}`,
      danger: true
    })
    if (!ok) return
  }
  await switchBranch({ kind: 'reset', branch: local, startPoint: ref.short }, local, `Resetting ${local} to ${ref.short}`)
}

export async function checkoutCommit(sha: string) {
  await switchBranch({ kind: 'detach', rev: sha }, shortSha(sha), `Checking out ${shortSha(sha)}`)
}

export async function createBranchAt(startPoint: string, description = shortSha(startPoint)) {
  const res = await ask({
    title: 'Create branch',
    message: `New branch starting at ${description}`,
    fields: [{ key: 'name', label: 'Branch name', placeholder: 'feature/my-change' }],
    checkbox: { label: 'Check out the new branch', initial: true },
    confirmLabel: 'Create branch'
  })
  const name = res?.values.name.trim().replace(/\s+/g, '-')
  if (!res || !name) return
  await run(`Creating ${name}`, (api) => api.createBranch(name, startPoint, res.checked))
}

export async function renameBranch(ref: Ref) {
  const res = await ask({
    title: `Rename ${ref.short}`,
    fields: [{ key: 'name', label: 'New name', initial: ref.short }],
    confirmLabel: 'Rename'
  })
  const name = res?.values.name.trim()
  if (!name || name === ref.short) return
  await run(`Renaming ${ref.short}`, (api) => api.renameBranch(ref.short, name))
}

export async function deleteBranch(ref: Ref) {
  const ok = await confirm({
    title: `Delete branch ${ref.short}?`,
    message: 'The local branch will be deleted. Its commits stay reachable from other refs or the reflog.',
    confirmLabel: 'Delete',
    danger: true
  })
  if (!ok) return
  await run(`Deleting ${ref.short}`, (api) => api.deleteBranch(ref.short, false), {
    onError: async (message) => {
      if (!/not fully merged/i.test(message)) return false
      const force = await confirm({
        title: `${ref.short} is not fully merged`,
        message: 'Deleting it may lose commits that are not on any other branch. Delete anyway?',
        confirmLabel: 'Force delete',
        danger: true
      })
      if (force) await run(`Deleting ${ref.short}`, (api) => api.deleteBranch(ref.short, true))
      return true
    }
  })
}

export async function deleteRemoteBranch(ref: Ref) {
  const branch = remoteBranchName(ref)
  const ok = await confirm({
    title: `Delete ${ref.short} from ${ref.remote}?`,
    message: 'This deletes the branch on the remote server for everyone.',
    confirmLabel: 'Delete remote branch',
    danger: true
  })
  if (ok) await run(`Deleting ${ref.short}`, (api) => api.deleteRemoteBranch(ref.remote!, branch))
}

export async function mergeIntoCurrent(name: string) {
  await run(`Merging ${name} into ${headLabel()}`, (api) => api.merge(name, false))
}

export async function rebaseCurrentOnto(name: string) {
  const ok = await confirm({
    title: `Rebase ${headLabel()} onto ${name}?`,
    message: `Commits on ${headLabel()} will be rewritten on top of ${name}.`,
    confirmLabel: 'Rebase'
  })
  if (ok) await run(`Rebasing onto ${name}`, (api) => api.rebase(name))
}

// ------------------------------------------------------------------ commits

export async function cherryPick(commit: Commit) {
  await run(`Cherry-picking ${shortSha(commit.sha)}`, (api) => api.cherryPick(commit.sha))
}

export async function revertCommit(commit: Commit) {
  await run(`Reverting ${shortSha(commit.sha)}`, (api) => api.revert(commit.sha))
}

export async function resetTo(commit: Commit, mode: ResetMode) {
  if (mode === 'hard') {
    const ok = await confirm({
      title: `Hard reset ${headLabel()} to ${shortSha(commit.sha)}?`,
      message: 'All uncommitted changes will be discarded. This cannot be undone.',
      confirmLabel: 'Reset hard',
      danger: true
    })
    if (!ok) return
  }
  await run(`Resetting to ${shortSha(commit.sha)}`, (api) => api.reset(commit.sha, mode))
}

export async function createTag(sha: string, annotated: boolean) {
  const res = await ask({
    title: annotated ? 'Create annotated tag' : 'Create tag',
    message: `Tag commit ${shortSha(sha)}`,
    fields: [
      { key: 'name', label: 'Tag name', placeholder: 'v1.0.0' },
      ...(annotated ? [{ key: 'message', label: 'Message', multiline: true }] : [])
    ],
    confirmLabel: 'Create tag'
  })
  const name = res?.values.name.trim()
  if (!res || !name) return
  await run(`Tagging ${name}`, (api) => api.createTag(name, sha, annotated ? res.values.message || name : undefined))
}

export async function deleteTag(ref: Ref) {
  const ok = await confirm({ title: `Delete tag ${ref.short}?`, confirmLabel: 'Delete', danger: true })
  if (ok) await run(`Deleting tag ${ref.short}`, (api) => api.deleteTag(ref.short))
}

async function pickRemote(title: string): Promise<string | null> {
  const remotes = snap().remotes
  if (remotes.length === 0) {
    toast('error', 'This repository has no remotes')
    return null
  }
  if (remotes.length === 1) return remotes[0]
  const res = await ask({
    title,
    fields: [{ key: 'remote', label: 'Remote', options: remotes, initial: remotes.includes('origin') ? 'origin' : remotes[0] }],
    confirmLabel: 'Continue'
  })
  return res?.values.remote ?? null
}

export async function pushTag(ref: Ref) {
  const remote = await pickRemote(`Push tag ${ref.short}`)
  if (remote) await run(`Pushing tag ${ref.short}`, (api) => api.pushTag(remote, ref.short), { success: `Pushed ${ref.short} to ${remote}` })
}

export async function deleteRemoteTag(ref: Ref) {
  const remote = await pickRemote(`Delete tag ${ref.short} from remote`)
  if (!remote) return
  const ok = await confirm({ title: `Delete tag ${ref.short} from ${remote}?`, confirmLabel: 'Delete', danger: true })
  if (ok) await run(`Deleting remote tag ${ref.short}`, (api) => api.deleteRemoteTag(remote, ref.short))
}

// ------------------------------------------------------------------ stash

export async function stashChanges() {
  const status = snap().status
  if (status.staged.length + status.unstaged.length === 0) {
    toast('info', 'Nothing to stash')
    return
  }
  const message = state().draft.summary.trim()
  await run('Stashing changes', (api) => api.stashSave(message, true))
}

export async function popStash(stash?: Stash) {
  const target = stash ?? snap().stashes[0]
  if (!target) {
    toast('info', 'No stashes')
    return
  }
  await run('Popping stash', (api) => api.stashPop(target.index))
}

export async function applyStash(stash: Stash) {
  await run('Applying stash', (api) => api.stashApply(stash.index))
}

export async function dropStash(stash: Stash) {
  const ok = await confirm({ title: 'Delete stash?', message: stash.message, confirmLabel: 'Delete', danger: true })
  if (ok) await run('Deleting stash', (api) => api.stashDrop(stash.index))
}

// ------------------------------------------------------------------ remotes

export async function fetchAll() {
  const ok = await run('Fetching', (api) => api.fetch())
  if (ok) void loadGitHub(true)
}

export async function pull(mode: PullMode = 'merge') {
  if (!snap().status.upstream) {
    toast('error', `${headLabel()} has no upstream branch to pull from. Push it first or set an upstream.`)
    return
  }
  const ok = await run('Pulling', (api) => api.pull(mode))
  if (ok) void loadGitHub(true)
}

export async function pushCurrent(force = false) {
  const branch = currentBranch()
  if (!branch) {
    toast('error', 'HEAD is detached. Create a branch to push your commits.')
    return
  }
  await pushBranch(branch, force)
}

export async function pushBranch(branch: string, force = false) {
  const ref = snap().refs.find((r) => r.type === 'head' && r.short === branch)
  let target = ref?.upstream ? splitUpstream(ref.upstream) : null
  let setUpstream = false
  if (!target) {
    const remotes = snap().remotes
    if (remotes.length === 0) {
      toast('error', 'This repository has no remotes')
      return
    }
    const res = await ask({
      title: `Push ${branch}`,
      message: `${branch} has no upstream yet. Choose where to push it; it will be tracked from now on.`,
      fields: [
        { key: 'remote', label: 'Remote', options: remotes, initial: remotes.includes('origin') ? 'origin' : remotes[0] },
        { key: 'branch', label: 'Remote branch', initial: branch }
      ],
      confirmLabel: 'Push'
    })
    if (!res || !res.values.branch.trim()) return
    target = { remote: res.values.remote, branch: res.values.branch.trim() }
    setUpstream = true
  }
  const { remote, branch: remoteBranch } = target
  const pushed = await run(
    force ? `Force pushing ${branch}` : `Pushing ${branch}`,
    (api) => api.push(branch, { remote, remoteBranch, setUpstream, force }),
    {
      success: `Pushed ${branch} to ${remote}/${remoteBranch}`,
      onError: async (message) => {
        if (force || !/\[rejected\]|non-fast-forward|fetch first/i.test(message)) return false
        const ok = await confirm({
          title: 'Push rejected',
          message: `${remote}/${remoteBranch} has commits that ${branch} doesn't have. Pull first, or force push (with lease) to overwrite the remote branch.`,
          confirmLabel: 'Force push',
          danger: true
        })
        if (ok) await pushBranch(branch, true)
        return true
      }
    }
  )
  if (pushed) void loadGitHub(true)
}

// ------------------------------------------------------------------ working tree

export async function stageFiles(files: FileChange[]) {
  await run('Staging', (api) => api.stage(files.map((f) => f.path)))
}

export async function unstageFiles(files: FileChange[]) {
  await run('Unstaging', (api) => api.unstage(files.map((f) => f.path)))
}

export async function stageAll() {
  await run('Staging all', (api) => api.stageAll())
}

export async function unstageAll() {
  await run('Unstaging all', (api) => api.unstageAll())
}

export async function discardFiles(files: FileChange[]) {
  const ok = await confirm({
    title: files.length === 1 ? `Discard changes to ${files[0].path}?` : `Discard changes to ${plural(files.length, 'file')}?`,
    message: 'Unstaged changes will be lost; untracked files will be deleted. This cannot be undone.',
    confirmLabel: 'Discard',
    danger: true
  })
  if (ok) await run('Discarding', (api) => api.discard(files))
}

export async function discardAll() {
  const ok = await confirm({
    title: 'Discard all changes?',
    message: 'All staged and unstaged changes will be reset and untracked files deleted. This cannot be undone.',
    confirmLabel: 'Discard all',
    danger: true
  })
  if (ok) await run('Discarding all changes', (api) => api.discardAll())
}

export async function applySelection(selection: PatchSelection, mode: ApplyMode) {
  const diff = state().diff?.data
  if (!diff) return
  const patch = buildPatch(diff, selection, mode !== 'stage')
  if (!patch) return
  if (mode === 'discard') {
    const ok = await confirm({ title: 'Discard these changes?', message: 'This cannot be undone.', confirmLabel: 'Discard', danger: true })
    if (!ok) return
  }
  const label = mode === 'stage' ? 'Staging' : mode === 'unstage' ? 'Unstaging' : 'Discarding'
  await run(label, (api) => api.applyPatch(patch, mode))
}

export async function resolveConflict(files: FileChange[], side: 'ours' | 'theirs') {
  await run(`Taking ${side}`, (api) => api.resolveWith(files.map((f) => f.path), side))
}

export async function ignorePath(path: string) {
  const ext = /\.[^./]+$/.exec(path)?.[0]
  const options = [`/${path}`, ...(ext ? [`*${ext}`] : []), ...(path.includes('/') ? [`/${path.slice(0, path.lastIndexOf('/'))}/`] : [])]
  const res = await ask({
    title: 'Add to .gitignore',
    fields: [{ key: 'pattern', label: 'Pattern', options, initial: options[0] }],
    confirmLabel: 'Ignore'
  })
  if (res) await run('Updating .gitignore', (api) => api.ignore(res.values.pattern))
}

export async function commitChanges() {
  const { draft } = state()
  const summary = draft.summary.trim()
  if (!summary) return
  const message = [summary, draft.description.trim()].filter(Boolean).join('\n\n')
  const ok = await run(draft.amend ? 'Amending commit' : 'Committing', (api) => api.commit(message, draft.amend))
  if (ok) resetDraft()
}

// ------------------------------------------------------------------ merge / rebase in progress

export async function continueOperation() {
  const ok = await run('Continuing', (api) => api.continueOperation())
  if (ok) resetDraft()
}

export async function abortOperation() {
  const op = snap().status.operation
  const ok = await confirm({
    title: `Abort ${op}?`,
    message: `The ${op} will be cancelled and your branch returned to its previous state.`,
    confirmLabel: `Abort ${op}`,
    danger: true
  })
  if (ok) {
    await run(`Aborting ${op}`, (api) => api.abortOperation())
    resetDraft()
  }
}

export async function skipRebaseCommit() {
  await run('Skipping commit', (api) => api.skipRebaseCommit())
}

// ------------------------------------------------------------------ misc

export async function copy(text: string, what = 'Copied') {
  await app.copyText(text)
  toast('info', `${what} to clipboard`)
}

export function openInTerminal() {
  const path = state().repoPath
  if (path) void app.openTerminal(path)
}

export function openFile(relPath: string) {
  const root = state().repoPath
  if (root) app.openPath(`${root}/${relPath}`).catch((e) => toast('error', errorMessage(e)))
}

export function openUrl(url: string) {
  app.openExternal(url).catch((e) => toast('error', errorMessage(e)))
}

export function revealFile(relPath: string) {
  const root = state().repoPath
  if (root) void app.revealPath(`${root}/${relPath}`)
}
