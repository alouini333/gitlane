import { describe, expect, it } from 'vitest'
import { computeLayout } from '../src/renderer/src/graph/layout'

describe('computeLayout', () => {
  it('keeps linear history in one lane', () => {
    const { rows, width } = computeLayout([
      { sha: 'c', parents: ['b'] },
      { sha: 'b', parents: ['a'] },
      { sha: 'a', parents: [] }
    ])
    expect(rows.map((r) => r.col)).toEqual([0, 0, 0])
    expect(width).toBe(1)
    // last commit has no outgoing segment
    expect(rows[2].segments.filter((s) => s.fromY === 'mid')).toHaveLength(0)
  })

  it('places a merged feature branch in a second lane', () => {
    //  m       (merge of main b and feature f)
    //  |\
    //  b f
    //  |/
    //  a
    const { rows, width } = computeLayout([
      { sha: 'm', parents: ['b', 'f'] },
      { sha: 'b', parents: ['a'] },
      { sha: 'f', parents: ['a'] },
      { sha: 'a', parents: [] }
    ])
    expect(rows.map((r) => r.col)).toEqual([0, 0, 1, 0])
    expect(width).toBe(2)
    // merge row: one segment continues down lane 0, one curves to lane 1
    const out = rows[0].segments.filter((s) => s.fromY === 'mid')
    expect(out.map((s) => s.toCol).sort()).toEqual([0, 1])
    // at 'a' both lanes converge
    const into = rows[3].segments.filter((s) => s.toY === 'mid')
    expect(into.map((s) => s.fromCol).sort()).toEqual([0, 1])
  })

  it('gives unrelated branch tips their own lanes and reuses freed lanes', () => {
    const { rows } = computeLayout([
      { sha: 'x2', parents: ['x1'] },
      { sha: 'y1', parents: ['base'] },
      { sha: 'x1', parents: ['base'] },
      { sha: 'base', parents: [] },
      { sha: 'z', parents: [] }
    ])
    expect(rows.map((r) => r.col)).toEqual([0, 1, 0, 0, 0])
  })

  it('propagates dashed lanes from the WIP node until HEAD', () => {
    const { rows } = computeLayout([
      { sha: 'wip', parents: ['h'], dashed: true },
      { sha: 'other', parents: ['h'] },
      { sha: 'h', parents: [] }
    ])
    expect(rows[0].segments.every((s) => s.dashed)).toBe(true)
    const passing = rows[1].segments.find((s) => s.fromCol === 0 && s.toY === 'bottom')
    expect(passing?.dashed).toBe(true)
    expect(rows[1].col).toBe(1)
  })

  it('keeps lanes stable and colors distinct across forks', () => {
    const { rows } = computeLayout([
      { sha: 'a3', parents: ['a2'] },
      { sha: 'b2', parents: ['b1'] },
      { sha: 'a2', parents: ['a1'] },
      { sha: 'b1', parents: ['a1'] },
      { sha: 'a1', parents: [] }
    ])
    expect(rows.map((r) => r.col)).toEqual([0, 1, 0, 1, 0])
    expect(rows[0].color).not.toBe(rows[1].color)
    expect(rows[2].color).toBe(rows[0].color)
    expect(rows[3].color).toBe(rows[1].color)
  })
})
