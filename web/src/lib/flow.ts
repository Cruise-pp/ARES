import type { Graph, GraphNode, NodeType } from '../api/types'

/**
 * One application workflow, left to right:
 * tools & data → sub-agents (deepest first) → agents → the workflow → its outputs and duties.
 * Display only: it reads the structure from GET /graph and lights what the run already reached.
 */

export const PILL_W = 138
export const PILL_H = 30
const ROW_GAP = 42
const COL_W = 172
const PAD_X = 24 + PILL_W / 2
const PAD_TOP = 54

export interface FlowNode {
  id: string
  type: NodeType
  label: string
  col: number
  x: number
  y: number
  lit: boolean
  /** Index of this node's column among the columns that hold lit nodes; drives the reveal. */
  beat: number
}

export interface FlowEdge {
  id: string
  from: string
  to: string
  lit: boolean
}

export interface Flow {
  workflow: GraphNode | undefined
  nodes: FlowNode[]
  edges: FlowEdge[]
  byId: Map<string, FlowNode>
  columns: { col: number; x: number; label: string }[]
  width: number
  height: number
  beats: number
}

const label = (n: GraphNode | undefined, id: string) => {
  if (!n) return id
  if (n.type === 'tool') return n.version ? `${n.name} ${n.version}` : n.name ?? id
  if (n.type === 'data') return n.table && n.column ? `${n.table}.${n.column}` : n.name ?? id
  return n.name ?? id
}

export function workflowFlow(wfId: string, graph: Graph, lit: Set<string>): Flow {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const out = (id: string, ...types: string[]) =>
    graph.edges.filter((e) => e.source === id && types.includes(e.type)).map((e) => e.target)
  const byName = (a: string, b: string) => label(byId.get(a), a).localeCompare(label(byId.get(b), b))

  const agents = out(wfId, 'INVOKES').filter((id) => byId.get(id)?.type === 'agent').sort(byName)

  const parent = new Map<string, string>()
  const depth = new Map<string, number>()
  const kids = new Map<string, string[]>()
  const walk = (id: string, d: number) => {
    const ks = out(id, 'DELEGATES')
      .filter((k) => byId.get(k)?.type === 'subagent' && !parent.has(k))
      .sort(byName)
    ks.forEach((k) => {
      parent.set(k, id)
      depth.set(k, d + 1)
    })
    kids.set(id, ks)
    ks.forEach((k) => walk(k, d + 1))
  }
  agents.forEach((a) => {
    depth.set(a, 0)
    walk(a, 0)
  })
  const D = Math.max(0, ...depth.values())

  const descendants = (id: string): string[] => (kids.get(id) ?? []).flatMap((k) => [k, ...descendants(k)])

  // Tool and data edges. An agent's own edge is a roll-up of its sub-agents' edges; drop the covered ones.
  const uses: { from: string; to: string }[] = []
  for (const a of agents) {
    const desc = descendants(a)
    const covered = new Set(desc.flatMap((d) => out(d, 'RUNS_ON', 'READS')))
    for (const m of [a, ...desc]) {
      for (const t of out(m, 'RUNS_ON', 'READS')) {
        if (m === a && covered.has(t)) continue
        uses.push({ from: t, to: m })
      }
    }
  }

  const downstream = out(wfId, 'SENDS', 'SERVES').sort((a, b) => {
    const ta = byId.get(a)?.type === 'output' ? 0 : 1
    const tb = byId.get(b)?.type === 'output' ? 0 : 1
    return ta - tb || byName(a, b)
  })

  const colOf = new Map<string, number>()
  const y = new Map<string, number>()
  let slot = 0
  const place = (id: string) => {
    const ks = kids.get(id) ?? []
    if (!ks.length) {
      y.set(id, slot++ * ROW_GAP)
      return
    }
    ks.forEach(place)
    y.set(id, ks.reduce((s, k) => s + y.get(k)!, 0) / ks.length)
  }
  agents.forEach((a, i) => {
    if (i > 0) slot += 0.35
    place(a)
    colOf.set(a, D + 1)
    descendants(a).forEach((d) => colOf.set(d, 1 + (D - depth.get(d)!)))
  })
  if (!agents.length) slot = 1

  // Leaves sit at the mean height of the members that use them, then spread so none overlap.
  const leaves = [...new Set(uses.map((u) => u.from))]
  const want = new Map(
    leaves.map((t) => {
      const users = uses.filter((u) => u.from === t).map((u) => y.get(u.to)!)
      return [t, users.reduce((s, v) => s + v, 0) / users.length]
    }),
  )
  leaves.sort((a, b) => want.get(a)! - want.get(b)! || byName(a, b))
  let last = -Infinity
  for (const t of leaves) {
    const v = Math.max(want.get(t)!, last + ROW_GAP)
    y.set(t, v)
    colOf.set(t, 0)
    last = v
  }

  const wfY = agents.length ? agents.reduce((s, a) => s + y.get(a)!, 0) / agents.length : 0
  y.set(wfId, wfY)
  colOf.set(wfId, D + 2)
  downstream.forEach((d, i) => {
    y.set(d, wfY + (i - (downstream.length - 1) / 2) * ROW_GAP)
    colOf.set(d, D + 3)
  })

  const ids = [...colOf.keys()]
  const minY = Math.min(...ids.map((id) => y.get(id)!))
  const maxY = Math.max(...ids.map((id) => y.get(id)!))

  const litCols = [...new Set(ids.filter((id) => lit.has(id)).map((id) => colOf.get(id)!))].sort((a, b) => a - b)
  const nodes: FlowNode[] = ids.map((id) => {
    const n = byId.get(id)
    const col = colOf.get(id)!
    return {
      id,
      type: (n?.type ?? 'tool') as NodeType,
      label: label(n, id),
      col,
      x: PAD_X + col * COL_W,
      y: PAD_TOP + PILL_H / 2 + (y.get(id)! - minY),
      lit: lit.has(id),
      beat: Math.max(0, litCols.indexOf(col)),
    }
  })
  const flowById = new Map(nodes.map((n) => [n.id, n]))

  const edges: FlowEdge[] = [
    ...uses.map((u) => ({ from: u.from, to: u.to })),
    ...[...parent.entries()].map(([k, p]) => ({ from: k, to: p })),
    ...agents.map((a) => ({ from: a, to: wfId })),
    ...downstream.map((d) => ({ from: wfId, to: d })),
  ].map((e) => ({ ...e, id: `${e.from}>${e.to}`, lit: lit.has(e.from) && lit.has(e.to) }))

  const colLabel = (c: number) => {
    if (c === 0) return 'TOOLS & DATA'
    if (c <= D) return c === D ? 'SUB-AGENTS' : 'NESTED SUB-AGENTS'
    if (c === D + 1) return 'AGENTS'
    if (c === D + 2) return 'WORKFLOW'
    return 'OUTPUTS & DUTIES'
  }
  const cols = [...new Set(nodes.map((n) => n.col))].sort((a, b) => a - b)

  return {
    workflow: byId.get(wfId),
    nodes,
    edges,
    byId: flowById,
    columns: cols.map((c) => ({ col: c, x: PAD_X + c * COL_W, label: colLabel(c) })),
    width: PAD_X * 2 + (D + 3) * COL_W,
    height: PAD_TOP + PILL_H + (maxY - minY) + 24,
    beats: litCols.length,
  }
}
