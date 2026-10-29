import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useGraph } from '../api/hooks'
import type { GraphNode, NodeType } from '../api/types'
import { nodeLabel, ownerLine, TYPE_PLURAL } from '../lib/format'

const COLUMNS: NodeType[] = ['tool', 'data', 'agent', 'workflow', 'obligation', 'output']
const COL_W = 190
const ROW_H = 19
const TOP = 46
const LEFT = 40

const FILL: Record<NodeType, string> = {
  subagent: 'var(--amber)',
  tool: 'var(--red)',
  data: 'var(--red)',
  agent: 'var(--amber)',
  workflow: 'var(--text)',
  obligation: 'var(--blue)',
  output: 'var(--blue)',
}

const DETAIL_FIELDS = ['version', 'ecosystem', 'labels', 'model_id', 'model_region', 'sends_external', 'state', 'authority', 'channel', 'volume']

export function GraphView() {
  const { graph, error } = useGraph()
  const [selected, setSelected] = useState<string | null>(null)

  const layout = useMemo(() => {
    if (!graph) return null
    const cols = new Map<NodeType, GraphNode[]>(COLUMNS.map((t) => [t, []]))
    for (const n of graph.nodes) cols.get(n.type)?.push(n)
    const neighbours = new Map<string, string[]>()
    for (const e of graph.edges) {
      neighbours.set(e.source, [...(neighbours.get(e.source) ?? []), e.target])
      neighbours.set(e.target, [...(neighbours.get(e.target) ?? []), e.source])
    }
    const index = new Map<string, number>()
    const order = (t: NodeType, by: (n: GraphNode) => number) => {
      const list = cols.get(t)!
      list.sort((a, b) => by(a) - by(b) || a.id.localeCompare(b.id))
      list.forEach((n, i) => index.set(n.id, i))
    }
    const bary = (n: GraphNode) => {
      const ns = (neighbours.get(n.id) ?? []).map((id) => index.get(id)).filter((x): x is number => x !== undefined)
      return ns.length ? ns.reduce((s, x) => s + x, 0) / ns.length : 999
    }
    order('agent', () => 0)
    order('tool', bary)
    order('data', bary)
    order('workflow', bary)
    order('obligation', bary)
    order('output', bary)

    const pos = new Map<string, { x: number; y: number }>()
    COLUMNS.forEach((t, c) => {
      const list = cols.get(t)!
      list.forEach((n, i) => pos.set(n.id, { x: LEFT + c * COL_W, y: TOP + i * ROW_H }))
    })
    const height = TOP + Math.max(...COLUMNS.map((t) => cols.get(t)!.length)) * ROW_H + 20
    return { cols, pos, height }
  }, [graph])

  if (error) return <main className="page"><div className="error-box">{error.message}</div></main>
  if (!graph || !layout) return <div className="loading">Loading the graph…</div>

  const linked = new Set<string>()
  if (selected) {
    linked.add(selected)
    for (const e of graph.edges) {
      if (e.source === selected) linked.add(e.target)
      if (e.target === selected) linked.add(e.source)
    }
  }
  const sel = selected ? graph.nodes.find((n) => n.id === selected) : null
  const pausedCount = graph.nodes.filter((n) => n.type === 'workflow' && n.state === 'paused').length

  return (
    <div className="graph-wrap">
      <div className="graph-stats">
        <div>
          <div className="n">{graph.nodes.filter((n) => n.type !== 'subagent').length}</div>
          <div className="l">nodes</div>
        </div>
        <div>
          <div className="n">{graph.edges.filter((e) => e.type !== 'DELEGATES' && !e.source.startsWith('sa_')).length}</div>
          <div className="l">links</div>
        </div>
        {COLUMNS.map((t) => (
          <div key={t}>
            <div className="n" style={{ fontSize: 18 }}>
              {layout.cols.get(t)!.length}
            </div>
            <div className="l">{TYPE_PLURAL[t]}</div>
          </div>
        ))}
        <div>
          <div className="n" style={{ fontSize: 18, color: pausedCount ? 'var(--red)' : undefined }}>
            {pausedCount}
          </div>
          <div className="l">paused now</div>
        </div>
        <div style={{ marginLeft: 'auto', fontSize: 12, maxWidth: 380, textAlign: 'right' }}>
          {sel ? (
            <>
              <b>{nodeLabel(sel)}</b> <span className="muted">· {sel.type} · {ownerLine(graph.owners, sel.owner_id)}</span>
              {sel.type === 'workflow' && (
                <>
                  {' '}
                  <Link to={`/workflows/${encodeURIComponent(sel.id)}`} style={{ color: 'var(--blue)' }}>
                    Open its agents →
                  </Link>
                </>
              )}
              <div className="muted">
                {DETAIL_FIELDS.filter((f) => sel[f] !== undefined && sel[f] !== null)
                  .map((f) => `${f}: ${Array.isArray(sel[f]) ? (sel[f] as string[]).join(', ') || '—' : String(sel[f])}`)
                  .join(' · ')}
              </div>
            </>
          ) : (
            <span className="muted">Click a node to see its links.</span>
          )}
        </div>
      </div>

      <div className="graph-canvas" onClick={() => setSelected(null)}>
        <svg width={LEFT + COLUMNS.length * COL_W} height={layout.height}>
          {COLUMNS.map((t, c) => (
            <text key={t} className="col-head" x={LEFT + c * COL_W + 60} y={20}>
              {TYPE_PLURAL[t].toUpperCase()}
            </text>
          ))}
          {graph.edges.map((e, i) => {
            const a = layout.pos.get(e.source)
            const b = layout.pos.get(e.target)
            if (!a || !b) return null
            const mx = (a.x + b.x) / 2
            const on = selected !== null && (e.source === selected || e.target === selected)
            return (
              <path
                key={i}
                className={`gedge ${on ? 'on' : ''}`}
                d={`M${a.x},${a.y} C${mx},${a.y} ${mx},${b.y} ${b.x},${b.y}`}
                opacity={selected && !on ? 0.25 : 1}
              />
            )
          })}
          {graph.nodes.map((n) => {
            const p = layout.pos.get(n.id)
            if (!p) return null
            const paused = n.type === 'workflow' && n.state === 'paused'
            const dim = selected !== null && !linked.has(n.id)
            return (
              <g
                key={n.id}
                className={`gnode ${n.id === selected ? 'on' : ''}`}
                opacity={dim ? 0.3 : 1}
                onClick={(ev) => {
                  ev.stopPropagation()
                  setSelected(n.id === selected ? null : n.id)
                }}
              >
                <circle cx={p.x} cy={p.y} r={paused ? 5 : 4} fill={paused ? 'var(--red)' : FILL[n.type]} opacity={n.type === 'workflow' && !paused ? 0.7 : 1} />
                <text x={p.x + 9} y={p.y + 3.5}>
                  {nodeLabel(n)}
                </text>
              </g>
            )
          })}
        </svg>
      </div>
    </div>
  )
}
