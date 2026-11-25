import { describe, expect, it } from 'vitest'
import { parseDiff } from '../src/main/git/parsers'
import { buildPatch, canPartiallyApply } from '../src/shared/patch'

const diff = parseDiff(
  [
    'diff --git a/f b/f',
    'index 1..2 100644',
    '--- a/f',
    '+++ b/f',
    '@@ -1,4 +1,4 @@',
    ' a',
    '-b',
    '-c',
    '+B',
    '+C',
    ' d',
    ''
  ].join('\n')
)

describe('buildPatch', () => {
  it('keeps the old side intact when staging a subset (forward)', () => {
    // select "-b" (1) and "+B" (3)
    const patch = buildPatch(diff, new Map([[0, new Set([1, 3])]]), false)
    expect(patch).toBe(
      ['diff --git a/f b/f', 'index 1..2 100644', '--- a/f', '+++ b/f', '@@ -1,4 +1,4 @@', ' a', '-b', '+B', ' c', ' d', ''].join(
        '\n'
      )
    )
  })

  it('keeps the new side intact when unstaging a subset (reverse)', () => {
    const patch = buildPatch(diff, new Map([[0, new Set([1, 3])]]), true)
    expect(patch?.split('\n').slice(4)).toEqual(['@@ -1,4 +1,4 @@', ' a', '-b', '+B', ' C', ' d', ''])
  })

  it('moves kept additions ahead of a later selected pair when unstaging', () => {
    // select "-c" (2) and "+C" (4): result after reverse apply must read a B c d
    const patch = buildPatch(diff, new Map([[0, new Set([2, 4])]]), true)
    expect(patch?.split('\n').slice(4)).toEqual(['@@ -1,4 +1,4 @@', ' a', ' B', '-c', '+C', ' d', ''])
  })

  it('returns null when nothing changes', () => {
    expect(buildPatch(diff, new Map([[0, new Set([0])]]), false)).toBeNull()
  })

  it('refuses partial staging for new files', () => {
    const created = parseDiff('diff --git a/n b/n\nnew file mode 100644\n--- /dev/null\n+++ b/n\n@@ -0,0 +1 @@\n+x\n')
    expect(canPartiallyApply(created)).toBe(false)
    expect(canPartiallyApply(diff)).toBe(true)
  })
})
