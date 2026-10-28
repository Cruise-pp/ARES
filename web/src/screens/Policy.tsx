import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api, API_MODE } from '../api/client'
import { useGraph } from '../api/hooks'
import type { GraphNode, ParsedChange, Run } from '../api/types'
import { pinCandidate, ReadCard } from '../components/ReadCard'
import { nodeLabel, plural } from '../lib/format'
import { ACTION_HOPS, diffLists, type ListDiff } from '../lib/reach'

interface Lists {
  agents: string[]
  workflows: string[]
  paused: string[]
}

export function listsOf(run: Run): Lists {
  const within = run.reached.filter((r) => r.hops <= ACTION_HOPS)
  const high = new Set(run.verdicts.filter((v) => v.risk === 'high').map((v) => v.workflow_id))
  const workflows = within.filter((r) => r.type === 'workflow').map((r) => r.id)
  return {
    agents: within.filter((r) => r.type === 'agent').map((r) => r.id),
    workflows,
    paused:
      run.mode === 'preview'
        ? workflows.filter((id) => high.has(id))
        : run.verdicts.filter((v) => v.action === 'paused').map((v) => v.workflow_id),
  }
}

export function compareLists(predicted: Lists, actual: Lists): { agents: ListDiff; workflows: ListDiff; paused: ListDiff; match: boolean } {
  const agents = diffLists(predicted.agents, actual.agents)
  const workflows = diffLists(predicted.workflows, actual.workflows)
  const paused = diffLists(predicted.paused, actual.paused)
  return { agents, workflows, paused, match: agents.match && workflows.match && paused.match }
}

function Side({ run, kind, nodes }: { run: Run | null; kind: 'predict' | 'actual'; nodes: Map<string, GraphNode> }) {
  if (!run) {
    return (
      <div className="side-box pending">
        <div className="eyebrow" style={{ marginBottom: 10 }}>
          {kind === 'predict' ? 'Radius predicts' : 'After the team adopts it'}
        </div>
        <div style={{ fontSize: 13 }}>
          {kind === 'predict' ? 'Preview the draft rule to see what it would stop.' : 'Apply the rule to compare.'}
        </div>
      </div>
    )
  }
  const l = listsOf(run)
  const name = (id: string) => nodeLabel(nodes.get(id), id)
  const warn = l.workflows.length - l.paused.length
  return (
    <div className={`side-box ${kind}`}>
      <div className="eyebrow" style={{ marginBottom: 14 }}>
        {kind === 'predict' ? 'Radius predicts' : 'After the team adopts it'}
      </div>
      <div className="big">
        <b>{l.agents.length}</b>
        <span>{kind === 'predict' ? 'agents break the rule' : 'agents broke the rule'}</span>
      </div>
      <div className="big">
        <b className={l.paused.length ? 'red' : ''}>{l.paused.length}</b>
        <span>{kind === 'predict' ? 'workflows would pause' : 'workflows paused'}</span>
      </div>
      <div className="names">{l.agents.map(name).join(', ')}</div>
      {warn > 0 && (
        <div className="names quiet">
          {plural(warn, 'more workflow', 'more workflows')} {kind === 'predict' ? 'would get' : 'got'} a warning.
        </div>
      )}
      <Link className="inline-link" to={`/runs/${encodeURIComponent(run.run_id)}`} style={{ fontSize: 13, marginTop: 12, display: 'inline-block' }}>
        {kind === 'predict' ? 'See it on the graph' : 'See the run'}
      </Link>
    </div>
  )
}

export function Policy() {
  const { graph, nodes, refresh } = useGraph()
  const [text, setText] = useState('model.region must be EU')
  const [parsed, setParsed] = useState<ParsedChange | null>(null)
  const [predicted, setPredicted] = useState<Run | null>(null)
  const [actual, setActual] = useState<Run | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [forceDiff, setForceDiff] = useState(false)

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const preview = (p: ParsedChange) =>
    guard(async () => {
      setParsed(p)
      setActual(null)
      setPredicted(null)
      if (p.state !== 'exact') return
      setPredicted(await api.postChange({ ...p.change, kind: 'new_rule' }, 'preview'))
    })

  const readRule = () => guard(async () => preview(await api.parseChange(text)))

  const reread = (change: ParsedChange['change']) =>
    guard(async () => preview(await api.parseChange(JSON.stringify({ ...change, source: undefined, parse: undefined }))))

  const apply = () =>
    guard(async () => {
      if (!parsed || parsed.state !== 'exact') return
      if (API_MODE === 'mock') {
        const m = await import('../mocks/server')
        m.mockOptions.forceDiff = forceDiff
      }
      setActual(await api.postChange({ ...parsed.change, kind: 'new_rule' }, 'live'))
      refresh()
    })

  const cmp = predicted && actual ? compareLists(listsOf(predicted), listsOf(actual)) : null
  const name = (id: string) => nodeLabel(nodes.get(id), id)

  return (
    <main className="page">
      <div className="policy-head">
        <h1 className="page-title" style={{ margin: 0 }}>
          Policy preview
        </h1>
      </div>
      <p className="page-lede">Try a rule before the team adopts it. Nothing pauses while you look.</p>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          readRule()
        }}
        style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}
      >
        <label className="rule-input" style={{ flex: '1 1 360px' }}>
          <span className="eyebrow">Draft rule</span>
          <input value={text} onChange={(e) => setText(e.target.value)} aria-label="Draft rule" />
        </label>
        <button className={`btn ${predicted ? '' : 'primary'}`} disabled={busy || !text.trim()} type="submit">
          Preview
        </button>
      </form>

      {parsed && parsed.state !== 'exact' && (
        <div style={{ marginTop: 18 }}>
          <ReadCard
            parsed={parsed}
            graph={graph}
            busy={busy}
            onEdit={reread}
            onPick={(id) => reread(pinCandidate(parsed.change, graph, id))}
          />
        </div>
      )}

      {parsed?.state === 'exact' && <p className="page-lede small">{parsed.readback}</p>}

      {error && (
        <div className="error-box" style={{ marginTop: 14 }}>
          {error}
        </div>
      )}

      <div className="compare">
        <Side run={predicted} kind="predict" nodes={nodes} />
        <div className="eq">{cmp ? (cmp.match ? '=' : '≠') : ''}</div>
        <div>
          <Side run={actual} kind="actual" nodes={nodes} />
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 16 }}>
        {!cmp && (
          <button className={`btn ${predicted ? 'primary' : ''}`} onClick={apply} disabled={busy || !predicted || !!actual}>
            Apply the rule
          </button>
        )}
        {cmp && (
          <span className={`verdict ${cmp.match ? 'ok' : 'bad'}`} role="status">
            <span className="check">{cmp.match ? '✓' : '!'}</span>
            {cmp.match ? 'The lists match. The prediction was right.' : 'The lists differ. See what changed below.'}
          </span>
        )}
        {API_MODE === 'mock' && (
          <label className="faint" style={{ fontSize: 12, marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={forceDiff} onChange={(e) => setForceDiff(e.target.checked)} />
            Mock only: the graph changes between preview and apply
          </label>
        )}
      </div>

      {cmp && !cmp.match && (
        <section className="diff-list">
          <div className="eyebrow" style={{ marginBottom: 8 }}>
            Only one list holds these
          </div>
          {(['agents', 'workflows', 'paused'] as const).flatMap((k) => [
            ...cmp[k].onlyA.map((id) => (
              <div className="diff-item" key={`a-${k}-${id}`}>
                <b>{name(id)}</b>
                <span>
                  {k === 'paused' ? 'would pause' : `in the ${k} list`} only in the prediction
                </span>
              </div>
            )),
            ...cmp[k].onlyB.map((id) => (
              <div className="diff-item" key={`b-${k}-${id}`}>
                <b>{name(id)}</b>
                <span>
                  {k === 'paused' ? 'paused' : `in the ${k} list`} only after apply
                </span>
              </div>
            )),
          ])}
          <p className="muted" style={{ fontSize: 12 }}>
            A difference means a link in the graph is missing or new, not that the rule is wrong.
          </p>
        </section>
      )}
    </main>
  )
}
