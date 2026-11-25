// Assigns every commit a column ("lane") and computes the line segments drawn in each row.
//
// Rows are processed top to bottom (children before parents). Each lane remembers which
// commit it is heading towards. A commit takes the leftmost lane waiting for it (or a
// free one if it is a branch tip); other lanes waiting for it end at its node. Its first
// parent continues in the same lane; further parents (merges) join an existing lane or
// open a new one.

export interface GraphNode {
  sha: string
  parents: string[]
  /** Lines leaving this node are drawn dashed (used for the WIP node). */
  dashed?: boolean
}

/** Vertical anchor of a segment end within its row. */
export type Anchor = 'top' | 'mid' | 'bottom'

export interface Segment {
  fromCol: number
  fromY: Anchor
  toCol: number
  toY: Anchor
  color: number
  dashed: boolean
}

export interface GraphRow {
  col: number
  color: number
  segments: Segment[]
}

export interface GraphLayout {
  rows: GraphRow[]
  /** Maximum number of lanes used by any row. */
  width: number
}

interface Lane {
  sha: string
  color: number
  dashed: boolean
}

function firstFree(lanes: (Lane | null)[]): number {
  const i = lanes.indexOf(null)
  return i === -1 ? lanes.length : i
}

export function computeLayout(nodes: GraphNode[]): GraphLayout {
  let lanes: (Lane | null)[] = []
  let nextColor = 0
  let width = 0
  const rows: GraphRow[] = []

  for (const node of nodes) {
    const segments: Segment[] = []
    const incoming: number[] = []
    lanes.forEach((lane, i) => {
      if (lane && lane.sha === node.sha) incoming.push(i)
    })

    let col: number
    let color: number
    if (incoming.length > 0) {
      col = incoming[0]
      color = lanes[col]!.color
    } else {
      col = firstFree(lanes)
      color = nextColor++
    }

    // Top half: lanes ending at this node, and lanes passing straight through.
    lanes.forEach((lane, i) => {
      if (!lane) return
      if (lane.sha === node.sha) {
        segments.push({ fromCol: i, fromY: 'top', toCol: col, toY: 'mid', color: lane.color, dashed: lane.dashed })
      } else {
        segments.push({ fromCol: i, fromY: 'top', toCol: i, toY: 'bottom', color: lane.color, dashed: lane.dashed })
      }
    })

    const next = lanes.slice()
    for (const i of incoming) next[i] = null

    const dashed = !!node.dashed
    const [first, ...rest] = node.parents
    if (first !== undefined) {
      next[col] = { sha: first, color, dashed }
      segments.push({ fromCol: col, fromY: 'mid', toCol: col, toY: 'bottom', color, dashed })
    }
    for (const parent of rest) {
      let target = next.findIndex((lane) => lane !== null && lane.sha === parent)
      if (target === -1) {
        target = firstFree(next)
        next[target] = { sha: parent, color: nextColor++, dashed }
      }
      segments.push({ fromCol: col, fromY: 'mid', toCol: target, toY: 'bottom', color: next[target]!.color, dashed })
    }

    while (next.length > 0 && next[next.length - 1] === null) next.pop()
    width = Math.max(width, lanes.length, next.length, col + 1)
    lanes = next
    rows.push({ col, color, segments })
  }

  return { rows, width }
}
