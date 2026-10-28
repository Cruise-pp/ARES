import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { api, runCache } from '../api/client'
import { useAsync, useGraph } from '../api/hooks'
import type { Run } from '../api/types'
import { flowActAt, WorkflowGraph, type FlowTone } from '../components/WorkflowGraph'
import { plural, splitTitle } from '../lib/format'
import { workflowFlow } from '../lib/flow'
import { joinNames } from '../lib/story'
import { nextOf } from './TaskMessage'
import { EASE, useMotionPref, zoomAbout } from '../lib/motion'
import { MAX_HOPS, pathSteps, workflowRows, type WorkflowStatus } from '../lib/reach'

const STATUS_PHRASE: Partial<Record<WorkflowStatus, string>> = {
  paused: 'is paused',
  would_pause: 'would pause',
  warned: 'keeps running, with a warning',
  would_warn: 'would keep running, with a warning',
  resumed: 'is running again',
  beyond: 'is reached, but too far away to act on',
}

const STATUS_TEXT: Partial<Record<WorkflowStatus, string>> = {
  paused: 'Paused',
  would_pause: 'Would pause',
  warned: 'Running, with a warning',
  would_warn: 'Would warn',
  resumed: 'Running again',
  beyond: 'Shown, not acted on',
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
  const { reduced } = useMotionPref()
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

  const wfName = flow.workflow?.name ?? wfId
  const duties = flow.nodes.filter((n) => n.type === 'obligation' && n.lit).map((n) => n.label)
  const hitSubs = hit.filter((n) => n.type === 'subagent')
  const hitAgents = hit.filter((n) => n.type === 'agent')
  const carried = [...new Set(hit.flatMap((n) => carriers(n.id)))]
  const head = !run
    ? `${wfName} runs ${plural(members.length - subCount, 'agent')} with ${plural(subCount, 'sub-agent')}.`
    : `${wfName} ${STATUS_PHRASE[status ?? 'none'] ?? 'is reached'}${duties.length ? `, and it serves ${joinNames(duties)}` : ''}.`
  const inside =
    run && carried.length
      ? hitSubs.length
        ? ` ${joinNames(hitSubs.map((n) => n.label))}, inside ${joinNames(hitAgents.map((n) => n.label))}, ${hitSubs.length === 1 ? 'uses' : 'use'} ${joinNames(carried)}.`
        : ` ${joinNames(hitAgents.map((n) => n.label))} ${hitAgents.length === 1 ? 'uses' : 'use'} ${joinNames(carried)}.`
      : ''
  const next = task && tasks.data ? nextOf(tasks.data.find((t) => t.task.id === task.id)!) : ''

  const selItem = selected ? run?.reached.find((r) => r.id === selected) : undefined
  const selNode = selected ? flow.byId.get(selected) : undefined

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
        {status && STATUS_TEXT[status] && <span className={`state-word ${status}`}>{STATUS_TEXT[status]}</span>}
      </div>

      <div className="br drill">
        <section className="br-stage flow-stage" ref={stageRef}>
          {run &&
            !animate && (
              <button className="btn ghost small replay" onClick={() => setPlay((p) => p + 1)}>
                ↻ Replay
              </button>
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

        <aside className="br-side panel">
          <p className={`p-sentence ${rowAnim(0).className}`} style={rowAnim(0).style}>
            {head}
          </p>
          {inside && <p className="p-sub">{inside.trim()}</p>}

          <div className="p-numbers two">
            <div>
              <b>{run ? hit.length : members.length - subCount}</b>
              <span>{run ? 'reached inside' : members.length - subCount === 1 ? 'agent' : 'agents'}</span>
            </div>
            <div>
              <b>{run ? safe.length : subCount}</b>
              <span>{run ? 'untouched' : 'sub-agents'}</span>
            </div>
          </div>

          {run && hit.length > 0 && (
            <div className="p-list">
              {hit.map((n, i) => {
                const a = rowAnim(i + 1)
                const via = carriers(n.id)
                return (
                  <button
                    key={n.id}
                    className={`p-row reached ${selected === n.id ? 'on' : ''} ${a.className}`}
                    style={a.style}
                    onClick={() => setSelected(selected === n.id ? null : n.id)}
                  >
                    <span className="p-name">{n.label}</span>
                    <span className="p-next">
                      {via.length ? `Uses ${via.join(', ')}` : `Reached through its sub-agents`}
                    </span>
                    <span className="chev">›</span>
                  </button>
                )
              })}
            </div>
          )}

          {safe.length > 0 && (
            <div className={`p-caption ${rowAnim(hit.length + 1).className}`} style={rowAnim(hit.length + 1).style}>
              {run ? 'Untouched: ' : 'Inside: '}
              {safe.map((n) => n.label).join(', ')}
            </div>
          )}

          <div className={`p-foot ${rowAnim(hit.length + 2).className}`} style={rowAnim(hit.length + 2).style}>
            {task && next && <div className="p-step">{next}</div>}
            {task && (
              <Link className="btn primary wide" to={`/task/${encodeURIComponent(task.id)}`}>
                Send this next step
              </Link>
            )}
            {others.length > 0 && (
              <div className="p-caption center">
                Also reached:{' '}
                {others.map((o, i) => (
                  <span key={o.id}>
                    {i > 0 && ', '}
                    <a href="#" className={`inline-link ${o.status}`} onClick={leave(`${base}/workflows/${encodeURIComponent(o.id)}`, { zoomIn: { x: 0, y: 0 } })}>
                      {o.name}
                    </a>
                  </span>
                ))}
              </div>
            )}
          </div>
        </aside>
      </div>
    </>
  )
}

