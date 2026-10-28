import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, Cond, CondValue, Graph, Kind, ParsedChange } from '../api/types'
import { KIND_LABEL, kindLabel, plural } from '../lib/format'

const OP_TEXT: Record<Cond['op'], string> = {
  eq: '',
  neq: 'not',
  in: 'in',
  not_in: 'not in',
  contains: 'contains',
  prefix: 'starts',
}

const conds = (c: ChangeEvent): Cond[] => ('all' in c.where ? c.where.all : c.where.any)

function withConds(c: ChangeEvent, next: Cond[]): ChangeEvent {
  return { ...c, where: 'all' in c.where ? { all: next } : { any: next } }
}

const show = (v: CondValue) => (Array.isArray(v) ? v.join(', ') : String(v))

function valuesFor(graph: Graph | null, change: ChangeEvent, cond: Cond): string[] {
  if (!graph) return []
  const ofType = graph.nodes.filter((n) => n.type === change.target)
  const others = conds(change).filter((c) => c !== cond && c.op === 'eq')
  const narrowed = ofType.filter((n) => others.every((c) => String(n[c.field]) === String(c.value)))
  const pool = narrowed.length ? narrowed : ofType
  const vals = new Set<string>()
  for (const n of pool) {
    const v = n[cond.field]
    if (Array.isArray(v)) v.forEach((x) => vals.add(String(x)))
    else if (v !== undefined && v !== null && v !== '') vals.add(String(v))
  }
  return [...vals].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
}

/** Agents that use or read a node, counted from the graph for the card (no search). */
export function usersOf(graph: Graph | null, id: string): number {
  if (!graph) return 0
  return graph.edges.filter((e) => e.target === id && (e.type === 'RUNS_ON' || e.type === 'READS')).filter((e) => graph.nodes.find((n) => n.id === e.source)?.type === 'agent').length
}

function Menu({ items, current, onPick, onClose }: { items: string[]; current: string; onPick: (v: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose()
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', esc)
    }
  }, [onClose])
  return (
    <div className="chip-menu" ref={ref} role="listbox">
      {items.length === 0 && <div className="faint" style={{ padding: 8, fontSize: 12 }}>The graph holds no values.</div>}
      {items.map((v) => (
        <button
          key={v}
          className={v === current ? 'on' : ''}
          onClick={(e) => {
            e.stopPropagation()
            onPick(v)
          }}
        >
          {v}
        </button>
      ))}
    </div>
  )
}

interface Props {
  parsed: ParsedChange
  graph: Graph | null
  busy: boolean
  onEdit: (change: ChangeEvent) => void
  onPick: (candidateId: string) => void
  onFire?: () => void
  onPreview?: () => void
  onUnmatched?: () => void
  saved?: boolean
  fireLabel?: string
}

export function ReadCard({ parsed, graph, busy, onEdit, onPick, onFire, onPreview, onUnmatched, saved, fireLabel = 'Fire' }: Props) {
  const [open, setOpen] = useState<string | null>(null)
  const { change, state } = parsed

  if (state === 'none') {
    return (
      <div className="readcard none">
        <div className="eyebrow">Nothing in the graph matches</div>
        <p className="readback" style={{ marginTop: 0 }}>{parsed.reason ?? parsed.readback}</p>
        {onUnmatched &&
          (saved ? (
            <span className="faint" style={{ fontSize: 13 }}>Kept for a person to read.</span>
          ) : (
            <button className="btn small" onClick={onUnmatched}>
              Keep it for a person
            </button>
          ))}
      </div>
    )
  }

  if (state === 'ambiguous') {
    return (
      <div className="readcard ambiguous">
        <div className="eyebrow">Which one did you mean?</div>
        <p className="readback" style={{ marginTop: 0 }}>{parsed.readback}</p>
        {parsed.candidates.map((c) => {
          const n = usersOf(graph, c.id)
          return (
            <button key={c.id} className="candidate" onClick={() => onPick(c.id)} disabled={busy}>
              <span>{c.label}</span>
              <span className="muted">{plural(n, 'agent')}</span>
            </button>
          )
        })}
        <div className="faint" style={{ fontSize: 12, marginTop: 8 }}>
          Fire stays off until you pick one.
        </div>
      </div>
    )
  }

  const cs = conds(change)
  const { effect } = change
  return (
    <div className="readcard exact">
      <div className="chips rc-sentence">
        <span className="rc-word">Radius read this as a</span>
        <span className="chip kind editable" onClick={() => setOpen('kind')}>
          {kindLabel(change.kind).toLowerCase()} ▾
          {open === 'kind' && (
            <Menu
              items={Object.values(KIND_LABEL)}
              current={kindLabel(change.kind)}
              onClose={() => setOpen(null)}
              onPick={(label) => {
                setOpen(null)
                const kind = (Object.keys(KIND_LABEL) as Kind[]).find((k) => KIND_LABEL[k] === label)!
                onEdit({ ...change, kind })
              }}
            />
          )}
        </span>
        <span className="rc-word">in</span>
        {cs.map((c, i) => {
          const key = `c${i}`
          return (
            <span key={key} className="chip editable" title={`${change.target}.${c.field} ${c.op}`} onClick={() => setOpen(key)}>
              {cs.length > 1 && c.field !== 'name' && <span className="op field">{c.field}</span>}
              {OP_TEXT[c.op] && <span className="op">{OP_TEXT[c.op]}</span>}
              {show(c.value)}
              {open === key && (
                <Menu
                  items={valuesFor(graph, change, c)}
                  current={show(c.value)}
                  onClose={() => setOpen(null)}
                  onPick={(v) => {
                    setOpen(null)
                    const value: CondValue = c.op === 'in' || c.op === 'not_in' ? [v] : v
                    onEdit(withConds(change, cs.map((x) => (x === c ? { ...x, value } : x))))
                  }}
                />
              )}
            </span>
          )
        })}
        {effect.fix && (
          <>
            <span className="rc-word">fixed in</span>
            <span className="chip">{effect.fix}</span>
          </>
        )}
        {effect.label && (
          <>
            <span className="rc-word">now</span>
            <span className="chip">{effect.label}</span>
          </>
        )}
        {effect.ref && <span className="rc-word muted">{effect.ref}</span>}
      </div>
      <div
        className="readback"
        title={change.parse ? `read by ${change.parse.by}${change.parse.confidence !== undefined ? ` · confidence ${change.parse.confidence}` : ''}` : undefined}
      >
        {parsed.readback}
      </div>
      <div className="actions">
        {onFire && (
          <button className="btn primary" onClick={onFire} disabled={busy}>
            {fireLabel}
          </button>
        )}
        {onPreview && (
          <button className="btn" onClick={onPreview} disabled={busy}>
            Preview
          </button>
        )}
      </div>
    </div>
  )
}

/** Turn a picked candidate into an exact selector, using the fields the graph holds for it. */
export function pinCandidate(change: ChangeEvent, graph: Graph | null, id: string): ChangeEvent {
  const node = graph?.nodes.find((n) => n.id === id)
  if (!node) return withConds(change, [{ field: 'id', op: 'eq', value: id }])
  const fields = conds(change).map((c) => c.field)
  const pinned: Cond[] = fields
    .filter((f) => node[f] !== undefined)
    .map((f) => ({ field: f, op: 'eq' as const, value: String(node[f]) }))
  if (node.type === 'tool' && node.version && !pinned.some((c) => c.field === 'version')) {
    pinned.push({ field: 'version', op: 'eq', value: node.version })
  }
  return { ...change, where: { all: pinned.length ? pinned : [{ field: 'id', op: 'eq', value: id }] } }
}
