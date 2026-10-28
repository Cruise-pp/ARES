import type { GraphEdge, GraphNode, NodeType, Reached } from '../api/types'
import { nodeLabel, TYPE_PLURAL } from './format'

export const VIEW = 640
export const CENTER = VIEW / 2
export const OUTER_R = 250
export const ROOT_ID = '__change'

export interface LaidNode {
  id: string
  type: NodeType | 'change'
  label: string
  x: number
  y: number
  ring: number
  angle: number
  hops: number
  parent: string | null
  ghost: boolean
}

export interface LaidEdge {
  id: string
  from: string
  to: string
  ring: number
  ghost: boolean
  length: number
}

export interface RingGuide {
  index: number
  r: number
  label: string
}

export interface Layout {
  nodes: LaidNode[]
  edges: LaidEdge[]
  rings: RingGuide[]
  multiStart: boolean
  byId: Map<string, LaidNode>
}

const TYPE_ORDER: Record<string, number> = { tool: 0, data: 1, agent: 2, workflow: 3, obligation: 4, output: 5 }
const DEFAULT_RING: Record<NodeType, number> = { tool: 1, data: 1, agent: 1, subagent: 1, workflow: 2, obligation: 3, output: 3 }
const DEG = Math.PI / 180

const byTypeThenId = (a: { type: string; id: string }, b: { type: string; id: string }) =>
  (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9) || a.id.localeCompare(b.id)

export function radialLayout(
  reached: Reached[],
  graphNodes: Map<string, GraphNode>,
  graphEdges: GraphEdge[],
  opts: { ghostCap?: number; rootLabel?: string } = {},
): Layout {
  const ghostCap = opts.ghostCap ?? 4
  const starts = reached.filter((r) => r.hops === 0)
  const multiStart = starts.length !== 1
  const rootId = multiStart ? ROOT_ID : starts[0].id
  const ringOf = (r: Reached) => r.hops + (multiStart ? 1 : 0)
  const maxRing = Math.max(3, ...reached.map(ringOf))
  const step = OUTER_R / maxRing

  const parentOf = (r: Reached): string | null =>
    r.hops === 0 ? (multiStart ? ROOT_ID : null) : r.path[r.path.length - 2]

  const children = new Map<string, Reached[]>()
  for (const r of reached) {
    const p = parentOf(r)
    if (p === null) continue
    const list = children.get(p) ?? []
    list.push(r)
    children.set(p, list)
  }
  for (const list of children.values()) list.sort(byTypeThenId)

  const leafMemo = new Map<string, number>()
  const leaves = (id: string): number => {
    if (leafMemo.has(id)) return leafMemo.get(id)!
    const kids = children.get(id) ?? []
    const n = kids.length ? kids.reduce((s, k) => s + leaves(k.id), 0) : 1
    leafMemo.set(id, n)
    return n
  }

  const reachedIds = new Set(reached.map((r) => r.id))
  const ghostIds = new Set<string>()
  for (const e of graphEdges) {
    if (reachedIds.has(e.source) && !reachedIds.has(e.target)) ghostIds.add(e.target)
    if (reachedIds.has(e.target) && !reachedIds.has(e.source)) ghostIds.add(e.source)
  }
  const GHOST_PRIORITY: Record<string, number> = { workflow: 0, agent: 1, tool: 2, data: 3, obligation: 4, output: 5 }
  const ghosts = [...ghostIds]
    .map((id) => graphNodes.get(id))
    .filter((n): n is GraphNode => !!n && n.type !== 'subagent')
    .sort((a, b) => GHOST_PRIORITY[a.type] - GHOST_PRIORITY[b.type] || a.id.localeCompare(b.id))
    .slice(0, ghostCap)
    .sort(byTypeThenId)

  const totalLeaves = leaves(rootId)
  const ghostShare = ghosts.length ? Math.min(0.26, 0.065 * ghosts.length) : 0
  const sweep = Math.min(360 * (1 - ghostShare) - 10, Math.max(130, totalLeaves * 62))
  const mainCenter = -25

  const nodes: LaidNode[] = []
  const place = (ring: number, angle: number) => ({
    x: CENTER + ring * step * Math.cos(angle * DEG),
    y: CENTER + ring * step * Math.sin(angle * DEG),
  })

  const rootReached = reached.find((r) => r.id === rootId)
  nodes.push({
    id: rootId,
    type: rootReached?.type ?? 'change',
    label: rootReached ? nodeLabel(graphNodes.get(rootId), rootReached.name) : (opts.rootLabel ?? 'The change'),
    x: CENTER,
    y: CENTER,
    ring: 0,
    angle: 0,
    hops: 0,
    parent: null,
    ghost: false,
  })

  const assign = (id: string, a0: number, a1: number) => {
    const kids = children.get(id) ?? []
    const total = kids.reduce((s, k) => s + leaves(k.id), 0)
    let a = a0
    for (const k of kids) {
      const span = ((a1 - a0) * leaves(k.id)) / total
      const angle = a + span / 2
      const ring = ringOf(k)
      nodes.push({
        id: k.id,
        type: k.type,
        label: nodeLabel(graphNodes.get(k.id), k.name),
        ...place(ring, angle),
        ring,
        angle,
        hops: k.hops,
        parent: id,
        ghost: false,
      })
      assign(k.id, a, a + span)
      a += span
    }
  }
  assign(rootId, mainCenter - sweep / 2, mainCenter + sweep / 2)

  const typicalRing = new Map<string, number>()
  for (const n of nodes) if (n.ring > 0 && !typicalRing.has(n.type)) typicalRing.set(n.type, n.ring)
  const ghostCenter = mainCenter + 180
  const ghostSpan = Math.max(30, 360 * ghostShare)
  ghosts.forEach((g, i) => {
    const angle = ghostCenter - ghostSpan / 2 + (ghostSpan * (i + 0.5)) / ghosts.length
    const ring = Math.min(maxRing, Math.max(1, typicalRing.get(g.type) ?? DEFAULT_RING[g.type] + (multiStart ? 1 : 0)))
    nodes.push({
      id: g.id,
      type: g.type,
      label: nodeLabel(g),
      ...place(ring, angle),
      ring,
      angle,
      hops: Infinity,
      parent: null,
      ghost: true,
    })
  })

  const byId = new Map(nodes.map((n) => [n.id, n]))
  const dist = (a: LaidNode, b: LaidNode) => Math.hypot(a.x - b.x, a.y - b.y)
  const edges: LaidEdge[] = []
  for (const n of nodes) {
    if (n.ghost || !n.parent) continue
    const p = byId.get(n.parent)!
    edges.push({ id: `${n.parent}>${n.id}`, from: n.parent, to: n.id, ring: n.ring, ghost: false, length: dist(p, n) })
  }
  const ghostSet = new Set(ghosts.map((g) => g.id))
  for (const e of graphEdges) {
    if (!ghostSet.has(e.source) || !ghostSet.has(e.target)) continue
    const a = byId.get(e.source)
    const b = byId.get(e.target)
    if (!a || !b) continue
    edges.push({ id: `${a.id}~${b.id}`, from: a.id, to: b.id, ring: 0, ghost: true, length: dist(a, b) })
  }

  const rings: RingGuide[] = []
  for (let i = 1; i <= maxRing; i++) {
    const tally = new Map<string, number>()
    for (const n of nodes) if (!n.ghost && n.ring === i) tally.set(n.type, (tally.get(n.type) ?? 0) + 1)
    const top = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]
    rings.push({ index: i, r: i * step, label: top ? TYPE_PLURAL[top[0] as NodeType].toUpperCase() : '' })
  }

  return { nodes, edges, rings, multiStart, byId }
}
