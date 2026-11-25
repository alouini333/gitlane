// Pure helpers linking refs to GitHub pull requests (no store or IPC imports, so they're testable).
import type { GitHubInfo, PullRequest, Ref } from '../../shared/types'

export interface GitHubData {
  info: GitHubInfo | null
  openPrs: PullRequest[]
}

export interface RemoteBranch {
  remote: string
  branch: string
}

/** Longest remote name that prefixes `name` ("origin/feature/x" → origin + feature/x). */
function splitRemote(name: string, remotes: string[]): RemoteBranch | null {
  const remote = remotes.filter((r) => name.startsWith(r + '/')).sort((a, b) => b.length - a.length)[0]
  return remote ? { remote, branch: name.slice(remote.length + 1) } : null
}

/**
 * Where a branch lives on a remote: remote refs directly, local branches via their upstream,
 * or via a same-named branch on a GitHub remote (pushed without -u).
 */
export function remoteBranchOf(ref: Ref, refs: Ref[], remotes: string[], gh: GitHubInfo): RemoteBranch | null {
  if (ref.type === 'remote') return splitRemote(ref.short, remotes)
  if (ref.type !== 'head') return null
  if (ref.upstream && !ref.gone) return splitRemote(ref.upstream, remotes)
  const candidates = Object.keys(gh.remotes).sort((a, b) => Number(b === 'origin') - Number(a === 'origin'))
  for (const remote of candidates) {
    if (refs.some((r) => r.type === 'remote' && r.short === `${remote}/${ref.short}`)) return { remote, branch: ref.short }
  }
  return null
}

/** The open pull request whose head is this branch, if any. */
export function prForRef(ref: Ref, refs: Ref[], remotes: string[], data: GitHubData | null): PullRequest | undefined {
  if (!data?.info || !data.openPrs.length) return undefined
  const target = remoteBranchOf(ref, refs, remotes, data.info)
  const repo = target && data.info.remotes[target.remote]
  if (!target || !repo) return undefined
  return data.openPrs.find((pr) => pr.headRef === target.branch && pr.headRepo?.toLowerCase() === repo.toLowerCase())
}

/** Whether this branch is the repository's default branch (PRs merge into it, never from it). */
export function isDefaultBranch(target: RemoteBranch, info: GitHubInfo): boolean {
  if (info.remotes[target.remote]?.toLowerCase() !== info.repo.toLowerCase()) return false
  return info.defaultBranch ? target.branch === info.defaultBranch : /^(main|master|trunk|develop)$/.test(target.branch)
}

/**
 * GitHub's "open a pull request" page for a pushed branch; null if the branch isn't on a
 * GitHub remote or is the default branch.
 */
export function createPrUrl(ref: Ref, refs: Ref[], remotes: string[], info: GitHubInfo): string | null {
  const target = remoteBranchOf(ref, refs, remotes, info)
  const repo = target && info.remotes[target.remote]
  if (!target || !repo || isDefaultBranch(target, info)) return null
  const branch = target.branch.split('/').map(encodeURIComponent).join('/')
  const head = repo.toLowerCase() === info.repo.toLowerCase() ? branch : `${repo.split('/')[0]}:${branch}`
  return `${info.webUrl}/compare/${head}?expand=1`
}

const STATE_ORDER = { open: 0, merged: 1, closed: 2 }

/** Merge PR lists, dropping duplicates; open first, then merged, then closed; newest first. */
export function mergePullRequests(...lists: PullRequest[][]): PullRequest[] {
  const byNumber = new Map<number, PullRequest>()
  for (const pr of lists.flat()) if (!byNumber.has(pr.number)) byNumber.set(pr.number, pr)
  return [...byNumber.values()].sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || b.number - a.number)
}

export function prStateLabel(pr: PullRequest): { key: string; label: string } {
  if (pr.state === 'open') return pr.draft ? { key: 'draft', label: 'Draft' } : { key: 'open', label: 'Open' }
  return pr.state === 'merged' ? { key: 'merged', label: 'Merged' } : { key: 'closed', label: 'Closed' }
}
