import type { EdgeType, Graph, GraphNode, Reached, Run, Verdict } from '../api/types'
import { EDGE_VERB, lowerFirst, nodeLabel, ownerName } from './format'

/** Actions apply at four hops (page 31a, rule 3). Reach beyond is shown as a lower group. */
export const ACTION_HOPS = 4
export const MAX_HOPS = 6

export function withinHops(reached: Reached[], limit: number): Reached[] {
  return reached.filter((r) => r.hops <= limit)
}

export interface VisibleCounts {
  agents: number
  workflows: number
  paused: number
  warned: number
  duties: number
  outputs: number
}

export function countVisible(reached: Reached[], verdicts: Verdict[], limit: number): VisibleCounts {
  const vis = withinHops(reached, limit)
  const wfIds = new Set(vis.filter((r) => r.type === 'workflow').map((r) => r.id))
  const n = (t: string) => vis.filter((r) => r.type === t).length
  return {
    agents: n('agent'),
    workflows: wfIds.size,
    paused: verdicts.filter((v) => wfIds.has(v.workflow_id) && v.action === 'paused').length,
    warned: verdicts.filter((v) => wfIds.has(v.workflow_id) && v.action === 'warned').length,
    duties: n('obligation'),
    outputs: n('output'),
  }
}

export type WorkflowStatus = 'paused' | 'warned' | 'resumed' | 'would_pause' | 'would_warn' | 'beyond' | 'none'

export interface WorkflowRow {
  id: string
  name: string
  ownerId: string
  owner: string
  hops: number
  risk: Verdict['risk'] | null
  status: WorkflowStatus
  detail: string
}

export function workflowRows(run: Run, graph: Graph | null, limit: number): WorkflowRow[] {
  const byId = new Map((graph?.nodes ?? []).map((n) => [n.id, n]))
  const verdicts = new Map(run.verdicts.map((v) => [v.workflow_id, v]))
  const rows: WorkflowRow[] = []
  for (const r of withinHops(run.reached, limit)) {
    if (r.type !== 'workflow') continue
    const node = byId.get(r.id)
    const v = verdicts.get(r.id)
    const ownerId = node?.owner_id ?? ''
    let status: WorkflowStatus = 'none'
    if (r.hops > ACTION_HOPS) status = 'beyond'
    else if (run.mode === 'preview') status = v?.risk === 'high' ? 'would_pause' : 'would_warn'
    else if (v?.action === 'paused') status = node?.state === 'running' ? 'resumed' : 'paused'
    else if (v?.action === 'warned') status = 'warned'

    const outs = run.reached.filter((x) => x.path[x.path.length - 2] === r.id && x.type === 'output')
    const duties = run.reached.filter((x) => x.path[x.path.length - 2] === r.id && x.type === 'obligation')
    let detail: string
    if (status === 'paused' || status === 'would_pause') {
      const held = outs.map((o) => `${nodeLabel(byId.get(o.id), o.name)} held`)
      detail = held.length ? held.join(' · ') : duties.length ? `serves ${duties.map((d) => d.name).join(' · ')}` : 'high risk'
    } else if (status === 'resumed') {
      detail = 'resumed by hand'
    } else if (node && !node.sends_external) {
      detail = 'stays inside the company'
    } else {
      detail = outs.length ? `sends ${outs.map((o) => nodeLabel(byId.get(o.id), o.name)).join(' · ')}` : 'low risk'
    }
    rows.push({
      id: r.id,
      name: node?.name ?? r.name,
      ownerId,
      owner: ownerName(ownerId),
      hops: r.hops,
      risk: v?.risk ?? null,
      status,
      detail,
    })
  }
  return rows
}

export interface PathStep {
  id: string
  label: string
  type: string
  verb: string | null
}

export function pathSteps(item: Reached, reached: Reached[], nodes: Map<string, GraphNode>): PathStep[] {
  const names = new Map(reached.map((r) => [r.id, r.name]))
  return item.path.map((id, i) => ({
    id,
    label: nodeLabel(nodes.get(id), names.get(id) ?? id),
    type: nodes.get(id)?.type ?? reached.find((r) => r.id === id)?.type ?? '',
    verb: i === 0 ? null : EDGE_VERB[item.via[i - 1] as EdgeType] ?? item.via[i - 1] ?? '→',
  }))
}

export function pathSentence(steps: PathStep[]): string {
  return steps.map((s, i) => (i === 0 ? s.label : `${s.verb} ${lowerFirst(s.label)}`)).join(' · ')
}

export interface ListDiff {
  match: boolean
  onlyA: string[]
  onlyB: string[]
}

export function diffLists(a: string[], b: string[]): ListDiff {
  const sa = new Set(a)
  const sb = new Set(b)
  const onlyA = [...sa].filter((x) => !sb.has(x)).sort()
  const onlyB = [...sb].filter((x) => !sa.has(x)).sort()
  return { match: onlyA.length === 0 && onlyB.length === 0, onlyA, onlyB }
}

export function itemsAtStake(run: Run, graph: Graph | null): number {
  const byId = new Map((graph?.nodes ?? []).map((n) => [n.id, n]))
  return run.reached
    .filter((r) => r.type === 'output' && r.hops <= ACTION_HOPS)
    .reduce((s, r) => s + (Number(byId.get(r.id)?.volume) || 0), 0)
}