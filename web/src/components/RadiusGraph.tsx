import type { CSSProperties } from 'react'
import { CENTER, type LaidNode, type Layout } from '../lib/layout'

/** Page 25, to the millisecond. */
export const REVEAL = {
  ringStarts: [520, 1500, 2400],
  extraRingStep: 250,
  stagger: 70,
  nodeAfterEdge: 200,
  labelAfterEdge: 340,
  act: 3150,
  countersMs: 520,
  rowsStart: 3350,
  rowStep: 95,
  readoutStart: 520,
  readoutEnd: 4300,
}

export function ringStart(ring: number): number {
  if (ring <= 0) return 0
  if (ring <= REVEAL.ringStarts.length) return REVEAL.ringStarts[ring - 1]
  return REVEAL.ringStarts[REVEAL.ringStarts.length - 1] + (ring - REVEAL.ringStarts.length) * REVEAL.extraRingStep
}

export function actAt(maxRing: number): number {
  return Math.max(REVEAL.act, ringStart(maxRing) + 750)
}

export type NodeTone = 'start' | 'agent' | 'paused' | 'warned' | 'resumed' | 'blue' | 'neutral' | 'ghost'

const TONE_FILL: Record<NodeTone, string> = {
  start: 'var(--red)',
  agent: 'var(--amber)',
  paused: 'var(--red)',
  warned: 'var(--amber)',
  resumed: 'var(--green)',
  blue: 'var(--blue)',
  neutral: 'var(--muted)',
  ghost: 'var(--faint)',
}

interface Props {
  layout: Layout
  tones: Map<string, NodeTone>
  limit: number
  actionHops: number
  animate: boolean
  flashIds: Set<string>
  focus: Set<string> | null
  onSelect: (id: string | null) => void
}

export function RadiusGraph({ layout, tones, limit, actionHops, animate, flashIds, focus, onSelect }: Props) {
  const visible = (n: LaidNode) => n.ghost || n.ring === 0 || n.hops <= limit
  const shown = layout.nodes.filter(visible)
  const shownIds = new Set(shown.map((n) => n.id))
  const maxRing = Math.max(...layout.nodes.filter((n) => !n.ghost).map((n) => n.ring))
  const act = actAt(maxRing)

  const order = new Map<string, number>()
  const byRing = new Map<number, LaidNode[]>()
  for (const n of layout.nodes) {
    if (n.ghost || n.ring === 0) continue
    const list = byRing.get(n.ring) ?? []
    list.push(n)
    byRing.set(n.ring, list)
  }
  for (const list of byRing.values()) {
    list.sort((a, b) => a.angle - b.angle).forEach((n, i) => order.set(n.id, i))
  }
  const edgeDelay = (n: LaidNode) => ringStart(n.ring) + (order.get(n.id) ?? 0) * REVEAL.stagger

  const root = layout.nodes[0]
  const dimmed = (id: string) => focus !== null && !focus.has(id)
  const fill = (id: string) => TONE_FILL[tones.get(id) ?? 'neutral']

  const anim = (cls: string, delay: number): { className: string; style: CSSProperties } =>
    animate ? { className: cls, style: { animationDelay: `${delay}ms` } } : { className: '', style: {} }

  return (
    <svg
      viewBox="0 0 640 640"
      className={animate ? 'anim' : ''}
      onClick={() => onSelect(null)}
      role="img"
      aria-label="Blast radius graph"
    >
      <defs>
        <radialGradient id="halo">
          <stop offset="0%" stopColor="var(--red)" stopOpacity="0.32" />
          <stop offset="60%" stopColor="var(--red)" stopOpacity="0.06" />
          <stop offset="100%" stopColor="var(--red)" stopOpacity="0" />
        </radialGradient>
      </defs>

      <circle cx={CENTER} cy={CENTER} r={layout.rings[layout.rings.length - 1]?.r ?? 250} fill="url(#halo)" opacity={0.6} />

      {layout.rings.map((r) => (
        <g key={r.index} opacity={r.index > limit + (layout.multiStart ? 1 : 0) ? 0.35 : 1}>
          <circle className="ring-guide" cx={CENTER} cy={CENTER} r={r.r} />
          <text className="ring-label" x={CENTER} y={CENTER - r.r - 6}>
            {r.label}
          </text>
        </g>
      ))}

      {layout.edges
        .filter((e) => e.ghost && shownIds.has(e.from) && shownIds.has(e.to))
        .map((e) => {
          const a = layout.byId.get(e.from)!
          const b = layout.byId.get(e.to)!
          return <line key={e.id} className="edge ghost" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
        })}

      {layout.edges
        .filter((e) => !e.ghost && shownIds.has(e.to))
        .map((e) => {
          const a = layout.byId.get(e.from)!
          const b = layout.byId.get(e.to)!
          const onPath = focus?.has(e.from) && focus?.has(e.to)
          const a2 = anim('draw', edgeDelay(b))
          return (
            <path
              key={e.id}
              d={`M${a.x},${a.y} L${b.x},${b.y}`}
              pathLength={1}
              className={`edge ${a2.className} ${onPath ? 'hl' : ''} ${focus && !onPath ? 'dim' : ''}`}
              style={{ ...a2.style, stroke: fill(b.id), opacity: b.hops > actionHops ? 0.45 : undefined }}
            />
          )
        })}

      {shown
        .filter((n) => n.ghost)
        .map((n) => (
          <g key={n.id}>
            <circle className="node ghost" cx={n.x} cy={n.y} r={4} />
            <text
              className="label ghost"
              x={n.x + (n.x >= CENTER ? 9 : -9)}
              y={n.y + 3.5}
              textAnchor={n.x >= CENTER ? 'start' : 'end'}
              fontSize={10}
            >
              {n.label}
            </text>
          </g>
        ))}

      {animate && <circle className="shockwave" cx={CENTER} cy={CENTER} r={262} />}

      {shown
        .filter((n) => !n.ghost && n.ring > 0)
        .map((n) => {
          const d = edgeDelay(n)
          const flash = animate && flashIds.has(n.id)
          const nodeAnim = anim(flash ? 'flash' : 'pop', d + REVEAL.nodeAfterEdge)
          if (flash) nodeAnim.style = { animationDelay: `${d + REVEAL.nodeAfterEdge}ms, ${act}ms` }
          const labelAnim = anim('fade', d + REVEAL.labelAfterEdge)
          const right = n.x >= CENTER - 1
          return (
            <g key={n.id}>
              <circle
                className={`node ${nodeAnim.className} ${dimmed(n.id) ? 'dim' : ''}`}
                cx={n.x}
                cy={n.y}
                r={tones.get(n.id) === 'paused' ? 8.5 : 8}
                style={{ ...nodeAnim.style, fill: fill(n.id), opacity: n.hops > actionHops ? 0.5 : undefined }}
                onClick={(e) => {
                  e.stopPropagation()
                  onSelect(n.id)
                }}
              >
                <title>{n.label}</title>
              </circle>
              <text
                className={`label ${labelAnim.className} ${dimmed(n.id) ? 'dim' : ''}`}
                style={labelAnim.style}
                x={n.x + (right ? 13 : -13)}
                y={n.y + 4}
                textAnchor={right ? 'start' : 'end'}
              >
                {n.label}
              </text>
            </g>
          )
        })}

      <g>
        <circle className="halo" cx={CENTER} cy={CENTER} r={24} fill="var(--red)" opacity={0.18} />
        <circle
          className={`node ${dimmed(root.id) ? 'dim' : ''}`}
          cx={CENTER}
          cy={CENTER}
          r={14}
          style={{ fill: 'var(--red)' }}
          onClick={(e) => {
            e.stopPropagation()
            onSelect(root.id === '__change' ? null : root.id)
          }}
        >
          <title>{root.label}</title>
        </circle>
        <text className="label start" x={CENTER} y={CENTER + 32} textAnchor="middle">
          {root.label}
        </text>
      </g>
    </svg>
  )
}
