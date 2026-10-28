import type { CSSProperties } from 'react'
import { PILL_H, PILL_W, type Flow, type FlowNode } from '../lib/flow'
import { GlowFilter } from './RadiusGraph'

/** The drill-down reveal: the same beat as page 25, one column at a time instead of one ring. */
export const FLOW_REVEAL = { first: 520, step: 620, nodeAfterEdge: 200, stagger: 60 }

export function beatStart(beat: number): number {
  return beat <= 0 ? 0 : FLOW_REVEAL.first + (beat - 1) * FLOW_REVEAL.step
}

export function flowActAt(beats: number): number {
  return beatStart(Math.max(1, beats - 1)) + 750
}

export type FlowTone = 'red' | 'amber' | 'green' | 'blue'

interface Props {
  flow: Flow
  tones: Map<string, FlowTone>
  animate: boolean
  breathing: Set<string>
  selected: string | null
  onSelect: (id: string | null) => void
}

const short = (s: string) => (s.length > 19 ? `${s.slice(0, 18)}…` : s)

export function WorkflowGraph({ flow, tones, animate, breathing, selected, onSelect }: Props) {
  const order = new Map<string, number>()
  const byCol = new Map<number, FlowNode[]>()
  for (const n of flow.nodes) {
    if (!n.lit) continue
    byCol.set(n.col, [...(byCol.get(n.col) ?? []), n])
  }
  for (const list of byCol.values()) list.sort((a, b) => a.y - b.y).forEach((n, i) => order.set(n.id, i))
  const delay = (n: FlowNode) => beatStart(n.beat) + (order.get(n.id) ?? 0) * FLOW_REVEAL.stagger
  const act = flowActAt(flow.beats)

  const anim = (cls: string, ms: number): { className: string; style: CSSProperties } =>
    animate ? { className: cls, style: { animationDelay: `${ms}ms` } } : { className: '', style: {} }

  const tone = (id: string) => tones.get(id) ?? 'amber'
  const path = new Set<string>()
  if (selected) {
    // Highlight everything upstream of the selected node that is lit.
    const stack = [selected]
    while (stack.length) {
      const id = stack.pop()!
      if (path.has(id)) continue
      path.add(id)
      flow.edges.filter((e) => e.to === id && e.lit).forEach((e) => stack.push(e.from))
    }
  }
  const dim = (id: string) => selected !== null && !path.has(id)

  return (
    <svg
      viewBox={`0 0 ${flow.width} ${flow.height}`}
      className={`flow ${animate ? 'anim' : ''}`}
      onClick={() => onSelect(null)}
      role="img"
      aria-label={`${flow.workflow?.name ?? 'Workflow'}, agents and sub-agents`}
    >
      <defs>
        <GlowFilter id="flow-glow" />
      </defs>

      {flow.columns.map((c) => (
        <text key={c.col} className="col-label" x={c.x} y={20} textAnchor="middle">
          {c.label}
        </text>
      ))}

      {flow.edges.map((e) => {
        const a = flow.byId.get(e.from)!
        const b = flow.byId.get(e.to)!
        const x1 = a.x + PILL_W / 2
        const x2 = b.x - PILL_W / 2
        const mx = (x1 + x2) / 2
        const d = `M${x1},${a.y} C${mx},${a.y} ${mx},${b.y} ${x2},${b.y}`
        if (!e.lit) return <path key={e.id} d={d} className={`flow-edge ${dim(e.to) ? 'dim' : ''}`} />
        const an = anim('draw', delay(b))
        return (
          <path
            key={e.id}
            d={d}
            pathLength={1}
            className={`flow-edge lit t-${tone(b.id)} ${an.className} ${dim(e.to) || dim(e.from) ? 'dim' : ''}`}
            style={an.style}
          />
        )
      })}

      {flow.nodes.map((n) => {
        const an = anim(n.beat === 0 ? 'pill-start' : 'pill-in', n.beat === 0 ? 0 : delay(n) + FLOW_REVEAL.nodeAfterEdge)
        if (animate && breathing.has(n.id)) {
          an.className = 'pill-in pill-flash'
          an.style = { animationDelay: `${delay(n) + FLOW_REVEAL.nodeAfterEdge}ms, ${act}ms` }
        }
        const t = tone(n.id)
        const isWf = n.type === 'workflow'
        return (
          <g
            key={n.id}
            transform={`translate(${n.x},${n.y})`}
            className={`pill-g ${dim(n.id) ? 'dim' : ''} ${selected === n.id ? 'sel' : ''}`}
            onClick={(e) => {
              e.stopPropagation()
              onSelect(n.id)
            }}
          >
            <title>{`${n.label} · ${n.type === 'subagent' ? 'sub-agent' : n.type}${n.lit ? ' · reached' : ' · not reached'}`}</title>
            <rect className={`pill ${isWf ? 'wf' : ''}`} x={-PILL_W / 2} y={-PILL_H / 2} width={PILL_W} height={PILL_H} rx={PILL_H / 2} />
            {!n.lit && (
              <text className="pill-label" y={4} textAnchor="middle">
                {short(n.label)}
              </text>
            )}
            {n.lit && (
              <g className={an.className} style={an.style}>
                {breathing.has(n.id) && (
                  <rect
                    className="breathe-pill"
                    x={-PILL_W / 2}
                    y={-PILL_H / 2}
                    width={PILL_W}
                    height={PILL_H}
                    rx={PILL_H / 2}
                    style={{ animationDelay: animate ? `${act + 600}ms` : '0ms' }}
                  />
                )}
                <rect
                  className={`pill lit t-${t}`}
                  x={-PILL_W / 2}
                  y={-PILL_H / 2}
                  width={PILL_W}
                  height={PILL_H}
                  rx={PILL_H / 2}
                  filter={n.beat === 0 || breathing.has(n.id) ? 'url(#flow-glow)' : undefined}
                />
                <text className="pill-label lit" y={4} textAnchor="middle">
                  {short(n.label)}
                </text>
              </g>
            )}
          </g>
        )
      })}
    </svg>
  )
}
