// Pure parsers for git's machine-readable output. No I/O here so they are easy to test.
import type {
  Commit,
  CommitDetails,
  DiffHunk,
  DiffLine,
  FileChange,
  FileDiff,
  FileStatus,
  Ref,
  Stash,
  Status
} from '../../shared/types'

const FS = '\x1f'
const RS = '\x1e'

export const LOG_FORMAT = ['%H', '%P', '%an', '%ae', '%at', '%s'].join('%x1f') + '%x1e'
export const DETAILS_FORMAT = ['%H', '%P', '%an', '%ae', '%at', '%cn', '%ce', '%ct', '%B'].join('%x1f')
export const STASH_FORMAT = ['%gd', '%H', '%P', '%at', '%gs'].join('%x1f')
export const REF_FORMAT = [
  '%(refname)',
  '%(objectname)',
  '%(*objectname)',
  '%(upstream:short)',
  '%(upstream:track,nobracket)',
  '%(HEAD)',
  '%(symref)'
].join('%1f')

const splitParents = (s: string | undefined): string[] => (s ? s.split(' ').filter(Boolean) : [])

export function parseLog(out: string): Commit[] {
  const commits: Commit[] = []
  for (const chunk of out.split(RS)) {
    const record = chunk.replace(/^\n+/, '')
    if (!record) continue
    const [sha, parents, author, email, date, subject = ''] = record.split(FS)
    commits.push({ sha, parents: splitParents(parents), author, email, date: Number(date), subject })
  }
  return commits
}

export function parseRefs(out: string): Ref[] {
  const refs: Ref[] = []
  for (const line of out.split('\n')) {
    if (!line) continue
    const [name, oid, peeled, upstream, track, head, symref] = line.split(FS)
    if (symref) continue // e.g. refs/remotes/origin/HEAD
    const sha = peeled || oid
    if (name.startsWith('refs/heads/')) {
      const ref: Ref = { name, short: name.slice('refs/heads/'.length), type: 'head', sha, current: head === '*' }
      if (upstream) {
        ref.upstream = upstream
        ref.ahead = Number(/ahead (\d+)/.exec(track)?.[1] ?? 0)
        ref.behind = Number(/behind (\d+)/.exec(track)?.[1] ?? 0)
        ref.gone = track === 'gone'
      }
      refs.push(ref)
    } else if (name.startsWith('refs/remotes/')) {
      const short = name.slice('refs/remotes/'.length)
      refs.push({ name, short, type: 'remote', sha, remote: short.split('/')[0] })
    } else if (name.startsWith('refs/tags/')) {
      refs.push({ name, short: name.slice('refs/tags/'.length), type: 'tag', sha })
    }
  }
  return refs
}

export function parseStashes(out: string): Stash[] {
  const stashes: Stash[] = []
  for (const line of out.split('\n')) {
    if (!line) continue
    const [ref, sha, parents, date, message = ''] = line.split(FS)
    const index = Number(/\{(\d+)\}/.exec(ref)?.[1] ?? stashes.length)
    stashes.push({ index, ref, sha, parents: splitParents(parents), date: Number(date), message })
  }
  return stashes
}

/** Split into at most `n` fields; the last field keeps any remaining separators. */
function splitN(s: string, sep: string, n: number): string[] {
  const parts: string[] = []
  let rest = s
  while (parts.length < n - 1) {
    const i = rest.indexOf(sep)
    if (i < 0) break
    parts.push(rest.slice(0, i))
    rest = rest.slice(i + sep.length)
  }
  parts.push(rest)
  return parts
}

const STATUS_CODES = new Set(['M', 'A', 'D', 'R', 'C', 'T', 'U'])
const toStatus = (c: string): FileStatus => (STATUS_CODES.has(c) ? (c as FileStatus) : 'M')

/** Parse `git status --porcelain=v2 --branch -z`. */
export function parseStatus(out: string): Omit<Status, 'operation'> {
  const status: Omit<Status, 'operation'> = {
    branch: null,
    head: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    conflicted: []
  }
  const entries = out.split('\0')
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (!entry) continue
    switch (entry[0]) {
      case '#': {
        const [, key, value = ''] = splitN(entry, ' ', 3)
        if (key === 'branch.oid') status.head = value === '(initial)' ? null : value
        else if (key === 'branch.head') status.branch = value === '(detached)' ? null : value
        else if (key === 'branch.upstream') status.upstream = value
        else if (key === 'branch.ab') {
          const m = /\+(\d+) -(\d+)/.exec(value)
          if (m) {
            status.ahead = Number(m[1])
            status.behind = Number(m[2])
          }
        }
        break
      }
      case '1': {
        // 1 XY sub mH mI mW hH hI path
        const f = splitN(entry, ' ', 9)
        addChange(status, f[1], f[8])
        break
      }
      case '2': {
        // 2 XY sub mH mI mW hH hI Xscore path \0 origPath
        const f = splitN(entry, ' ', 10)
        const oldPath = entries[++i]
        addChange(status, f[1], f[9], oldPath)
        break
      }
      case 'u': {
        // u XY sub m1 m2 m3 mW h1 h2 h3 path
        const f = splitN(entry, ' ', 11)
        status.conflicted.push({ path: f[10], status: 'U' })
        break
      }
      case '?':
        status.unstaged.push({ path: entry.slice(2), status: '?' })
        break
    }
  }
  return status
}

function addChange(status: Omit<Status, 'operation'>, xy: string, path: string, oldPath?: string) {
  const [x, y] = xy
  if (x !== '.') {
    const change: FileChange = { path, status: toStatus(x) }
    if (oldPath && (x === 'R' || x === 'C')) change.oldPath = oldPath
    status.staged.push(change)
  }
  if (y !== '.') {
    const change: FileChange = { path, status: toStatus(y) }
    if (oldPath && (y === 'R' || y === 'C')) change.oldPath = oldPath
    status.unstaged.push(change)
  }
}

/** Parse `--name-status -z` output. */
export function parseNameStatus(out: string): FileChange[] {
  const files: FileChange[] = []
  const parts = out.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i].trim()
    if (!code) continue
    const letter = code[0]
    if (letter === 'R' || letter === 'C') {
      const oldPath = parts[++i]
      const path = parts[++i]
      if (path !== undefined) files.push({ path, oldPath, status: letter })
    } else {
      const path = parts[++i]
      if (path !== undefined) files.push({ path, status: toStatus(letter) })
    }
  }
  return files
}

export function parseCommitHeader(out: string): Omit<CommitDetails, 'files'> {
  const parts = out.split(FS)
  const [sha, parents, author, email, date, committer, committerEmail, committerDate] = parts
  const message = parts.slice(8).join(FS).replace(/\s+$/, '')
  return {
    sha,
    parents: splitParents(parents),
    author,
    email,
    date: Number(date),
    committer,
    committerEmail,
    committerDate: Number(committerDate),
    message,
    subject: message.split('\n')[0]
  }
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/** Parse a unified diff of a single file. */
export function parseDiff(out: string): FileDiff {
  const lines = out.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()

  const diff: FileDiff = { header: [], hunks: [], binary: false }
  let hunk: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0
  let oldLeft = 0
  let newLeft = 0
  let seenFile = false

  for (const line of lines) {
    if (line.startsWith('diff --git ') || line.startsWith('diff --cc ')) {
      if (seenFile) break // only the first file
      seenFile = true
      diff.header.push(line)
      continue
    }
    const m = HUNK_RE.exec(line)
    if (m) {
      oldNo = Number(m[1])
      newNo = Number(m[3])
      oldLeft = m[2] === undefined ? 1 : Number(m[2])
      newLeft = m[4] === undefined ? 1 : Number(m[4])
      hunk = { header: line, oldStart: oldNo, oldLines: oldLeft, newStart: newNo, newLines: newLeft, lines: [] }
      diff.hunks.push(hunk)
      continue
    }
    if (!hunk) {
      diff.header.push(line)
      if (line.startsWith('Binary files ') || line === 'GIT binary patch') diff.binary = true
      continue
    }
    const type = line[0]
    let parsed: DiffLine | null = null
    if (type === '+') {
      parsed = { type: '+', text: line.slice(1), newNo: newNo++ }
      newLeft--
    } else if (type === '-') {
      parsed = { type: '-', text: line.slice(1), oldNo: oldNo++ }
      oldLeft--
    } else if (type === ' ' || (line === '' && (oldLeft > 0 || newLeft > 0))) {
      parsed = { type: ' ', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ }
      oldLeft--
      newLeft--
    } else if (type === '\\') {
      parsed = { type: '\\', text: line }
    }
    if (parsed) hunk.lines.push(parsed)
  }
  return diff
}
