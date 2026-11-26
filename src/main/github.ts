// GitHub pull-request lookups for repositories whose remotes live on GitHub (or GitHub Enterprise).
//
// Auth, in order: GH_TOKEN / GITHUB_TOKEN env vars, then the GitHub CLI (`gh auth token`).
// Without a token, public repositories still work within GitHub's anonymous rate limit.
import { execFile } from 'node:child_process'
import type { CommitPullRequests, GitHubInfo, PullRequest } from '../shared/types'
import { childEnv, runGit } from './git/runner'

type FetchFn = (url: string, init: RequestInit) => Promise<Response>

let fetchImpl: FetchFn = (url, init) => fetch(url, init)

/** The main process swaps in Electron's net.fetch so system proxy settings apply. */
export function setFetch(fn: FetchFn) {
  fetchImpl = fn
}

// ------------------------------------------------------------------ remotes

export interface RemoteRepo {
  host: string
  owner: string
  name: string
}

/** Parse a GitHub remote URL (https, ssh://, scp-like git@host:owner/repo). */
export function parseGitHubRemote(url: string): RemoteRepo | null {
  const s = url.trim()
  const m = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/.exec(s) ?? /^(?:[^@/]+@)?([^/:]+):(?!\/)(.+)$/.exec(s)
  if (!m) return null
  let host = m[1].toLowerCase()
  const parts = m[2]
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .split('/')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null
  if (host === 'ssh.github.com' || host === 'www.github.com') host = 'github.com'
  // SSH config aliases such as "github-work" point at github.com.
  else if (!host.includes('.') && host.includes('github')) host = 'github.com'
  if (!host.includes('github')) return null
  return { host, owner: parts[0], name: parts[1] }
}

const apiBase = (host: string) => (host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`)
export const repoPath = (fullName: string) => fullName.split('/').map(encodeURIComponent).join('/')

// ------------------------------------------------------------------ auth & requests

const tokens = new Map<string, { value: string | null; expires: number }>()

export async function tokenFor(host: string): Promise<string | null> {
  const envToken =
    host === 'github.com'
      ? process.env.GH_TOKEN || process.env.GITHUB_TOKEN
      : process.env.GH_ENTERPRISE_TOKEN || process.env.GITHUB_ENTERPRISE_TOKEN
  if (envToken) return envToken
  const cached = tokens.get(host)
  if (cached && cached.expires > Date.now()) return cached.value
  const ghToken = (file: string, args: string[]) =>
    new Promise<string | null>((resolve) => {
      execFile(file, args, { env: { ...childEnv(), WSL_UTF8: '1' }, timeout: 5000, windowsHide: true }, (err, stdout) =>
        resolve(err ? null : stdout.trim() || null)
      )
    })
  let value = await ghToken('gh', ['auth', 'token', '--hostname', host])
  // On Windows, people who work in WSL often have the GitHub CLI signed in only there.
  if (!value && process.platform === 'win32' && /^[\w.-]+$/.test(host)) {
    value = await ghToken('wsl.exe', ['--exec', 'sh', '-lc', 'gh auth token --hostname "$1"', 'sh', host])
  }
  tokens.set(host, { value, expires: Date.now() + (value ? 10 * 60_000 : 30_000) })
  return value
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly apiMessage: string
  ) {
    super(message)
    this.name = 'GitHubError'
  }
}

const SIGN_IN_HINT = 'Sign in with the GitHub CLI ("gh auth login") or set GITHUB_TOKEN.'

interface RequestOptions {
  method?: string
  body?: unknown
  /** Return the response body as text instead of JSON. */
  raw?: boolean
}

function headersFor(token: string | null, json: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Gitlane'
  }
  if (token) headers.Authorization = `Bearer ${token}`
  if (json) headers['Content-Type'] = 'application/json'
  return headers
}

async function send(host: string, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(20_000) })
  } catch (e) {
    throw new GitHubError(`Could not reach ${host}: ${e instanceof Error ? e.message : String(e)}`, 0, '')
  }
}

/** Turn a failed response into an actionable error. */
async function toError(res: Response, host: string, hasToken: boolean): Promise<GitHubError> {
  let apiMessage = ''
  let details = ''
  try {
    const json = (await res.json()) as { message?: string; errors?: ({ message?: string } | string)[] }
    apiMessage = json.message ?? ''
    details = (json.errors ?? [])
      .map((e) => (typeof e === 'string' ? e : (e.message ?? '')))
      .filter(Boolean)
      .join('\n')
  } catch {
    /* not JSON */
  }
  if (res.status === 401) {
    tokens.delete(host)
    return new GitHubError(`GitHub rejected the stored credentials for ${host}. Run "gh auth login" to sign in again.`, 401, apiMessage)
  }
  if ((res.status === 403 || res.status === 429) && (res.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(apiMessage))) {
    return new GitHubError(
      hasToken ? 'GitHub API rate limit reached. Try again in a few minutes.' : `GitHub's anonymous rate limit was reached. ${SIGN_IN_HINT}`,
      res.status,
      apiMessage
    )
  }
  if (res.status === 403 && /SAML|SSO/i.test(apiMessage)) {
    return new GitHubError('Your GitHub token is not authorized for this organization (SSO). Run "gh auth refresh" and authorize it.', 403, apiMessage)
  }
  if (res.status === 404 && !/no commit found/i.test(apiMessage)) {
    return new GitHubError(
      hasToken ? `Not found on ${host}, or your account has no access to it.` : `Repository not found on ${host}. If it is private: ${SIGN_IN_HINT}`,
      404,
      apiMessage
    )
  }
  const message = [apiMessage, details].filter(Boolean).join(': ') || `GitHub request failed (HTTP ${res.status})`
  return new GitHubError(message, res.status, apiMessage)
}

/** GitHub REST call. */
export async function request<T>(host: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const token = await tokenFor(host)
  const res = await send(host, apiBase(host) + path, {
    method: opts.method ?? 'GET',
    headers: headersFor(token, opts.body !== undefined),
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  })
  if (!res.ok) throw await toError(res, host, !!token)
  if (res.status === 204) return undefined as T
  return (opts.raw ? await res.text() : await res.json()) as T
}

/** GitHub GraphQL call (requires a token). */
export async function graphql<T>(host: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const token = await tokenFor(host)
  if (!token) throw new GitHubError(`Sign in to GitHub to work with pull requests. ${SIGN_IN_HINT}`, 401, '')
  const url = host === 'github.com' ? 'https://api.github.com/graphql' : `https://${host}/api/graphql`
  const res = await send(host, url, { method: 'POST', headers: headersFor(token, true), body: JSON.stringify({ query, variables }) })
  if (!res.ok) throw await toError(res, host, true)
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] }
  if (json.errors?.length) {
    throw new GitHubError(json.errors.map((e) => e.message).join('\n'), 200, json.errors[0].message)
  }
  return json.data as T
}

// ------------------------------------------------------------------ mapping

export interface RawPull {
  number: number
  title: string
  state: string
  draft?: boolean
  merged_at?: string | null
  html_url: string
  user?: { login: string } | null
  head?: { ref: string; repo?: { full_name: string } | null }
  base?: { ref: string }
  updated_at: string
}

export function toPullRequest(raw: RawPull): PullRequest {
  return {
    number: raw.number,
    title: raw.title,
    state: raw.merged_at ? 'merged' : raw.state === 'open' ? 'open' : 'closed',
    draft: !!raw.draft,
    url: raw.html_url,
    author: raw.user?.login ?? '',
    headRef: raw.head?.ref ?? '',
    headRepo: raw.head?.repo?.full_name ?? null,
    baseRef: raw.base?.ref ?? '',
    updatedAt: raw.updated_at
  }
}

// ------------------------------------------------------------------ queries (cached)

interface Cached<T> {
  value: T
  expires: number
}

const infoCache = new Map<string, Cached<GitHubInfo | null>>()
const defaultBranchCache = new Map<string, Cached<string | null>>()
const openCache = new Map<string, Cached<PullRequest[]>>()
const commitCache = new Map<string, Cached<CommitPullRequests>>()

export async function getGitHubInfo(path: string): Promise<GitHubInfo | null> {
  const cached = infoCache.get(path)
  if (cached && cached.expires > Date.now()) return cached.value

  const out = await runGit(path, ['remote', '-v'])
  const remotes: Record<string, string> = {}
  const hosts: Record<string, string> = {}
  for (const line of out.split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line)
    const parsed = m && parseGitHubRemote(m[2])
    if (!m || !parsed) continue
    remotes[m[1]] = `${parsed.owner}/${parsed.name}`
    hosts[m[1]] = parsed.host
  }
  const names = Object.keys(remotes)
  let info: GitHubInfo | null = null
  if (names.length) {
    // Pull requests of a fork are opened against its upstream.
    const primary = names.includes('upstream') ? 'upstream' : names.includes('origin') ? 'origin' : names[0]
    const host = hosts[primary]
    info = {
      host,
      repo: remotes[primary],
      webUrl: `https://${host}/${remotes[primary]}`,
      remotes,
      defaultBranch: await defaultBranchOf(host, remotes[primary]),
      authenticated: !!(await tokenFor(host))
    }
  }
  infoCache.set(path, { value: info, expires: Date.now() + 60_000 })
  return info
}

async function defaultBranchOf(host: string, repo: string): Promise<string | null> {
  const key = `${host}/${repo}`
  const cached = defaultBranchCache.get(key)
  if (cached && cached.expires > Date.now()) return cached.value
  let value: string | null = null
  try {
    value = (await request<{ default_branch?: string }>(host, `/repos/${repoPath(repo)}`)).default_branch ?? null
  } catch {
    /* private repo without access, offline, … — callers fall back to common names */
  }
  defaultBranchCache.set(key, { value, expires: Date.now() + (value ? 30 * 60_000 : 60_000) })
  return value
}

export async function listOpenPullRequests(path: string, force = false): Promise<PullRequest[]> {
  if (force) clearGitHubCache(path)
  const info = await getGitHubInfo(path)
  if (!info) return []
  const key = `${info.host}/${info.repo}`
  const cached = openCache.get(key)
  if (cached && cached.expires > Date.now()) return cached.value

  const prs: PullRequest[] = []
  for (let page = 1; page <= 3; page++) {
    const batch = await request<RawPull[]>(info.host, `/repos/${repoPath(info.repo)}/pulls?state=open&per_page=100&page=${page}`)
    prs.push(...batch.map(toPullRequest))
    if (batch.length < 100) break
  }
  openCache.set(key, { value: prs, expires: Date.now() + 60_000 })
  return prs
}

export async function pullRequestsForCommit(path: string, sha: string): Promise<CommitPullRequests> {
  const info = await getGitHubInfo(path)
  if (!info) return { prs: [] }
  const key = `${info.host}/${info.repo}@${sha}`
  const cached = commitCache.get(key)
  if (cached && cached.expires > Date.now()) return cached.value

  let value: CommitPullRequests
  let ttl = 3 * 60_000
  try {
    const raw = await request<RawPull[]>(info.host, `/repos/${repoPath(info.repo)}/commits/${encodeURIComponent(sha)}/pulls?per_page=50`)
    value = { prs: raw.map(toPullRequest) }
  } catch (e) {
    if (!(e instanceof GitHubError) || !/no commit found/i.test(e.apiMessage)) throw e
    value = { prs: [], notice: `This commit isn't on ${info.host} yet. Push it to see pull requests.` }
    ttl = 30_000
  }
  commitCache.set(key, { value, expires: Date.now() + ttl })
  return value
}

/** Forget cached GitHub data for a repository (after fetch/push, or on manual refresh). */
export function clearGitHubCache(path: string) {
  const info = infoCache.get(path)?.value
  infoCache.delete(path)
  if (!info) return
  const prefix = `${info.host}/${info.repo}`
  openCache.delete(prefix)
  for (const key of commitCache.keys()) if (key.startsWith(prefix + '@')) commitCache.delete(key)
}
