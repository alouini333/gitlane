// Integration tests against real git repositories in a temp directory.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Repository } from '../src/main/git/repository'
import { runGit } from '../src/main/git/runner'
import { buildPatch } from '../src/shared/patch'

let dir: string
let repo: Repository

const git = (...args: string[]) => runGit(dir, args)
const write = (file: string, content: string) => writeFileSync(join(dir, file), content)
const read = (file: string) => readFileSync(join(dir, file), 'utf8')

async function commitAll(message: string) {
  await git('add', '-A')
  await git('commit', '-q', '-m', message)
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gitlane-test-'))
  await git('init', '-q', '-b', 'main')
  await git('config', 'user.name', 'Test')
  await git('config', 'user.email', 'test@example.com')
  await git('config', 'commit.gpgsign', 'false')
  repo = new Repository(dir)
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('Repository', () => {
  it('handles an empty repository', async () => {
    const snap = await repo.snapshot(100)
    expect(snap.commits).toEqual([])
    expect(snap.status.head).toBeNull()
    expect(snap.status.branch).toBe('main')
    write('a.txt', 'hello\n')
    await repo.stageAll()
    await repo.unstageAll()
    expect((await repo.status()).unstaged).toEqual([{ path: 'a.txt', status: '?' }])
  })

  it('reads history, refs, stashes and status', async () => {
    write('a.txt', '1\n')
    await commitAll('first')
    await git('checkout', '-q', '-b', 'feature')
    write('b.txt', 'b\n')
    await commitAll('on feature')
    await git('checkout', '-q', 'main')
    write('a.txt', '2\n')
    await commitAll('second')
    await repo.merge('feature', true)
    await repo.createTag('v1', 'HEAD', 'release one')
    write('a.txt', '3\n')
    write('new.txt', 'new\n')
    await repo.stashSave('my stash', true)

    const snap = await repo.snapshot(100)
    expect(snap.commits.map((c) => c.subject)).toEqual(["Merge branch 'feature'", 'second', 'on feature', 'first'])
    expect(snap.commits[0].parents).toHaveLength(2)
    expect(snap.refs.find((r) => r.short === 'main')).toMatchObject({ type: 'head', current: true })
    expect(snap.refs.find((r) => r.short === 'v1')).toMatchObject({ type: 'tag', sha: snap.commits[0].sha })
    expect(snap.stashes).toHaveLength(1)
    expect(snap.stashes[0].message).toContain('my stash')
    expect(snap.status.unstaged).toEqual([])

    const details = await repo.commitDetails(snap.stashes[0].sha, true)
    expect(details.files).toEqual(
      expect.arrayContaining([
        { path: 'a.txt', status: 'M' },
        { path: 'new.txt', status: 'A', rev: `${snap.stashes[0].sha}^3` }
      ])
    )
    await repo.stashPop(0)
    const status = await repo.status()
    expect(status.unstaged.map((f) => f.path).sort()).toEqual(['a.txt', 'new.txt'])
  })

  it('stages and unstages individual lines', async () => {
    write('f.txt', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('\n') + '\n')
    await commitAll('init')
    write('f.txt', ['a', 'B', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'J', 'k'].join('\n') + '\n')

    const diff = await repo.diff({ kind: 'unstaged', path: 'f.txt' })
    expect(diff.hunks).toHaveLength(2)
    // Stage only "+B" / "-b" from the first hunk.
    const lines = diff.hunks[0].lines
    const picked = new Set(lines.flatMap((l, i) => (l.text.toLowerCase() === 'b' && l.type !== ' ' ? [i] : [])))
    const patch = buildPatch(diff, new Map([[0, picked]]), false)
    expect(patch).not.toBeNull()
    await repo.applyPatch(patch!, 'stage')

    const staged = await repo.diff({ kind: 'staged', path: 'f.txt' })
    const stagedChanges = staged.hunks.flatMap((h) => h.lines.filter((l) => l.type !== ' ').map((l) => l.type + l.text))
    expect(stagedChanges).toEqual(['-b', '+B'])

    // Now stage the whole second hunk, then unstage it again.
    const rest = await repo.diff({ kind: 'unstaged', path: 'f.txt' })
    await repo.applyPatch(buildPatch(rest, new Map([[0, 'all']]), false)!, 'stage')
    expect((await repo.status()).unstaged).toEqual([])
    const all = await repo.diff({ kind: 'staged', path: 'f.txt' })
    await repo.applyPatch(buildPatch(all, new Map([[1, 'all']]), true)!, 'unstage')
    const after = await repo.diff({ kind: 'unstaged', path: 'f.txt' })
    expect(after.hunks.flatMap((h) => h.lines.filter((l) => l.type !== ' ').map((l) => l.type + l.text))).toEqual([
      '-j',
      '+J',
      '+k'
    ])

    // Discard the remaining working-tree hunk.
    await repo.applyPatch(buildPatch(after, new Map([[0, 'all']]), true)!, 'discard')
    expect(read('f.txt')).toBe(['a', 'B', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('\n') + '\n')
  })

  it('commits, amends, branches and resets', async () => {
    write('a.txt', '1\n')
    await repo.stageAll()
    await repo.commit('first', false)
    write('a.txt', '2\n')
    await repo.stage(['a.txt'])
    await repo.commit('second\n\nbody', false)
    expect(await repo.lastCommitMessage()).toBe('second\n\nbody')
    await repo.commit('second (amended)', true)
    let snap = await repo.snapshot(10)
    expect(snap.commits.map((c) => c.subject)).toEqual(['second (amended)', 'first'])

    await repo.createBranch('topic', snap.commits[1].sha, true)
    expect((await repo.status()).branch).toBe('topic')
    await repo.checkout('main')
    await repo.renameBranch('topic', 'topic2')
    await repo.deleteBranch('topic2', false)
    await repo.reset(snap.commits[1].sha, 'hard')
    snap = await repo.snapshot(10)
    expect(snap.commits.map((c) => c.subject)).toEqual(['first'])
    expect(read('a.txt')).toBe('1\n')
  })

  it('detects and aborts a conflicted merge', async () => {
    write('c.txt', 'base\n')
    await commitAll('base')
    await git('checkout', '-q', '-b', 'other')
    write('c.txt', 'theirs\n')
    await commitAll('theirs')
    await git('checkout', '-q', 'main')
    write('c.txt', 'ours\n')
    await commitAll('ours')

    await expect(repo.merge('other', false)).rejects.toThrow(/conflict/i)
    const status = await repo.status()
    expect(status.operation).toBe('merge')
    expect(status.conflicted).toEqual([{ path: 'c.txt', status: 'U' }])
    expect(await repo.pendingMessage()).toContain("Merge branch 'other'")

    const diff = await repo.diff({ kind: 'unstaged', path: 'c.txt', conflicted: true })
    expect(diff.hunks.length).toBeGreaterThan(0)

    await repo.resolveWith(['c.txt'], 'theirs')
    expect(read('c.txt')).toBe('theirs\n')
    await repo.abortOperation()
    expect((await repo.status()).operation).toBe('none')
    expect(read('c.txt')).toBe('ours\n')
  })

  it('shows diffs for untracked files and commits', async () => {
    write('a.txt', 'x\n')
    await commitAll('first')
    write('u.txt', 'untracked\n')
    const u = await repo.diff({ kind: 'unstaged', path: 'u.txt', untracked: true })
    expect(u.hunks[0].lines).toEqual([{ type: '+', text: 'untracked', newNo: 1 }])
    const snap = await repo.snapshot(10)
    const c = await repo.diff({ kind: 'commit', sha: snap.commits[0].sha, path: 'a.txt' })
    expect(c.hunks[0].lines).toEqual([{ type: '+', text: 'x', newNo: 1 }])
    const details = await repo.commitDetails(snap.commits[0].sha)
    expect(details.files).toEqual([{ path: 'a.txt', status: 'A' }])
  })
})

describe('switching branches with uncommitted changes', () => {
  // main: A -> B. Local dev sits at A; origin/dev (remote-tracking) points at B.
  async function setup() {
    write('app.txt', 'v1\n')
    write('other.txt', 'x\n')
    await commitAll('A')
    const a = (await git('rev-parse', 'HEAD')).trim()
    write('app.txt', 'v2\n')
    await commitAll('B')
    const b = (await git('rev-parse', 'HEAD')).trim()
    await git('branch', 'dev', a)
    await git('remote', 'add', 'origin', 'https://example.invalid/demo.git')
    await git('update-ref', 'refs/remotes/origin/dev', b)
    return { a, b }
  }
  const stashCount = async () => (await git('stash', 'list')).split('\n').filter(Boolean).length
  const head = async () => (await git('rev-parse', 'HEAD')).trim()

  it('compares refs', async () => {
    await setup()
    expect(await repo.compareRefs('dev', 'origin/dev')).toEqual({ left: 0, right: 1 })
  })

  it('stashes changes, then resets the local branch to the remote one', async () => {
    const { b } = await setup()
    write('other.txt', 'local edit\n')
    write('new.txt', 'untracked\n')
    const result = await repo.switchTo({ kind: 'reset', branch: 'dev', startPoint: 'origin/dev' }, 'stash')
    expect(result).toMatchObject({ stashed: true, reapplied: false, reapplyConflict: false, branch: 'dev' })
    expect(result.stashMessage).toContain('dev')
    expect(await head()).toBe(b)
    expect((await repo.status()).branch).toBe('dev')
    expect((await repo.status()).unstaged).toEqual([])
    expect(await stashCount()).toBe(1)
  })

  it('re-applies stashed changes on the new branch when asked to', async () => {
    await setup()
    write('other.txt', 'local edit\n')
    const result = await repo.switchTo({ kind: 'reset', branch: 'dev', startPoint: 'origin/dev' }, 'stash-reapply')
    expect(result).toMatchObject({ stashed: true, reapplied: true, reapplyConflict: false })
    expect(read('other.txt')).toBe('local edit\n')
    expect(await stashCount()).toBe(0)
  })

  it('keeps the stash when re-applying conflicts', async () => {
    const { a } = await setup()
    await git('checkout', '-q', 'dev') // dev at A, app.txt = v1
    write('app.txt', 'mine\n')
    const result = await repo.switchTo({ kind: 'reset', branch: 'dev', startPoint: 'origin/dev' }, 'stash-reapply')
    expect(result).toMatchObject({ stashed: true, reapplied: false, reapplyConflict: true })
    expect(await head()).not.toBe(a)
    expect(await stashCount()).toBe(1)
  })

  it('puts changes back when the switch fails', async () => {
    await setup()
    write('other.txt', 'precious\n')
    await repo.stage(['other.txt'])
    await expect(repo.switchTo({ kind: 'branch', branch: 'does-not-exist' }, 'stash')).rejects.toThrow()
    expect(read('other.txt')).toBe('precious\n')
    expect((await repo.status()).staged).toEqual([{ path: 'other.txt', status: 'M' }])
    expect(await stashCount()).toBe(0)
  })

  it('carries changes over with the git default', async () => {
    await setup()
    write('other.txt', 'carried\n')
    const result = await repo.switchTo({ kind: 'branch', branch: 'dev' }, 'carry')
    expect(result.stashed).toBe(false)
    expect(read('other.txt')).toBe('carried\n')
  })

  it('creates tracking branches and detaches at commits', async () => {
    const { a } = await setup()
    await git('update-ref', 'refs/remotes/origin/feature', a)
    await repo.switchTo({ kind: 'track', branch: 'feature', remoteRef: 'origin/feature' }, 'stash')
    expect((await repo.status()).branch).toBe('feature')
    const detached = await repo.switchTo({ kind: 'detach', rev: a }, 'stash')
    expect(detached.branch).toBeNull()
    expect((await repo.status()).branch).toBeNull()
  })

  it('refuses to switch in the middle of a merge', async () => {
    write('c.txt', 'base\n')
    await commitAll('base')
    await git('checkout', '-q', '-b', 'other')
    write('c.txt', 'theirs\n')
    await commitAll('theirs')
    await git('checkout', '-q', 'main')
    write('c.txt', 'ours\n')
    await commitAll('ours')
    await repo.merge('other', false).catch(() => undefined)
    await expect(repo.switchTo({ kind: 'branch', branch: 'other' }, 'stash')).rejects.toThrow(/merge in progress/)
  })
})
