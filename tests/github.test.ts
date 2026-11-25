import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  getGitHubInfo,
  listOpenPullRequests,
  parseGitHubRemote,
  pullRequestsForCommit,
  setFetch,
  toPullRequest,
  type RawPull
} from '../src/main/github'
import { runGit } from '../src/main/git/runner'
import { createPrUrl, mergePullRequests, prForRef } from '../src/renderer/src/github'
import type { GitHubInfo, PullRequest, Ref } from '../src/shared/types'

describe('parseGitHubRemote', () => {
  it.each([
    ['https://github.com/acme/widgets.git', { host: 'github.com', owner: 'acme', name: 'widgets' }],
    ['https://github.com/acme/widgets/', { host: 'github.com', owner: 'acme', name: 'widgets' }],
    ['https://user@github.com/acme/widgets', { host: 'github.com', owner: 'acme', name: 'widgets' }],
    ['git@github.com:acme/widgets.git', { host: 'github.com', owner: 'acme', name: 'widgets' }],
    ['ssh://git@ssh.github.com:443/acme/widgets.git', { host: 'github.com', owner: 'acme', name: 'widgets' }],
    ['git@github-work:acme/widgets.git', { host: 'github.com', owner: 'acme', name: 'widgets' }],
    ['https://github.acme.corp/team/app.git', { host: 'github.acme.corp', owner: 'team', name: 'app' }]
  ])('parses %s', (url, expected) => {
    expect(parseGitHubRemote(url)).toEqual(expected)
  })

  it.each(['git@gitlab.com:acme/widgets.git', '/srv/git/widgets.git', '../remote.git', 'https://github.com/acme'])(
    'rejects %s',
    (url) => expect(parseGitHubRemote(url)).toBeNull()
  )
})

const rawPull = (over: Partial<RawPull> = {}): RawPull => ({
  number: 7,
  title: 'Add login',
  state: 'open',
  draft: false,
  merged_at: null,
  html_url: 'https://github.com/acme/widgets/pull/7',
  user: { login: 'grace' },
  head: { ref: 'feature/login', repo: { full_name: 'acme/widgets' } },
  base: { ref: 'main' },
  updated_at: '2026-11-01T00:00:00Z',
  ...over
})

describe('toPullRequest', () => {
  it('maps open, merged and closed pull requests', () => {
    expect(toPullRequest(rawPull())).toMatchObject({ number: 7, state: 'open', headRef: 'feature/login', headRepo: 'acme/widgets', author: 'grace' })
    expect(toPullRequest(rawPull({ state: 'closed', merged_at: '2026-11-02T00:00:00Z' })).state).toBe('merged')
    expect(toPullRequest(rawPull({ state: 'closed' })).state).toBe('closed')
    expect(toPullRequest(rawPull({ head: { ref: 'x', repo: null } })).headRepo).toBeNull()
  })
})

describe('GitHub client (mocked API)', () => {
  let dir: string
  let calls: { url: string; headers: Record<string, string> }[]
  let respond: (url: string) => Response

  beforeAll(async () => {
    process.env.GH_TOKEN = 'test-token'
    dir = mkdtempSync(join(tmpdir(), 'gitlane-gh-'))
    await runGit(dir, ['init', '-q'])
    await runGit(dir, ['remote', 'add', 'origin', 'git@github.com:me/widgets.git'])
    await runGit(dir, ['remote', 'add', 'upstream', 'https://github.com/acme/widgets.git'])
    await runGit(dir, ['remote', 'add', 'mirror', 'https://gitlab.com/acme/widgets.git'])
    setFetch(async (url, init) => {
      calls.push({ url, headers: init.headers as Record<string, string> })
      return respond(url)
    })
  })

  afterAll(() => {
    delete process.env.GH_TOKEN
    rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(() => {
    calls = []
  })

  it('prefers upstream for pull requests and maps every GitHub remote', async () => {
    respond = () => new Response(JSON.stringify({ default_branch: 'develop' }), { status: 200 })
    const info = await getGitHubInfo(dir)
    expect(info).toEqual({
      host: 'github.com',
      repo: 'acme/widgets',
      webUrl: 'https://github.com/acme/widgets',
      remotes: { origin: 'me/widgets', upstream: 'acme/widgets' },
      defaultBranch: 'develop',
      authenticated: true
    })
    expect(calls.map((c) => c.url)).toEqual(['https://api.github.com/repos/acme/widgets'])
  })

  it('lists open pull requests with auth headers and caches them', async () => {
    respond = () => new Response(JSON.stringify([rawPull()]), { status: 200 })
    const prs = await listOpenPullRequests(dir, true)
    expect(prs.map((p) => p.number)).toEqual([7])
    // default branch stays cached across a forced refresh; only the PR list is requested
    expect(calls.map((c) => c.url)).toEqual(['https://api.github.com/repos/acme/widgets/pulls?state=open&per_page=100&page=1'])
    expect(calls[0].headers.Authorization).toBe('Bearer test-token')
    expect(calls[0].headers['User-Agent']).toBe('Gitlane')
    await listOpenPullRequests(dir)
    expect(calls).toHaveLength(1) // served from cache
  })

  it('looks up pull requests for a commit, and explains unpushed commits', async () => {
    respond = () => new Response(JSON.stringify([rawPull({ state: 'closed', merged_at: '2026-11-02T00:00:00Z' })]), { status: 200 })
    const found = await pullRequestsForCommit(dir, 'abc123')
    expect(calls[0].url).toBe('https://api.github.com/repos/acme/widgets/commits/abc123/pulls?per_page=50')
    expect(found.prs[0].state).toBe('merged')

    respond = () => new Response(JSON.stringify({ message: 'No commit found for SHA: def456' }), { status: 422 })
    const missing = await pullRequestsForCommit(dir, 'def456')
    expect(missing.prs).toEqual([])
    expect(missing.notice).toMatch(/isn't on github.com yet/)
  })

  it('turns API failures into actionable messages', async () => {
    respond = () => new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 })
    await expect(pullRequestsForCommit(dir, 'bad1')).rejects.toThrow(/gh auth login/)
    respond = () =>
      new Response(JSON.stringify({ message: 'API rate limit exceeded' }), { status: 403, headers: { 'x-ratelimit-remaining': '0' } })
    await expect(pullRequestsForCommit(dir, 'bad2')).rejects.toThrow(/rate limit/)
  })
})

describe('matching branches to pull requests', () => {
  const info: GitHubInfo = {
    host: 'github.com',
    repo: 'acme/widgets',
    webUrl: 'https://github.com/acme/widgets',
    remotes: { origin: 'acme/widgets', fork: 'me/widgets' },
    defaultBranch: 'trunk',
    authenticated: true
  }
  const remotes = ['origin', 'fork', 'gitlab']
  const pr = (over: Partial<PullRequest>): PullRequest => ({
    number: 1,
    title: 't',
    state: 'open',
    draft: false,
    url: 'u',
    author: 'a',
    headRef: 'feature/x',
    headRepo: 'acme/widgets',
    baseRef: 'main',
    updatedAt: '',
    ...over
  })
  const local = (short: string, upstream?: string): Ref => ({ name: `refs/heads/${short}`, short, type: 'head', sha: 's', upstream })
  const remote = (short: string): Ref => ({ name: `refs/remotes/${short}`, short, type: 'remote', sha: 's', remote: short.split('/')[0] })

  it('matches by upstream branch and head repository', () => {
    const refs = [local('feature/x', 'origin/feature/x'), remote('origin/feature/x')]
    const data = { info, openPrs: [pr({ number: 5 })] }
    expect(prForRef(refs[0], refs, remotes, data)?.number).toBe(5)
    expect(prForRef(refs[1], refs, remotes, data)?.number).toBe(5)
  })

  it("does not confuse a fork's same-named branch with ours", () => {
    const refs = [local('main', 'origin/main')]
    const data = { info, openPrs: [pr({ number: 9, headRef: 'main', headRepo: 'stranger/widgets' })] }
    expect(prForRef(refs[0], refs, remotes, data)).toBeUndefined()
  })

  it('finds branches pushed without upstream via a same-named remote branch', () => {
    const refs = [local('feature/x'), remote('origin/feature/x')]
    expect(prForRef(refs[0], refs, remotes, { info, openPrs: [pr({ number: 3 })] })?.number).toBe(3)
    expect(prForRef(local('unpushed'), [local('unpushed')], remotes, { info, openPrs: [pr({ headRef: 'unpushed' })] })).toBeUndefined()
  })

  it('builds compare URLs for same-repo and fork branches', () => {
    const refs = [local('feature/x', 'origin/feature/x'), local('fix', 'fork/fix')]
    expect(createPrUrl(refs[0], refs, remotes, info)).toBe('https://github.com/acme/widgets/compare/feature/x?expand=1')
    expect(createPrUrl(refs[1], refs, remotes, info)).toBe('https://github.com/acme/widgets/compare/me:fix?expand=1')
    expect(createPrUrl(local('nowhere'), [], remotes, info)).toBeNull()
    // never offer a PR from the default branch, but a fork's "trunk" is fine
    expect(createPrUrl(local('trunk', 'origin/trunk'), [], remotes, info)).toBeNull()
    expect(createPrUrl(local('trunk', 'fork/trunk'), [], remotes, info)).toBe('https://github.com/acme/widgets/compare/me:trunk?expand=1')
  })

  it('merges and orders pull request lists', () => {
    const merged = mergePullRequests([pr({ number: 2, state: 'merged' })], [pr({ number: 4 }), pr({ number: 2, state: 'merged' })])
    expect(merged.map((p) => p.number)).toEqual([4, 2])
  })
})
