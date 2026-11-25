// Compact unified diff for showing the agent's edits (not for applying patches).

export interface LineDiff {
  patch: string
  additions: number
  deletions: number
}

/** Longest-common-subsequence diff of two line arrays (only used on the changed middle region). */
function lcsOps(a: string[], b: string[]): (' ' | '-' | '+')[] {
  const n = a.length
  const m = b.length
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const ops: (' ' | '-' | '+')[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push(' ')
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push('-')
      i++
    } else {
      ops.push('+')
      j++
    }
  }
  while (i++ < n) ops.push('-')
  while (j++ < m) ops.push('+')
  return ops
}

export function lineDiff(before: string, after: string, context = 3): LineDiff {
  const a = before === '' ? [] : before.split('\n')
  const b = after === '' ? [] : after.split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  // Small middles get a real diff; huge rewrites are shown as removed-then-added.
  const ops: (' ' | '-' | '+')[] =
    midA.length * midB.length <= 4_000_000 ? lcsOps(midA, midB) : [...midA.map(() => '-' as const), ...midB.map(() => '+' as const)]

  // Full line list with operations, then cut into hunks with context.
  type Line = { op: ' ' | '-' | '+'; text: string; oldNo: number; newNo: number }
  const lines: Line[] = []
  for (let k = 0; k < start; k++) lines.push({ op: ' ', text: a[k], oldNo: k + 1, newNo: k + 1 })
  let ia = start
  let ib = start
  for (const op of ops) {
    if (op === ' ') lines.push({ op, text: midA[ia - start], oldNo: ++ia, newNo: ++ib })
    else if (op === '-') lines.push({ op, text: midA[ia - start], oldNo: ++ia, newNo: ib })
    else lines.push({ op, text: midB[ib - start], oldNo: ia, newNo: ++ib })
  }
  for (let k = endA; k < a.length; k++) lines.push({ op: ' ', text: a[k], oldNo: ++ia, newNo: ++ib })

  let additions = 0
  let deletions = 0
  const out: string[] = []
  let k = 0
  while (k < lines.length) {
    if (lines[k].op === ' ') {
      k++
      continue
    }
    let from = Math.max(0, k - context)
    let to = k
    // Extend the hunk while changes are within 2*context lines of each other.
    while (to < lines.length) {
      let next = to
      while (next < lines.length && lines[next].op !== ' ') next++
      let gap = next
      while (gap < lines.length && lines[gap].op === ' ' && gap - next < context * 2) gap++
      if (gap < lines.length && lines[gap].op !== ' ') to = gap
      else {
        to = Math.min(lines.length, next + context)
        break
      }
    }
    const hunk = lines.slice(from, to)
    const oldStart = hunk.find((l) => l.op !== '+')?.oldNo ?? 0
    const newStart = hunk.find((l) => l.op !== '-')?.newNo ?? 0
    const oldCount = hunk.filter((l) => l.op !== '+').length
    const newCount = hunk.filter((l) => l.op !== '-').length
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`)
    for (const l of hunk) {
      out.push(l.op + l.text)
      if (l.op === '+') additions++
      if (l.op === '-') deletions++
    }
    k = to
    from = to
  }
  return { patch: out.join('\n'), additions, deletions }
}
