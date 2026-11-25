import { describe, expect, it } from 'vitest'
import {
  parseCommitHeader,
  parseDiff,
  parseLog,
  parseNameStatus,
  parseRefs,
  parseStashes,
  parseStatus
} from '../src/main/git/parsers'

const F = '\x1f'
const R = '\x1e'

describe('parseLog', () => {
  it('parses records with and without parents', () => {
    const out = `aaa${F}bbb ccc${F}Ann${F}ann@x.io${F}1700000000${F}Merge it${R}\nbbb${F}${F}Bob${F}bob@x.io${F}1690000000${F}Initial${R}\n`
    expect(parseLog(out)).toEqual([
      { sha: 'aaa', parents: ['bbb', 'ccc'], author: 'Ann', email: 'ann@x.io', date: 1700000000, subject: 'Merge it' },
      { sha: 'bbb', parents: [], author: 'Bob', email: 'bob@x.io', date: 1690000000, subject: 'Initial' }
    ])
  })
})

describe('parseRefs', () => {
  it('classifies branches, remotes and tags', () => {
    const out = [
      ['refs/heads/main', 'a1', '', 'origin/main', 'ahead 2, behind 1', '*', ''],
      ['refs/heads/old', 'a2', '', 'origin/old', 'gone', ' ', ''],
      ['refs/remotes/origin/HEAD', 'a1', '', '', '', ' ', 'refs/remotes/origin/main'],
      ['refs/remotes/origin/feature/x', 'a3', '', '', '', ' ', ''],
      ['refs/tags/v1', 'tagobj', 'a4', '', '', ' ', '']
    ]
      .map((f) => f.join(F))
      .join('\n')
    const refs = parseRefs(out)
    expect(refs).toHaveLength(4)
    expect(refs[0]).toMatchObject({ short: 'main', type: 'head', current: true, upstream: 'origin/main', ahead: 2, behind: 1 })
    expect(refs[1]).toMatchObject({ short: 'old', gone: true, current: false })
    expect(refs[2]).toMatchObject({ short: 'origin/feature/x', type: 'remote', remote: 'origin' })
    expect(refs[3]).toMatchObject({ short: 'v1', type: 'tag', sha: 'a4' })
  })
})

describe('parseStashes', () => {
  it('parses stash entries', () => {
    const out = `stash@{1}${F}s1${F}base idx untracked${F}1700000000${F}WIP on main: abc subject\n`
    expect(parseStashes(out)).toEqual([
      { index: 1, ref: 'stash@{1}', sha: 's1', parents: ['base', 'idx', 'untracked'], date: 1700000000, message: 'WIP on main: abc subject' }
    ])
  })
})

describe('parseStatus', () => {
  it('parses porcelain v2 output', () => {
    const entries = [
      '# branch.oid 1234',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +3 -0',
      '1 M. N... 100644 100644 100644 aaa bbb staged only.txt',
      '1 .M N... 100644 100644 100644 aaa bbb dir/unstaged.txt',
      '1 MM N... 100644 100644 100644 aaa bbb both.txt',
      '2 R. N... 100644 100644 100644 aaa bbb R100 new name.txt',
      'old name.txt',
      'u UU N... 100644 100644 100644 100644 a b c conflict.txt',
      '? new file.txt'
    ]
    const status = parseStatus(entries.join('\0') + '\0')
    expect(status).toMatchObject({ branch: 'main', head: '1234', upstream: 'origin/main', ahead: 3, behind: 0 })
    expect(status.staged).toEqual([
      { path: 'staged only.txt', status: 'M' },
      { path: 'both.txt', status: 'M' },
      { path: 'new name.txt', oldPath: 'old name.txt', status: 'R' }
    ])
    expect(status.unstaged).toEqual([
      { path: 'dir/unstaged.txt', status: 'M' },
      { path: 'both.txt', status: 'M' },
      { path: 'new file.txt', status: '?' }
    ])
    expect(status.conflicted).toEqual([{ path: 'conflict.txt', status: 'U' }])
  })

  it('handles detached and unborn heads', () => {
    expect(parseStatus('# branch.oid (initial)\0# branch.head main\0')).toMatchObject({ head: null, branch: 'main' })
    expect(parseStatus('# branch.oid abc\0# branch.head (detached)\0')).toMatchObject({ head: 'abc', branch: null })
  })
})

describe('parseNameStatus', () => {
  it('parses renames and leading newlines', () => {
    expect(parseNameStatus('\nM\0a.txt\0R087\0old.txt\0new.txt\0D\0gone.txt\0')).toEqual([
      { path: 'a.txt', status: 'M' },
      { path: 'new.txt', oldPath: 'old.txt', status: 'R' },
      { path: 'gone.txt', status: 'D' }
    ])
  })
})

describe('parseCommitHeader', () => {
  it('splits subject and keeps the full message', () => {
    const out = ['abc', 'p1 p2', 'Ann', 'a@x', '10', 'Cam', 'c@x', '20', 'Subject line\n\nBody text\n'].join(F)
    expect(parseCommitHeader(out)).toMatchObject({
      sha: 'abc',
      parents: ['p1', 'p2'],
      subject: 'Subject line',
      message: 'Subject line\n\nBody text',
      committer: 'Cam',
      committerDate: 20
    })
  })
})

describe('parseDiff', () => {
  it('parses hunks with line numbers', () => {
    const out = [
      'diff --git a/f.txt b/f.txt',
      'index 111..222 100644',
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@ -1,3 +1,3 @@ heading',
      ' one',
      '-two',
      '+TWO',
      ' three',
      '@@ -10 +10,2 @@',
      ' ten',
      '+eleven',
      '\\ No newline at end of file',
      ''
    ].join('\n')
    const diff = parseDiff(out)
    expect(diff.header).toHaveLength(4)
    expect(diff.binary).toBe(false)
    expect(diff.hunks).toHaveLength(2)
    expect(diff.hunks[0].lines).toEqual([
      { type: ' ', text: 'one', oldNo: 1, newNo: 1 },
      { type: '-', text: 'two', oldNo: 2 },
      { type: '+', text: 'TWO', newNo: 2 },
      { type: ' ', text: 'three', oldNo: 3, newNo: 3 }
    ])
    expect(diff.hunks[1]).toMatchObject({ oldStart: 10, oldLines: 1, newStart: 10, newLines: 2 })
    expect(diff.hunks[1].lines[2].type).toBe('\\')
  })

  it('detects binary files', () => {
    const diff = parseDiff('diff --git a/x.png b/x.png\nindex 1..2 100644\nBinary files a/x.png and b/x.png differ\n')
    expect(diff.binary).toBe(true)
    expect(diff.hunks).toHaveLength(0)
  })
})
