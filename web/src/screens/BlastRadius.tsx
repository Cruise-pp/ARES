import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, runCache } from '../api/client'
import { useAsync, useGraph } from '../api/hooks'
import type { Run } from '../api/types'
import { actAt, RadiusGraph, REVEAL, type NodeTone } from '../components/RadiusGraph'
import { formatElapsed, nodeLabel, plural, splitTitle } from '../lib/format'
import { radialLayout } from '../lib/layout'
import { resumeLog } from '../lib/local'
import { storySentence } from '../lib/story'
import { nextOf } from './TaskMessage'
import { abort, inFlight, land } from '../lib/handoff'
import { EASE, useCountUp, useMotionPref, zoomAbout } from '../lib/motion'
import { ACTION_HOPS, countVisible, MAX_HOPS, pathSteps, workflowRows, type WorkflowRow } from '../lib/reach'

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
    const window = Math.max(1, Math.min(elapsedMs, REVEAL.readoutEnd - REVEAL.readoutStart))
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
  const { reduced } = useMotionPref()
  const limit = ACTION_HOPS
  const [play, setPlay] = useState(0)
  const [phase, setPhase] = useState<Phase>('rest')
  const [epoch, setEpoch] = useState<number | null>(null)
  const [resumeOpen, setResumeOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resumed, setResumed] = useState<{ n: number; reason: string } | null>(null)
  const tasks = useAsync(() => Promise.all(run.tasks.map((t) => api.getTask(t))), [run.run_id, run.tasks.join()])
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

  const pausedRows = rows.filter((r) => r.status === 'paused')

  const rowsStart = Math.max(REVEAL.rowsStart, act + 200)
  const rowIn = (i: number) =>
    animate ? { className: 'row-in', style: { animationDelay: `${rowsStart + i * REVEAL.rowStep}ms` } } : { className: '', style: undefined }

  const dutiesOf = (wfId: string) =>
    reached
      .filter((r) => r.type === 'obligation' && r.path[r.path.length - 2] === wfId && r.hops <= ACTION_HOPS)
      .map((r) => nodeLabel(graphNodes.get(r.id), r.name))
  const stopRows = rows.filter((r) => r.status === (preview ? 'would_pause' : 'paused'))
  const warnRows = rows.filter((r) => r.status === (preview ? 'would_warn' : 'warned'))
  const backRows = rows.filter((r) => r.status === 'resumed')
  const sentence = storySentence({
    preview,
    paused: stopRows.map((r) => ({ name: r.name, duties: dutiesOf(r.id) })),
    warned: warnRows.map((r) => r.name),
    resumed: backRows.map((r) => r.name),
  })

  const nextFor = (wfId: string) => {
    const t = tasks.data?.find((x) => x.task.workflow_id === wfId)
    return t ? nextOf(t) : ''
  }

  const row = (r: WorkflowRow, i: number, quiet = false) => {
    const a = rowIn(i)
    const next = nextFor(r.id)
    return (
      <button
        key={r.id}
        className={`p-row ${quiet ? 'quiet' : r.status} ${focusParam === r.id ? 'on' : ''} ${a.className}`}
        style={a.style}
        onClick={() => drill(r.id)}
        onMouseEnter={() => setFocusParam(r.id)}
        onMouseLeave={() => setFocusParam(null)}
        title={`${r.owner} · open this workflow`}
      >
        <span className="p-name">{r.name}</span>
        {next && <span className="p-next">{next}</span>}
        <span className="chev">›</span>
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


  return (
    <>
      <div className="br-head">
        <Link to="/" className="back">
          ← New change
        </Link>
        <span className="cid">{title}</span>
        {subject && <span className="subject">{subject}</span>}
        {preview && <span className="subject">Preview · nothing pauses</span>}
        <div className="right">
          <span className={`when${animate ? ' hidden' : ''}`}>
            found in <strong>{formatElapsed(run.elapsed_ms)}</strong>
          </span>
        </div>
      </div>

      <div className={`br${leaving ? ' leaving' : ''}`}>
        <section className="br-stage" ref={stageRef}>
          {animate && !waiting && <div className="vignette impact-pulse" />}
          {animate && !waiting && acted && !preview && pausedN > 0 && <div className="vignette act-pulse" />}
          {animate && !waiting && (
            <div className={`tracer${acted ? ' done' : ''}`} style={acted ? { animationDelay: '500ms' } : undefined}>
              <div className="t">{formatElapsed(elapsed)}</div>
              <div className="l">{acted ? 'found' : 'tracing the graph'}</div>
            </div>
          )}

          {!animate && (
              <button className="btn ghost small replay" onClick={() => replay()} title="Replay the reveal">
                ↻ Replay
              </button>
            )}

          {focusItem && (
            <div className="path-strip" role="status">
              {pathSteps(focusItem, reached, graphNodes).map((s, i) => (
                <span key={s.id} style={{ display: 'contents' }}>
                  {i > 0 && <span className="verb">{s.verb} →</span>}
                  <span className="step">{s.label}</span>
                </span>
              ))}
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
            <span className="faint">Tap a workflow to see inside it</span>
          </div>
        </section>

        <aside className="br-side panel" ref={sideRef}>
          <div className="side-flow" key={String(epoch)} style={waiting ? { visibility: 'hidden' } : undefined}>
            <p className={`p-sentence ${rowIn(0).className}`} style={rowIn(0).style}>
              {sentence}
            </p>

            <div className={`p-numbers${animate && !acted ? ' waiting' : ''}${animate && acted ? ' counting' : ''}`}>
              <div>
                <b>{cAgents}</b>
                <span>{counts.agents === 1 ? 'agent' : 'agents'}</span>
              </div>
              <div>
                <b>{cWorkflows}</b>
                <span>{counts.workflows === 1 ? 'workflow' : 'workflows'}</span>
              </div>
              <div className={pausedN ? 'red' : ''}>
                <b>{cPaused}</b>
                <span>{preview ? 'would pause' : 'paused'}</span>
              </div>
              <div>
                <b>{cWarned}</b>
                <span>{preview ? 'would warn' : 'warned'}</span>
              </div>
            </div>

            {stopRows.length > 0 && <div className="p-list">{stopRows.map((r, i) => row(r, i + 1))}</div>}

            {(warnRows.length > 0 || backRows.length > 0) && (
              <div className="p-list">
                {warnRows.length > 0 && (
                  <div className={`p-caption ${rowIn(stopRows.length + 1).className}`} style={rowIn(stopRows.length + 1).style}>
                    {preview ? 'Would keep running, with a warning' : 'Still running, with a warning'}
                  </div>
                )}
                {warnRows.map((r, i) => row(r, stopRows.length + 2 + i, true))}
                {backRows.map((r, i) => row(r, stopRows.length + warnRows.length + 2 + i, true))}
              </div>
            )}

            <div className={`p-foot ${rowIn(rows.length + 3).className}`} style={rowIn(rows.length + 3).style}>
              {error && <div className="error-box">{error}</div>}
              {preview ? (
                <button
                  className="btn primary wide"
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
              ) : (
                <>
                  {run.tasks.length > 0 && (
                    <Link className="btn primary wide" to={`/runs/${encodeURIComponent(run.run_id)}/incident`}>
                      Send next steps
                    </Link>
                  )}
                  {pausedRows.length > 0 &&
                    (resumeOpen ? (
                      <form
                        className="resume-form"
                        onSubmit={(e) => {
                          e.preventDefault()
                          resumeAll()
                        }}
                      >
                        <input
                          autoFocus
                          placeholder="Why is it safe to resume? This goes in the record."
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          onKeyDown={(e) => e.key === 'Escape' && setResumeOpen(false)}
                        />
                        <button className="linkish strong" disabled={!reason.trim() || busy} type="submit">
                          Resume
                        </button>
                        <button className="linkish" type="button" onClick={() => setResumeOpen(false)}>
                          Cancel
                        </button>
                      </form>
                    ) : (
                      <button className="linkish center" onClick={() => setResumeOpen(true)}>
                        Resume instead…
                      </button>
                    ))}
                </>
              )}
            </div>
          </div>
        </aside>
      </div>
    </>
  )
}
