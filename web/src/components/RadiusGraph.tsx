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

/** Four sparks per node, fixed angles so frames are reproducible. */
const SPARKS = [-62, 18, 104, 200].map((deg) => {
  const r = (deg * Math.PI) / 180
  return { dx: Math.cos(r) * 17, dy: Math.sin(r) * 17 }
})

interface Props {
  layout: Layout
  tones: Map<string, NodeTone>
  limit: number
  actionHops: number
  /** The reveal is running; every element gets its page 25 delay. */
  animate: boolean
  /** Before impact: the frame holds still and the change node is not lit yet. */
  waiting?: boolean
  /** After the reveal: the slow radar and breathing glows. */
  ambient?: boolean
  flashIds: Set<string>
  focus: Set<string> | null
  onSelect: (id: string | null) => void
}

export function RadiusGraph({ layout, tones, limit, actionHops, animate, waiting, ambient, flashIds, focus, onSelect }: Props) {
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

  const liveEdges = layout.edges.filter((e) => !e.ghost && shownIds.has(e.to))
  const outer = layout.rings[layout.rings.length - 1]?.r ?? 250
  const cls = [animate ? 'anim' : '', waiting ? 'waiting' : '', ambient ? 'ambient' : ''].join(' ')

  return (
    <svg viewBox="0 0 640 640" className={cls} onClick={() => onSelect(null)} role="img" aria-label="Blast radius graph">
      <defs>
        <radialGradient id="halo">
          <stop offset="0%" stopColor="var(--red)" stopOpacity="0.32" />
          <stop offset="60%" stopColor="var(--red)" stopOpacity="0.06" />
          <stop offset="100%" stopColor="var(--red)" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="flare">
          <stop offset="0%" stopColor="#fff" stopOpacity="1" />
          <stop offset="22%" stopColor="#ff8da1" stopOpacity="0.9" />
          <stop offset="55%" stopColor="var(--red)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="var(--red)" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="sweep" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--red)" stopOpacity="0" />
          <stop offset="100%" stopColor="var(--red)" stopOpacity="0.16" />
        </linearGradient>
        <GlowFilter />
        <GlowFilter id="bloom" blur={6} pad={0.12} />
      </defs>

      <g className="camera" style={animate ? { animationDelay: `0ms, ${act}ms` } : undefined}>
        <circle className="halo-field" cx={CENTER} cy={CENTER} r={outer} fill="url(#halo)" />

        {layout.rings.map((r) => (
          <g key={r.index} opacity={r.index > limit + (layout.multiStart ? 1 : 0) ? 0.35 : 1}>
            <circle className="ring-guide" cx={CENTER} cy={CENTER} r={r.r} />
            <text className="ring-label" x={CENTER} y={CENTER - r.r - 6}>
              {r.label}
            </text>
          </g>
        ))}

        {ambient && (
          <g className="radar">
            <path d={`M${CENTER},${CENTER} L${CENTER + outer},${CENTER} A${outer},${outer} 0 0,0 ${CENTER + outer * Math.cos(0.7)},${CENTER - outer * Math.sin(0.7)} Z`} fill="url(#sweep)" />
          </g>
        )}

        <g className={`ghosts ${animate ? 'late' : ''}`} style={animate ? { animationDelay: `${act + 500}ms` } : undefined}>
          {layout.edges
            .filter((e) => e.ghost && shownIds.has(e.from) && shownIds.has(e.to))
            .map((e) => {
              const a = layout.byId.get(e.from)!
              const b = layout.byId.get(e.to)!
              return <line key={e.id} className="edge ghost" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
            })}
          {shown
            .filter((n) => n.ghost)
            .map((n) => (
              <g key={n.id}>
                <circle className="node ghost" cx={n.x} cy={n.y} r={4} />
                <text className="label ghost" x={n.x + (n.x >= CENTER ? 9 : -9)} y={n.y + 3.5} textAnchor={n.x >= CENTER ? 'start' : 'end'} fontSize={10}>
                  {n.label}
                </text>
              </g>
            ))}
        </g>

        {liveEdges.map((e) => {
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

        {animate && (
          <g className="comets">
            {liveEdges.map((e) => {
              const a = layout.byId.get(e.from)!
              const b = layout.byId.get(e.to)!
              return (
                <g key={e.id}>
                  <path
                    d={`M${a.x},${a.y} L${b.x},${b.y}`}
                    pathLength={1}
                    className="comet halo"
                    style={{ animationDelay: `${edgeDelay(b) - 40}ms`, stroke: fill(b.id) }}
                  />
                  <path d={`M${a.x},${a.y} L${b.x},${b.y}`} pathLength={1} className="comet core" style={{ animationDelay: `${edgeDelay(b) - 40}ms` }} />
                </g>
              )
            })}
          </g>
        )}

        {animate && (
          <g className="impact">
            <circle className="flare" cx={CENTER} cy={CENTER} r={70} fill="url(#flare)" />
            <circle className="shockwave bloom" cx={CENTER} cy={CENTER} r={262} filter="url(#bloom)" />
            <circle className="shockwave" cx={CENTER} cy={CENTER} r={262} />
            <circle className="shockwave late" cx={CENTER} cy={CENTER} r={262} />
          </g>
        )}

        {shown
          .filter((n) => !n.ghost && n.ring > 0)
          .map((n) => {
            const d = edgeDelay(n)
            const land = d + REVEAL.nodeAfterEdge
            const slam = animate && flashIds.has(n.id)
            const nodeAnim = anim(slam ? 'pop slam' : 'pop', land)
            if (slam) nodeAnim.style = { animationDelay: `${land}ms, ${act}ms` }
            const labelAnim = anim('fade', d + REVEAL.labelAfterEdge)
            const right = n.x >= CENTER - 1
            const tone = tones.get(n.id)
            const lit = tone === 'paused' || tone === 'start'
            const color = fill(n.id)
            return (
              <g key={n.id}>
                {flashIds.has(n.id) && n.hops <= limit && (
                  <circle className="breathe" cx={n.x} cy={n.y} r={9} style={{ animationDelay: animate ? `${act + 900}ms` : '0ms' }} />
                )}
                {animate && (
                  <g className="ignite" style={{ color }}>
                    <circle className="burst" cx={n.x} cy={n.y} r={8} style={{ animationDelay: `${land}ms` }} />
                    {SPARKS.map((s, i) => (
                      <circle
                        key={i}
                        className="spark"
                        cx={n.x}
                        cy={n.y}
                        r={1.6}
                        style={{ animationDelay: `${land + 20}ms`, ['--dx' as string]: `${s.dx}px`, ['--dy' as string]: `${s.dy}px` }}
                      />
                    ))}
                  </g>
                )}
                {slam && (
                  <g style={{ color }}>
                    <circle className="slam-ring" cx={n.x} cy={n.y} r={9} style={{ animationDelay: `${act}ms` }} />
                  </g>
                )}
                <circle
                  className={`node ${nodeAnim.className} ${lit ? 'glow' : ''} ${dimmed(n.id) ? 'dim' : ''}`}
                  cx={n.x}
                  cy={n.y}
                  r={tone === 'paused' ? 8.5 : 8}
                  style={{ ...nodeAnim.style, fill: color, opacity: n.hops > actionHops ? 0.5 : undefined }}
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
                {slam && (
                  <g transform={`translate(${n.x}, ${n.y - 24})`}>
                    <g className="stamp" style={{ animationDelay: `${act + 60}ms` }}>
                      <rect x={-29} y={-9} width={58} height={18} rx={4} />
                      <text y={4} textAnchor="middle">
                        PAUSED
                      </text>
                    </g>
                  </g>
                )}
              </g>
            )
          })}

        <g className="root">
          <circle className="halo root-halo" cx={CENTER} cy={CENTER} r={24} fill="var(--red)" opacity={0.18} />
          <circle
            className={`node glow root-core ${animate ? 'root-pop' : ''} ${dimmed(root.id) ? 'dim' : ''}`}
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
          <text className={`label start ${animate ? 'fade' : ''}`} style={animate ? { animationDelay: '260ms' } : undefined} x={CENTER} y={CENTER + 32} textAnchor="middle">
            {root.label}
          </text>
        </g>
      </g>
    </svg>
  )
}

/** A soft bloom behind lit nodes. Filters are static, so this costs nothing when motion is off. */
export function GlowFilter({ id = 'glow', blur = 3.2, pad = 1.5 }: { id?: string; blur?: number; pad?: number }) {
  return (
    <filter id={id} x={`${-pad * 100}%`} y={`${-pad * 100}%`} width={`${100 + pad * 200}%`} height={`${100 + pad * 200}%`}>
      <feGaussianBlur in="SourceGraphic" stdDeviation={blur} result="blur" />
      <feMerge>
        <feMergeNode in="blur" />
        <feMergeNode in="SourceGraphic" />
      </feMerge>
    </filter>
  )
}
