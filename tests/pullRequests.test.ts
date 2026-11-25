import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { setFetch } from '../src/main/github'
import { runGit } from '../src/main/git/runner'
import * as prs from '../src/main/pullRequests'

describe('mapping', () => {
  it('builds repo-scoped search queries', () => {
    expect(prs.searchQuery('acme/app', 'review-requested', 'open')).toBe(
      'repo:acme/app is:pr is:open archived:false review-requested:@me sort:updated-desc'
    )
    expect(prs.searchQuery('acme/app', 'all', 'closed')).toBe('repo:acme/app is:pr is:closed archived:false sort:updated-desc')
  })

  it('maps check runs and commit statuses', () => {
    expect(
      prs.mapCheck({
        __typename: 'CheckRun',
        name: 'test',
        status: 'COMPLETED',
        conclusion: 'FAILURE',
        detailsUrl: 'u',
        title: 'boom',
        checkSuite: { workflowRun: { workflow: { name: 'CI' } } }
      })
    ).toEqual({ name: 'CI / test', state: 'failure', description: 'boom', url: 'u' })
    expect(prs.mapCheck({ __typename: 'CheckRun', name: 'lint', status: 'IN_PROGRESS' }).state).toBe('pending')
    expect(prs.mapCheck({ __typename: 'CheckRun', name: 'x', status: 'COMPLETED', conclusion: 'SKIPPED' }).state).toBe('skipped')
    expect(prs.mapCheck({ __typename: 'StatusContext', context: 'ci/legacy', state: 'SUCCESS', targetUrl: 't', description: 'ok' })).toEqual({
      name: 'ci/legacy',
      state: 'success',
      description: 'ok',
      url: 't'
    })
  })

  it('maps timeline nodes and skips pending reviews', () => {
    const actor = { login: 'ann', avatarUrl: 'a' }
    expect(prs.mapTimelineNode({ __typename: 'MergedEvent', actor, createdAt: 't', commit: { abbreviatedOid: 'abc1234' } }, 'main', 'feat')).toEqual({
      type: 'event',
      kind: 'merged',
      actor: { login: 'ann', avatarUrl: 'a' },
      text: 'merged commit abc1234 into main',
      createdAt: 't'
    })
    expect(prs.mapTimelineNode({ __typename: 'PullRequestReview', state: 'PENDING' }, 'main', 'feat')).toBeNull()
    expect(prs.mapTimelineNode({ __typename: 'PullRequestReview', id: 'r', author: actor, state: 'APPROVED', body: '', bodyHTML: '', createdAt: 't', submittedAt: 's' }, 'main', 'feat')).toMatchObject({
      type: 'review',
      state: 'APPROVED',
      createdAt: 's'
    })
    expect(prs.mapTimelineNode({ __typename: 'SomethingNew' }, 'main', 'feat')).toBeNull()
  })

  it('maps PR files and parses their patches', () => {
    const file = prs.mapFile({ filename: 'b.ts', previous_filename: 'a.ts', status: 'renamed', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new' })
    expect(file.previousPath).toBe('a.ts')
    expect(file.diff?.hunks[0].lines.map((l) => l.type + l.text)).toEqual(['-old', '+new'])
    expect(prs.mapFile({ filename: 'img.png', status: 'added', additions: 0, deletions: 0 }).diff).toBeNull()
  })

  it('merges review requests with latest reviews and reads permissions', () => {
    const detail = prs.mapDetail(rawDetail())
    expect(detail.reviewers).toEqual([
      { login: 'bob', avatarUrl: 'b', isTeam: false, state: 'APPROVED', requested: false },
      { login: 'cat', avatarUrl: 'c', isTeam: false, state: 'CHANGES_REQUESTED', requested: true },
      { login: 'core', avatarUrl: null, isTeam: true, state: null, requested: true }
    ])
    expect(detail.viewer).toEqual({ login: 'ann', avatarUrl: '', canUpdate: true, isAuthor: true, canMerge: true })
    expect(detail.mergeMethods).toEqual(['MERGE', 'SQUASH'])
    expect(detail.pendingReview).toEqual({ id: 'PRR_pending', comments: 2 })
    expect(detail.threads[0]).toMatchObject({ path: 'f.ts', line: 3, side: 'RIGHT', reviewId: 'PRR_1', diffHunk: '@@ -1 +1 @@' })
    expect(detail.threads[0].comments[0]).toMatchObject({ kind: 'review', pending: true, databaseId: 11 })
    expect(detail.checkState).toBe('pending')
    expect(detail.checks).toHaveLength(1)
  })
})

function rawDetail() {
  return {
    viewer: { login: 'ann' },
    repository: {
      viewerPermission: 'WRITE',
      mergeCommitAllowed: true,
      squashMergeAllowed: true,
      rebaseMergeAllowed: false,
      deleteBranchOnMerge: false,
      pullRequest: {
        id: 'PR_1',
        number: 5,
        title: 'T',
        body: '',
        bodyHTML: '',
        url: 'https://github.com/acme/app/pull/5',
        state: 'OPEN',
        isDraft: false,
        createdAt: 't',
        mergedAt: null,
        mergedBy: null,
        author: { login: 'ann', avatarUrl: 'a' },
        headRefName: 'feat',
        headRefOid: 'h'.repeat(40),
        baseRefName: 'main',
        headRepository: { nameWithOwner: 'acme/app' },
        mergeable: 'MERGEABLE' as const,
        mergeStateStatus: 'CLEAN',
        reviewDecision: 'CHANGES_REQUESTED' as const,
        viewerCanUpdate: true,
        viewerDidAuthor: true,
        additions: 1,
        deletions: 2,
        changedFiles: 1,
        labels: { nodes: [{ name: 'bug', color: 'ff0000' }] },
        assignees: { nodes: [{ login: 'ann', avatarUrl: 'a' }] },
        reviewRequests: {
          nodes: [
            { requestedReviewer: { __typename: 'User', login: 'cat', avatarUrl: 'c' } },
            { requestedReviewer: { __typename: 'Team', name: 'Core', slug: 'core' } }
          ]
        },
        latestReviews: {
          nodes: [
            { author: { login: 'bob', avatarUrl: 'b' }, state: 'APPROVED' as const },
            { author: { login: 'cat', avatarUrl: 'c' }, state: 'CHANGES_REQUESTED' as const }
          ]
        },
        reviews: { nodes: [{ id: 'PRR_pending', comments: { totalCount: 2 } }] },
        commits: { nodes: [] },
        checks: {
          nodes: [{ commit: { statusCheckRollup: { state: 'PENDING', contexts: { nodes: [{ __typename: 'CheckRun' as const, name: 'ci', status: 'QUEUED' }] } } } }]
        },
        timelineItems: { totalCount: 0, nodes: [] },
        reviewThreads: {
          nodes: [
            {
              id: 'T1',
              isResolved: false,
              isOutdated: false,
              path: 'f.ts',
              line: 3,
              startLine: null,
              originalLine: 3,
              diffSide: 'RIGHT' as const,
              viewerCanResolve: true,
              viewerCanUnresolve: false,
              viewerCanReply: true,
              comments: {
                nodes: [
                  {
                    id: 'C1',
                    databaseId: 11,
                    author: { login: 'ann', avatarUrl: 'a' },
                    body: 'hm',
                    bodyHTML: '<p>hm</p>',
                    createdAt: 't',
                    viewerCanUpdate: true,
                    viewerCanDelete: true,
                    state: 'PENDING',
                    diffHunk: '@@ -1 +1 @@',
                    pullRequestReview: { id: 'PRR_1' }
                  }
                ]
              }
            }
          ]
        }
      }
    }
  }
}

describe('mutations (mocked GitHub)', () => {
  let dir: string
  let calls: { url: string; method: string; body: unknown }[]
  let respond: (url: string, body: unknown) => Response
  const pr = { id: 'PR_1', number: 5 }
  const ok = (json: unknown = {}) => new Response(JSON.stringify(json), { status: 200 })
  const gql = () => calls.filter((c) => c.url.endsWith('/graphql')).map((c) => c.body as { query: string; variables: Record<string, unknown> })

  beforeAll(async () => {
    process.env.GH_TOKEN = 'test-token'
    dir = mkdtempSync(join(tmpdir(), 'gitlane-pr-'))
    await runGit(dir, ['init', '-q'])
    await runGit(dir, ['remote', 'add', 'origin', 'https://github.com/acme/app.git'])
    setFetch(async (url, init) => {
      const body = init.body ? JSON.parse(init.body as string) : undefined
      calls.push({ url, method: init.method ?? 'GET', body })
      if (url === 'https://api.github.com/repos/acme/app') return ok({ default_branch: 'main' })
      return respond(url, body)
    })
  })

  afterAll(() => {
    delete process.env.GH_TOKEN
    rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(() => {
    calls = []
    respond = () => ok({ data: {} })
  })

  it('posts a single review comment through REST', async () => {
    respond = () => ok({ id: 1 })
    await prs.addReviewComment(dir, pr, { path: 'f.ts', line: 9, side: 'RIGHT', startLine: 7, body: 'nit', mode: 'single', commitId: 'abc' })
    const post = calls.find((c) => c.method === 'POST')!
    expect(post.url).toBe('https://api.github.com/repos/acme/app/pulls/5/comments')
    expect(post.body).toEqual({ body: 'nit', commit_id: 'abc', path: 'f.ts', line: 9, side: 'RIGHT', start_line: 7, start_side: 'RIGHT' })
  })

  it('starts a pending review, then adds the thread to it', async () => {
    respond = (_url, body) => {
      const q = (body as { query: string }).query
      if (q.includes('addPullRequestReview(')) return ok({ data: { addPullRequestReview: { pullRequestReview: { id: 'PRR_new' } } } })
      return ok({ data: { addPullRequestReviewThread: { thread: { id: 'T' } } } })
    }
    await prs.addReviewComment(dir, pr, { path: 'f.ts', line: 2, side: 'LEFT', body: 'why?', mode: 'review', commitId: 'abc' })
    const [create, thread] = gql()
    expect(create.variables).toEqual({ id: 'PR_1', oid: 'abc' })
    expect(thread.variables).toEqual({ review: 'PRR_new', path: 'f.ts', line: 2, side: 'LEFT', startLine: null, startSide: null, body: 'why?' })
  })

  it('adds to an existing pending review even when asked for a single comment', async () => {
    await prs.addReviewComment(dir, pr, { path: 'f.ts', line: 2, side: 'RIGHT', body: 'x', mode: 'single', commitId: 'abc', pendingReviewId: 'PRR_p' })
    expect(gql()).toHaveLength(1)
    expect(gql()[0].variables.review).toBe('PRR_p')
  })

  it('replies immediately via REST, or into the pending review via GraphQL', async () => {
    respond = () => ok({ id: 2 })
    await prs.replyToThread(dir, pr, 'T1', 11, 'agreed')
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({
      url: 'https://api.github.com/repos/acme/app/pulls/5/comments/11/replies',
      body: { body: 'agreed' }
    })
    calls = []
    respond = () => ok({ data: {} })
    await prs.replyToThread(dir, pr, 'T1', 11, 'later', 'PRR_p')
    expect(gql()[0].variables).toEqual({ thread: 'T1', review: 'PRR_p', body: 'later' })
  })

  it('submits reviews with or without a pending review', async () => {
    await prs.submitReview(dir, pr, 'APPROVE', 'LGTM')
    expect(gql()[0].query).toContain('addPullRequestReview(')
    expect(gql()[0].variables).toEqual({ id: 'PR_1', event: 'APPROVE', body: 'LGTM' })
    calls = []
    await prs.submitReview(dir, pr, 'REQUEST_CHANGES', '', 'PRR_p')
    expect(gql()[0].query).toContain('submitPullRequestReview(')
    expect(gql()[0].variables).toEqual({ review: 'PRR_p', event: 'REQUEST_CHANGES', body: null })
  })

  it('adds and removes labels, reviewers and assignees', async () => {
    respond = () => ok([])
    await prs.setLabels(dir, pr, ['bug'], ['needs triage'])
    expect(calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST https://api.github.com/repos/acme/app/issues/5/labels',
      'DELETE https://api.github.com/repos/acme/app/issues/5/labels/needs%20triage'
    ])
    calls = []
    await prs.setReviewers(dir, pr, ['bob'], ['cat'])
    expect(calls.filter((c) => c.method !== 'GET').map((c) => [c.method, c.url, c.body])).toEqual([
      ['POST', 'https://api.github.com/repos/acme/app/pulls/5/requested_reviewers', { reviewers: ['bob'] }],
      ['DELETE', 'https://api.github.com/repos/acme/app/pulls/5/requested_reviewers', { reviewers: ['cat'] }]
    ])
    calls = []
    await prs.setAssignees(dir, pr, ['ann'], [])
    expect(calls.filter((c) => c.method !== 'GET').map((c) => [c.method, c.url, c.body])).toEqual([
      ['POST', 'https://api.github.com/repos/acme/app/issues/5/assignees', { assignees: ['ann'] }]
    ])
  })

  it('merges, then deletes the head branch (tolerating it being gone)', async () => {
    respond = (url) =>
      url.includes('/git/refs/') ? new Response(JSON.stringify({ message: 'Reference does not exist' }), { status: 422 }) : ok({ data: {} })
    await prs.mergePullRequest(dir, pr, 'SQUASH', { headline: 'T (#5)', body: '', expectedHeadOid: 'h', deleteBranch: { repo: 'acme/app', branch: 'feat/x' } })
    expect(gql()[0].variables).toEqual({ id: 'PR_1', method: 'SQUASH', headline: 'T (#5)', body: '', oid: 'h' })
    expect(calls.find((c) => c.method === 'DELETE')?.url).toBe('https://api.github.com/repos/acme/app/git/refs/heads/feat/x')
  })

  it('creates pull requests', async () => {
    respond = () => new Response(JSON.stringify({ number: 42, html_url: 'https://github.com/acme/app/pull/42' }), { status: 201 })
    const created = await prs.createPullRequest(dir, { head: 'feat', base: 'main', title: 'Add feat', body: 'Body', draft: true })
    expect(created).toEqual({ number: 42, url: 'https://github.com/acme/app/pull/42' })
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({
      url: 'https://api.github.com/repos/acme/app/pulls',
      body: { title: 'Add feat', head: 'feat', base: 'main', body: 'Body', draft: true }
    })
  })

  it('surfaces GraphQL errors', async () => {
    respond = () => ok({ errors: [{ message: 'Pull request is not mergeable' }] })
    await expect(prs.mergePullRequest(dir, pr, 'MERGE', { expectedHeadOid: 'h' })).rejects.toThrow('Pull request is not mergeable')
  })
})
