import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, runCache } from '../api/client'
import { useAsync, useGraph } from '../api/hooks'
import type { Run } from '../api/types'
import { actAt, RadiusGraph, REVEAL, type NodeTone } from '../components/RadiusGraph'
import { nodeLabel, plural, splitTitle } from '../lib/format'
import { radialLayout } from '../lib/layout'
import { resumeLog } from '../lib/local'
import { abort, inFlight, land } from '../lib/handoff'
import { EASE, setMotionPref, useCountUp, useMotionPref, zoomAbout } from '../lib/motion'
import { ACTION_HOPS, countVisible, MAX_HOPS, pathSteps, workflowRows, type WorkflowRow, type WorkflowStatus } from '../lib/reach'

type Phase = 'rest' | 'firing' | 'rings' | 'acting' | 'settled'

export function useElapsedReadout(epoch: number | null, animate: boolean, elapsedMs: number) {
  const [ms, setMs] = useState(animate ? 0 : elapsedMs)
  useEffect(() => {
    if (!animate) {
      setMs(elapsedMs)
      return
    }
    if (epoch === null) {
      setMs(0)
      return
    }
    const window = Math.min(elapsedMs, REVEAL.readoutEnd - REVEAL.readoutStart)
    const t = setInterval(() => {
      const p = (performance.now() - epoch - REVEAL.readoutStart) / window
      if (p >= 1) {
        setMs(elapsedMs)
        clearInterval(t)
      } else setMs(Math.max(0, p) * elapsedMs)
    }, 60)
    return () => clearInterval(t)
  }, [epoch, animate, elapsedMs])
  return ms
}

const GROUPS_LIVE: { status: WorkflowStatus; title: string; tone: string }[] = [
  { status: 'paused', title: 'Paused', tone: 'red' },
  { status: 'warned', title: 'Warned · still running', tone: 'amber' },
  { status: 'resumed', title: 'Resumed by hand', tone: 'grey' },
  { status: 'beyond', title: `Beyond ${ACTION_HOPS} hops · not acted on`, tone: 'grey' },
]

const GROUPS_PREVIEW: { status: WorkflowStatus; title: string; tone: string }[] = [
  { status: 'would_pause', title: 'Would pause', tone: 'red' },
  { status: 'would_warn', title: 'Would warn', tone: 'amber' },
  { status: 'beyond', title: `Beyond ${ACTION_HOPS} hops · not acted on`, tone: 'grey' },
]

export function BlastRadius() {
  const { runId = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const location = useLocation()
  const entry = (location.state ?? {}) as { settled?: boolean; zoomOut?: string }
  const { graph, nodes, refresh } = useGraph()
  const runState = useAsync(() => api.getRun(runId), [runId], runCache.get(runId) ?? null)
  const run = runState.data

  useEffect(() => {
    refresh()
  }, [runId, refresh])

  if (runState.error) {
    abort()
    return (
      <main className="page">
        <div className="error-box">
          Radius has no run “{runId}”. {runState.error.message}
        </div>
        <p>
          <Link to="/" style={{ color: 'var(--blue)' }}>
            ← New change
          </Link>
        </p>
      </main>
    )
  }
  if (!run || !graph) return <div className="loading">Loading the blast radius…</div>

  return (
    <BlastRadiusView
      run={run}
      focusParam={params.get('focus')}
      setFocusParam={(id) => setParams(id ? { focus: id } : {}, { replace: true })}
      entry={entry}
      onDrill={(wfId, point) =>
        navigate(`/runs/${encodeURIComponent(run.run_id)}/workflows/${encodeURIComponent(wfId)}`, { state: { zoomIn: point } })
      }
      onFireLive={async () => {
        const live = await api.postChange(run.change, 'live')
        navigate(`/runs/${encodeURIComponent(live.run_id)}`)
      }}
      onResumed={async () => {
        refresh()
        runState.reload()
      }}
      graphNodes={nodes}
      graph={graph}
    />
  )
}

interface ViewProps {
  run: Run
  graph: NonNullable<ReturnType<typeof useGraph>['graph']>
  graphNodes: ReturnType<typeof useGraph>['nodes']
  focusParam: string | null
  setFocusParam: (id: string | null) => void
  entry: { settled?: boolean; zoomOut?: string }
  onDrill: (workflowId: string, point: { x: number; y: number }) => void
  onFireLive: () => Promise<void>
  onResumed: () => void
}

function BlastRadiusView({ run, graph, graphNodes, focusParam, setFocusParam, entry, onDrill, onFireLive, onResumed }: ViewProps) {
  const { pref, reduced, systemReduced } = useMotionPref()
  const [limit, setLimit] = useState(ACTION_HOPS)
  const [play, setPlay] = useState(0)
  const [phase, setPhase] = useState<Phase>('rest')
  const [epoch, setEpoch] = useState<number | null>(null)
  const [resumeOpen, setResumeOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resumed, setResumed] = useState<{ n: number; reason: string } | null>(null)
  const [leaving, setLeaving] = useState(false)
  const skipEntry = useRef(!!entry.settled)
  const stageRef = useRef<HTMLElement>(null)
  const sideRef = useRef<HTMLElement>(null)
  const preview = run.mode === 'preview'
  const [title, subject] = splitTitle(run.change.title ?? run.run_id)

  // The platform view shows agents, not their sub-agents; those open one level down, per workflow.
  const reached = useMemo(() => run.reached.filter((r) => r.type !== 'subagent'), [run.reached])
  const layout = useMemo(
    () => radialLayout(reached, graphNodes, graph.edges, { rootLabel: title }),
    [reached, graphNodes, graph.edges, title],
  )
  const maxRing = Math.max(...layout.nodes.filter((n) => !n.ghost).map((n) => n.ring))
  const act = actAt(maxRing)

  useEffect(() => {
    if (reduced || skipEntry.current) {
      abort()
      setEpoch(null)
      setPhase('settled')
      return
    }
    let cancelled = false
    const timers: number[] = []
    const start = () => {
      if (cancelled) return
      setEpoch(performance.now())
      setPhase('firing')
      timers.push(
        window.setTimeout(() => setPhase('rings'), REVEAL.ringStarts[0]),
        window.setTimeout(() => setPhase('acting'), act),
        window.setTimeout(() => setPhase('settled'), Math.max(REVEAL.readoutEnd, act + 2100)),
      )
    }
    setEpoch(null)
    setPhase('rest')
    if (inFlight()) {
      const core = stageRef.current?.querySelector('.root-core')?.getBoundingClientRect()
      if (core) land(core.left + core.width / 2, core.top + core.height / 2).then(start)
      else {
        abort()
        start()
      }
    } else timers.push(window.setTimeout(start, 60))
    return () => {
      cancelled = true
      timers.forEach(clearTimeout)
    }
  }, [run.run_id, play, reduced, act])

  // Coming back out of a workflow: the stage zooms back from the node you left.
  useLayoutEffect(() => {
    const svg = stageRef.current?.querySelector('svg')
    if (!entry.zoomOut || !svg) return
    const n = layout.byId.get(entry.zoomOut)
    if (!n) return
    const r = svg.getBoundingClientRect()
    const s = Math.min(r.width, r.height) / 640
    const point = { x: r.left + r.width / 2 + (n.x - 320) * s, y: r.top + r.height / 2 + (n.y - 320) * s }
    const a = zoomAbout(svg, point, [2.4, 0], [1, 1], 520, EASE.out)
    return () => a.cancel()
  }, [])

  const replay = () => {
    skipEntry.current = false
    setPlay((p) => p + 1)
  }

  const drill = (wfId: string) => {
    const svg = stageRef.current?.querySelector('svg')
    const n = layout.byId.get(wfId)
    if (!svg || !n || reduced) return onDrill(wfId, { x: 0, y: 0 })
    const r = svg.getBoundingClientRect()
    const s = Math.min(r.width, r.height) / 640
    const point = { x: r.left + r.width / 2 + (n.x - 320) * s, y: r.top + r.height / 2 + (n.y - 320) * s }
    setLeaving(true)
    setFocusParam(wfId)
    const a = zoomAbout(svg, point, [1, 1], [2.6, 0], 360, EASE.inOut)
    sideRef.current?.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateX(24px)' }], { duration: 300, easing: EASE.std, fill: 'forwards' })
    a.finished.then(() => onDrill(wfId, point), () => undefined)
  }

  const animate = !reduced && phase !== 'settled'
  const rows = workflowRows(run, graph, limit)
  const counts = countVisible(reached, run.verdicts, Math.min(limit, MAX_HOPS))
  const statusOf = new Map(rows.map((r) => [r.id, r.status]))

  const tones = new Map<string, NodeTone>()
  for (const r of reached) {
    if (r.hops === 0 && !layout.multiStart) tones.set(r.id, 'start')
    else if (r.type === 'agent' || r.type === 'tool' || r.type === 'data') tones.set(r.id, 'agent')
    else if (r.type === 'workflow') {
      const s = statusOf.get(r.id) ?? (r.hops > ACTION_HOPS ? 'beyond' : 'none')
      tones.set(r.id, s === 'paused' || s === 'would_pause' ? 'paused' : s === 'resumed' ? 'resumed' : 'warned')
    } else tones.set(r.id, 'blue')
  }

  const flashIds = useMemo(
    () => new Set(preview ? [] : rows.filter((r) => r.status === 'paused').map((r) => r.id)),
    [rows.map((r) => r.status).join(), preview],
  )

  const focusItem = focusParam ? reached.find((r) => r.id === focusParam) : undefined
  const focusSet = focusItem ? new Set(focusItem.path) : null
  if (focusSet && layout.multiStart) focusSet.add('__change')

  const elapsed = useElapsedReadout(epoch, animate, run.elapsed_ms)
  const cAgents = useCountUp(counts.agents, epoch, act, REVEAL.countersMs, animate)
  const cWorkflows = useCountUp(counts.workflows, epoch, act, REVEAL.countersMs, animate)
  const pausedN = rows.filter((r) => r.status === (preview ? 'would_pause' : 'paused')).length
  const warnedN = preview ? rows.filter((r) => r.status === 'would_warn').length : counts.warned
  const cPaused = useCountUp(pausedN, epoch, act, REVEAL.countersMs, animate)
  const cWarned = useCountUp(warnedN, epoch, act, REVEAL.countersMs, animate)
  const acted = !animate || phase === 'acting'
  const waiting = phase === 'rest' && animate
  const anyHigh = run.verdicts.some((v) => v.risk === 'high')

  const duties = reached.filter((r) => r.type === 'obligation' && r.hops <= Math.min(limit, ACTION_HOPS))
  const pausedRows = rows.filter((r) => r.status === 'paused')

  const groups = preview ? GROUPS_PREVIEW : GROUPS_LIVE
  const rowsStart = Math.max(REVEAL.rowsStart, act + 200)
  let rowIndex = 0
  const rowIn = (i: number) =>
    animate ? { className: 'row-in', style: { animationDelay: `${rowsStart + i * REVEAL.rowStep}ms` } } : { className: '', style: undefined }

  const renderRow = (r: WorkflowRow) => {
    const a = rowIn(rowIndex++)
    return (
      <button
        key={r.id}
        className={`wf-item ${r.status} ${focusParam === r.id ? 'on' : ''} ${a.className}`}
        style={a.style}
        onClick={() => drill(r.id)}
        onMouseEnter={() => setFocusParam(r.id)}
        onMouseLeave={() => setFocusParam(null)}
        title="Open this workflow"
      >
        <div className="name">
          <span>{r.name}</span>
          <span className="chev">›</span>
        </div>
        <div className="detail">{r.owner}</div>
      </button>
    )
  }

  const resumeAll = async () => {
    if (!reason.trim()) return
    setBusy(true)
    setError(null)
    try {
      await Promise.all(pausedRows.map((r) => api.resumeWorkflow(r.id, reason.trim())))
      for (const r of pausedRows) {
        resumeLog.add({ workflow_id: r.id, name: r.name, reason: reason.trim(), run_id: run.run_id, at: new Date().toISOString() })
      }
      setResumed({ n: pausedRows.length, reason: reason.trim() })
      setResumeOpen(false)
      setReason('')
      onResumed()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const skipped = reduced && pref === 'system' && systemReduced

  return (
    <>
      <div className="br-head">
        <Link to="/" className="back">
          ← New change
        </Link>
        <span className="cid">{title}</span>
        {subject && <span className="subject">{subject}</span>}
        {preview ? (
          <span className="badge preview">PREVIEW · NOTHING PAUSES</span>
        ) : (
          <span className={`badge ${anyHigh ? 'high' : 'warned'}`}>{anyHigh ? 'HIGH' : 'LOW'}</span>
        )}
        <div className="right">
          <span className={`when${animate ? ' hidden' : ''}`}>
            found in <strong>{(run.elapsed_ms / 1000).toFixed(1)}s</strong>
          </span>
        </div>
      </div>

      <div className={`br${leaving ? ' leaving' : ''}`}>
        <section className="br-stage" ref={stageRef}>
          {animate && !waiting && <div className="vignette impact-pulse" />}
          {animate && !waiting && acted && !preview && pausedN > 0 && <div className="vignette act-pulse" />}
          {animate && !waiting && (
            <div className={`tracer${acted ? ' done' : ''}`} style={acted ? { animationDelay: '500ms' } : undefined}>
              <div className="t">{(elapsed / 1000).toFixed(1)}s</div>
              <div className="l">{acted ? 'found' : 'tracing the graph'}</div>
            </div>
          )}
          {acted && pausedN > 0 && !preview && <div className="paused-pill">{pausedN} PAUSED</div>}
          {preview && <div className="paused-pill preview-pill">NOTHING PAUSES</div>}

          {skipped ? (
            <div className="motion-banner">
              Your system asks for less motion, so the reveal was skipped.
              <button
                className="motion-play"
                onClick={() => {
                  setMotionPref('on')
                  replay()
                }}
              >
                ▶ Play the reveal
              </button>
            </div>
          ) : (
            !animate && (
              <button className="btn ghost small replay" onClick={() => replay()} title="Replay the reveal">
                ↻ Replay
              </button>
            )
          )}

          {focusItem && (
            <div className="path-strip" role="status">
              {pathSteps(focusItem, reached, graphNodes).map((s, i) => (
                <span key={s.id} style={{ display: 'contents' }}>
                  {i > 0 && <span className="verb">{s.verb} →</span>}
                  <span className="step">{s.label}</span>
                </span>
              ))}
              <span className="faint" style={{ marginLeft: 6 }}>
                · {plural(focusItem.hops, 'hop')}
              </span>
              <button className="close" onClick={() => setFocusParam(null)} aria-label="Close path">
                ✕
              </button>
            </div>
          )}

          <RadiusGraph
            key={`${run.run_id}-${play}-${reduced}`}
            layout={layout}
            tones={tones}
            limit={limit}
            actionHops={ACTION_HOPS}
            animate={animate}
            waiting={waiting}
            ambient={!animate && !reduced}
            flashIds={flashIds}
            focus={focusSet}
            onSelect={(id) => {
              if (id && graphNodes.get(id)?.type === 'workflow') drill(id)
              else setFocusParam(id)
            }}
          />

          <div className={`overlay${animate ? ' hush' : ''}`}>
            <label className="hop-control">
              Hops <strong>{limit}</strong>
              <input
                type="range"
                min={1}
                max={MAX_HOPS}
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value))}
                aria-label="Hop limit"
              />
            </label>
            <span className="faint">Tap a workflow to open it</span>
          </div>
        </section>

        <aside className="br-side" ref={sideRef}>
          <div className={`counters${animate && !acted ? ' waiting' : ''}${animate && acted ? ' counting' : ''}`}>
            <div className="counter">
              <div className="n">{cAgents}</div>
              <div className="l">Agents</div>
            </div>
            <div className="counter">
              <div className="n">{cWorkflows}</div>
              <div className="l">Workflows</div>
            </div>
            <div className="counter red">
              <div className="n">{cPaused}</div>
              <div className="l">{preview ? 'Would pause' : 'Paused'}</div>
            </div>
            <div className="counter amber">
              <div className="n">{cWarned}</div>
              <div className="l">{preview ? 'Would warn' : 'Warned'}</div>
            </div>
          </div>

          <div className="side-flow" key={String(epoch)} style={waiting ? { visibility: 'hidden' } : undefined}>
          {rows.length === 0 && (
            <div className="muted" style={{ fontSize: 13 }}>
              {limit < 2 ? 'Move the hop limit up to see workflows.' : 'No workflow is reached. Nothing to pause. The check is recorded.'}
            </div>
          )}

          {groups.map((g) => {
            const list = rows
              .filter((r) => r.status === g.status)
              .sort((a, b) => (a.risk === b.risk ? a.name.localeCompare(b.name) : a.risk === 'high' ? -1 : 1))
            if (!list.length) return null
            const t = rowIn(rowIndex)
            return (
              <section key={g.status}>
                <div className={`group-title ${g.tone} ${t.className}`} style={t.style}>
                  {g.title}
                </div>
                {list.map(renderRow)}
              </section>
            )
          })}

          <div className={`side-foot ${rowIn(rows.length + 1).className}`} style={rowIn(rows.length + 1).style}>
            {duties.length > 0 && (
              <div className="duty-line">
                At risk: <span style={{ color: 'var(--blue)' }}>{duties.map((d) => nodeLabel(graphNodes.get(d.id), d.name)).join(' · ')}</span>
              </div>
            )}

            {error && <div className="error-box">{error}</div>}

            {preview ? (
              <button
                className="btn primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  try {
                    await onFireLive()
                  } catch (e) {
                    setError((e as Error).message)
                    setBusy(false)
                  }
                }}
              >
                Fire it live
              </button>
            ) : resumed && pausedRows.length === 0 ? (
              <div className="confirm" role="status">
                <span className="check">✓</span>
                <div>
                  <strong>{plural(resumed.n, 'workflow')} running again.</strong>
                  <div className="muted">“{resumed.reason}” is in the record.</div>
                </div>
              </div>
            ) : resumeOpen ? (
              <form
                className="resume-form"
                onSubmit={(e) => {
                  e.preventDefault()
                  resumeAll()
                }}
              >
                <input
                  autoFocus
                  placeholder="Why resume? This goes in the record."
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  onKeyDown={(e) => e.key === 'Escape' && setResumeOpen(false)}
                />
                <button className="btn" disabled={!reason.trim() || busy} type="submit">
                  Resume {pausedRows.length}
                </button>
                <button className="btn ghost" type="button" onClick={() => setResumeOpen(false)}>
                  Cancel
                </button>
              </form>
            ) : (
              <div className="quiet-links">
                {run.tasks.length > 0 && (
                  <Link to={`/runs/${encodeURIComponent(run.run_id)}/incident`}>Owners & next steps ({run.tasks.length}) →</Link>
                )}
                {pausedRows.length > 0 && (
                  <button className="linkish" onClick={() => setResumeOpen(true)}>
                    Resume…
                  </button>
                )}
              </div>
            )}
          </div>
          </div>
        </aside>
      </div>
    </>
  )
}
