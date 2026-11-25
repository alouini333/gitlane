import type { DiffLine, FileDiff } from './types'

/** For each hunk index: every line, or the indexes of the selected lines within that hunk. */
export type PatchSelection = Map<number, Set<number> | 'all'>

/** Hunk/line staging only works for plain modifications of text files. */
export function canPartiallyApply(diff: FileDiff): boolean {
  return (
    !diff.binary &&
    diff.hunks.length > 0 &&
    !diff.header.some((h) => /^(new file mode|deleted file mode|rename from|copy from)/.test(h))
  )
}

/**
 * Build a patch containing only the selected changes, for `git apply`.
 *
 * Forward patches (staging) are matched against the old side, reverse patches
 * (unstaging, discarding) against the new side, so that side must stay intact:
 *  - forward: unselected `-` lines become context, unselected `+` lines are dropped;
 *  - reverse: unselected `+` lines become context, unselected `-` lines are dropped.
 * Since the matched side never changes, hunk start lines stay valid and `--recount`
 * fixes the line counts.
 */
export function buildPatch(diff: FileDiff, selection: PatchSelection, reverse: boolean): string | null {
  const body: string[] = []

  for (const hi of [...selection.keys()].sort((a, b) => a - b)) {
    const hunk = diff.hunks[hi]
    const picked = selection.get(hi)
    if (!hunk || !picked) continue
    const isSelected = (i: number) => picked === 'all' || picked.has(i)

    const out: string[] = []
    let changes = 0
    let i = 0
    while (i < hunk.lines.length) {
      if (hunk.lines[i].type === ' ') {
        out.push(' ' + hunk.lines[i].text)
        i++
        continue
      }
      let end = i
      while (end < hunk.lines.length && hunk.lines[end].type !== ' ') end++
      changes += emitBlock(hunk.lines, i, end, isSelected, reverse, out)
      i = end
    }
    if (changes === 0) continue

    const oldCount = out.filter((l) => l[0] === ' ' || l[0] === '-').length
    const newCount = out.filter((l) => l[0] === ' ' || l[0] === '+').length
    body.push(`@@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@`, ...out)
  }

  if (body.length === 0) return null
  return [...diff.header, ...body, ''].join('\n')
}

/**
 * Emit one block of consecutive changed lines. Lines that turn into context are moved
 * so a partially selected replacement keeps its position: staging "-b +B" out of
 * "-b -c +B +C" yields "a B c" rather than "a c B".
 */
function emitBlock(
  lines: DiffLine[],
  start: number,
  end: number,
  isSelected: (i: number) => boolean,
  reverse: boolean,
  out: string[]
): number {
  const indexes = Array.from({ length: end - start }, (_, k) => start + k)
  // Keep "\ No newline at end of file" markers attached by not moving anything in such blocks.
  const movable = !indexes.some((i) => lines[i].type === '\\')
  const selectedDeletes = indexes.filter((i) => lines[i].type === '-' && isSelected(i))
  const selectedAdds = indexes.filter((i) => lines[i].type === '+' && isSelected(i))
  const lastSelectedDelete = selectedDeletes.length ? selectedDeletes[selectedDeletes.length - 1] : -1
  const firstSelectedAdd = selectedAdds.length ? selectedAdds[0] : -1

  const before: string[] = []
  const middle: string[] = []
  const after: string[] = []
  let changes = 0
  let lastKept = true

  for (const i of indexes) {
    const line = lines[i]
    if (line.type === '\\') {
      if (lastKept) middle.push(line.text)
      continue
    }
    if (isSelected(i)) {
      middle.push(line.type + line.text)
      changes++
      lastKept = true
    } else if (!reverse && line.type === '-') {
      // Old-side order is preserved as long as moved lines come after every emitted deletion.
      if (movable && lastSelectedDelete >= 0 && i > lastSelectedDelete) after.push(' ' + line.text)
      else middle.push(' ' + line.text)
      lastKept = true
    } else if (reverse && line.type === '+') {
      // New-side order is preserved as long as moved lines come before every emitted addition.
      if (movable && firstSelectedAdd >= 0 && i < firstSelectedAdd) before.push(' ' + line.text)
      else middle.push(' ' + line.text)
      lastKept = true
    } else {
      lastKept = false
    }
  }

  out.push(...before, ...middle, ...after)
  return changes
}
