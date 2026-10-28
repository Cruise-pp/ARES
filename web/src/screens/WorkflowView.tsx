import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { api, runCache } from '../api/client'
import { useAsync, useGraph } from '../api/hooks'
import type { Run } from '../api/types'
import { flowActAt, WorkflowGraph, type FlowTone } from '../components/WorkflowGraph'
import { ownerName, plural, splitTitle } from '../lib/format'
import { workflowFlow } from '../lib/flow'
import { EASE, setMotionPref, useMotionPref, zoomAbout } from '../lib/motion'
import { MAX_HOPS, pathSteps, workflowRows, type WorkflowStatus } from '../lib/reach'

const STATUS_BADGE: Partial<Record<WorkflowStatus, { text: string; cls: string }>> = {
  paused: { text: 'PAUSED', cls: 'high' },
  would_pause: { text: 'WOULD PAUSE', cls: 'high' },
  warned: { text: 'WARNED', cls: 'warned' },
  would_warn: { text: 'WOULD WARN', cls: 'warned' },
  resumed: { text: 'RESUMED', cls: 'resumed' },
  beyond: { text: 'BEYOND 4 HOPS', cls: 'preview' },
}

export function WorkflowView() {
  const { runId, wfId = '' } = useParams()
  const { graph, error } = useGraph()
  const runState = useAsync(() => (runId ? api.getRun(runId) : Promise.resolve(null)), [runId], runId ? (runCache.get(runId) ?? null) : null)

  if (error) return <main className="page"><div className="error-box">{error.message}</div></main>
  if (runState.error) return <main className="page"><div className="error-box">Radius has no run “{runId}”. {runState.error.message}</div></main>
  if (!graph || (runId && !runState.data)) return <div className="loading">Opening the workflow…</div>
  if (!graph.nodes.some((n) => n.id === wfId && n.type === 'workflow')) {
    return (
      <main className="page">
        <div className="error-box">The graph has no workflow “{wfId}”.</div>
      </main>
    )
  }
  return <WorkflowScene key={`${runId}-${wfId}`} run={runState.data ?? null} wfId={wfId} graph={graph} />
}

function WorkflowScene({ run, wfId, graph }: { run: Run | null; wfId: string; graph: NonNullable<ReturnType<typeof useGraph>['graph']> }) {
  const navigate = useNavigate()
  const { nodes: graphNodes } = useGraph()
  const { pref, reduced, systemReduced } = useMotionPref()
  const [play, setPlay] = useState(0)
  const [animate, setAnimate] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const location = useLocation()
  const stageRef = useRef<HTMLElement>(null)
  const zoomIn = (location.state as { zoomIn?: { x: number; y: number } } | null)?.zoomIn

  const lit = useMemo(() => new Set(run?.reached.map((r) => r.id) ?? []), [run])
  const flow = useMemo(() => workflowFlow(wfId, graph, lit), [wfId, graph, lit])
  const act = flowActAt(flow.beats)
  const row = run ? workflowRows(run, graph, MAX_HOPS).find((r) => r.id === wfId) : undefined
  const others = run ? workflowRows(run, graph, MAX_HOPS).filter((r) => r.id !== wfId) : []
  const tasks = useAsync(
    () => (run && run.tasks.length ? Promise.all(run.tasks.map((t) => api.getTask(t))) : Promise.resolve([])),
    [run?.run_id],
  )
  const task = tasks.data?.find((t) => t.task.workflow_id === wfId)?.task

  useEffect(() => {
    if (reduced || !run || flow.beats === 0) {
      setAnimate(false)
      return
    }
    setAnimate(true)
    const t = setTimeout(() => setAnimate(false), act + 900)
    return () => clearTimeout(t)
  }, [play, reduced, run, act, flow.beats])

  const wfPoint = () => {
    const r = stageRef.current?.querySelector(`[data-id="${wfId}"]`)?.getBoundingClientRect()
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: innerWidth / 2, y: innerHeight / 2 }
  }

  // Arrive as if the camera flew into the workflow node you tapped.
  useLayoutEffect(() => {
    const svg = stageRef.current?.querySelector('svg')
    if (!zoomIn || !svg) return
    const a = zoomAbout(svg, wfPoint(), [0.45, 0], [1, 1], 480, EASE.out)
    const side = document.querySelector('.br.drill .br-side')
    const b = side?.animate([{ opacity: 0, transform: 'translateX(24px)' }, { opacity: 1, transform: 'none' }], {
      duration: 420,
      delay: 160,
      easing: EASE.out,
      fill: 'backwards',
    })
    return () => {
      a.cancel()
      b?.cancel()
    }
  }, [])

  const leave = (to: string, state?: unknown) => (e: React.MouseEvent) => {
    e.preventDefault()
    const svg = stageRef.current?.querySelector('svg')
    if (!svg || reduced) return navigate(to, { state })
    zoomAbout(svg, wfPoint(), [1, 1], [0.3, 0], 340, EASE.inOut).finished.then(() => navigate(to, { state }), () => undefined)
  }

  const status = row?.status
  const wfTone: FlowTone = status === 'paused' || status === 'would_pause' ? 'red' : status === 'resumed' ? 'green' : 'amber'
  const startIds = new Set(run?.reached.filter((r) => r.hops === 0).map((r) => r.id) ?? [])
  const tones = new Map<string, FlowTone>()
  for (const n of flow.nodes) {
    if (startIds.has(n.id)) tones.set(n.id, 'red')
    else if (n.type === 'workflow') tones.set(n.id, wfTone)
    else if (n.type === 'output' || n.type === 'obligation') tones.set(n.id, 'blue')
    else tones.set(n.id, 'amber')
  }
  const breathing = new Set(status === 'paused' ? [wfId] : [])

  const members = flow.nodes.filter((n) => n.type === 'agent' || n.type === 'subagent')
  const hit = members.filter((n) => n.lit)
  const safe = members.filter((n) => !n.lit)
  const subCount = members.filter((n) => n.type === 'subagent').length
  const [title] = splitTitle(run?.change.title ?? '')

  const carriers = (id: string) =>
    flow.edges.filter((e) => e.to === id && e.lit && flow.byId.get(e.from)!.col === 0).map((e) => flow.byId.get(e.from)!.label)
  const parentOf = (id: string) => {
    const e = flow.edges.find((x) => x.from === id && flow.byId.get(x.to)?.type !== 'workflow')
    return e ? flow.byId.get(e.to)?.label : undefined
  }

  const selItem = selected ? run?.reached.find((r) => r.id === selected) : undefined
  const selNode = selected ? flow.byId.get(selected) : undefined
  const skipped = reduced && pref === 'system' && systemReduced && !!run

  const base = run ? `/runs/${encodeURIComponent(run.run_id)}` : null
  const rowAnim = (i: number) =>
    animate ? { className: 'row-in', style: { animationDelay: `${act + 150 + i * 95}ms` } } : { className: '', style: undefined }

  return (
    <>
      <div className="br-head">
        {base ? (
          <Link to={base} className="back" onClick={leave(base, { settled: true, zoomOut: wfId })}>
            ← {title || 'Blast radius'}
          </Link>
        ) : (
          <Link to="/graph" className="back">
            ← The whole graph
          </Link>
        )}
        <span className="cid">{flow.workflow?.name}</span>
        <span className="subject">{plural(members.length - subCount, 'agent')} · {plural(subCount, 'sub-agent')}</span>
        {status && STATUS_BADGE[status] && <span className={`badge ${STATUS_BADGE[status]!.cls}`}>{STATUS_BADGE[status]!.text}</span>}
      </div>

      <div className="br drill">
        <section className="br-stage flow-stage" ref={stageRef}>
          {skipped ? (
            <div className="motion-banner">
              Your system asks for less motion, so the reveal was skipped.
              <button
                className="motion-play"
                onClick={() => {
                  setMotionPref('on')
                  setPlay((p) => p + 1)
                }}
              >
                ▶ Play the reveal
              </button>
            </div>
          ) : (
            run &&
            !animate && (
              <button className="btn ghost small replay" onClick={() => setPlay((p) => p + 1)}>
                ↻ Replay
              </button>
            )
          )}

          {selNode && (
            <div className="path-strip" role="status">
              {selItem ? (
                pathSteps(selItem, run!.reached, graphNodes).map((s, i) => (
                  <span key={s.id} style={{ display: 'contents' }}>
                    {i > 0 && <span className="verb">{s.verb} →</span>}
                    <span className="step">{s.label}</span>
                  </span>
                ))
              ) : (
                <span>
                  <span className="step">{selNode.label}</span>{' '}
                  <span className="faint">· not reached by this change</span>
                </span>
              )}
              <button className="close" onClick={() => setSelected(null)} aria-label="Close path">
                ✕
              </button>
            </div>
          )}

          <WorkflowGraph
            key={`${play}-${reduced}`}
            flow={flow}
            tones={tones}
            animate={animate}
            breathing={breathing}
            selected={selected}
            onSelect={setSelected}
          />

          <div className="overlay">
            <span className="legend">
              <i className="lg red" /> the change <i className="lg amber" /> reached <i className="lg grey" /> untouched
            </span>
          </div>
        </section>

        <aside className="br-side">
          {run ? (
            <div className="counters two">
              <div className="counter amber">
                <div className="n">{hit.length}</div>
                <div className="l">Reached inside</div>
              </div>
              <div className="counter">
                <div className="n">{safe.length}</div>
                <div className="l">Untouched</div>
              </div>
            </div>
          ) : (
            <div className="counters two">
              <div className="counter">
                <div className="n">{members.length - subCount}</div>
                <div className="l">Agents</div>
              </div>
              <div className="counter">
                <div className="n">{subCount}</div>
                <div className="l">Sub-agents</div>
              </div>
            </div>
          )}

          {run && hit.length > 0 && (
            <section>
              <div className={`group-title amber ${rowAnim(0).className}`} style={rowAnim(0).style}>
                Reached
              </div>
              {hit.map((n, i) => {
                const a = rowAnim(i + 1)
                const via = carriers(n.id)
                const parent = n.type === 'subagent' ? parentOf(n.id) : undefined
                return (
                  <button
                    key={n.id}
                    className={`wf-item warned ${selected === n.id ? 'on' : ''} ${a.className}`}
                    style={a.style}
                    onClick={() => setSelected(selected === n.id ? null : n.id)}
                  >
                    <div className="name">
                      <span>{n.label}</span>
                      <span className="faint" style={{ fontWeight: 400, fontSize: 11 }}>
                        {n.type === 'subagent' ? 'sub-agent' : 'agent'}
                      </span>
                    </div>
                    <div className="detail">
                      {[via.length ? `uses ${via.join(', ')}` : null, parent ? `inside ${parent}` : null].filter(Boolean).join(' · ') ||
                        'reached through its sub-agents'}
                    </div>
                  </button>
                )
              })}
            </section>
          )}

          {safe.length > 0 && (
            <div className={`safe-list ${rowAnim(hit.length + 1).className}`} style={rowAnim(hit.length + 1).style}>
              <div className="group-title grey">{run ? 'Untouched' : 'Inside'}</div>
              {safe.map((n) => n.label).join(' · ')}
            </div>
          )}

          <div className={`side-foot ${rowAnim(hit.length + 2).className}`} style={rowAnim(hit.length + 2).style}>
            <div className="duty-line">Owner · {ownerName(flow.workflow?.owner_id)}</div>
            <div className="quiet-links">
              {task && <Link to={`/task/${encodeURIComponent(task.id)}`}>Owner message →</Link>}
              {base && run!.incidents.length > 0 && <Link to={`${base}/incident`}>Incident →</Link>}
            </div>
            {others.length > 0 && (
              <div className="switcher">
                {others.map((o) => (
                  <button key={o.id} className={`chip-btn ${o.status}`} onClick={leave(`${base}/workflows/${encodeURIComponent(o.id)}`, { zoomIn: { x: 0, y: 0 } })}>
                    {o.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        </aside>
      </div>
    </>
  )
}

