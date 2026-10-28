import type {
  Candidate,
  ChangeEvent,
  Cond,
  FeedRow,
  Graph,
  GraphNode,
  Incident,
  ParsedChange,
  Run,
  RunMode,
  Task,
  TaskWithIncident,
  Verdict,
} from '../api/types'
import { clockTime, lowerFirst, nodeLabel, plural } from '../lib/format'
import { MOCK_EDGES, MOCK_NODES } from './graph'
import { buildRun, specFor, SPECS, type RunSpec } from './fixtures'
import runS1 from './run_S1.json'

export class MockError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

const OWNER_PEOPLE: Record<string, string> = {
  team_finance_ops: 'S. Okonkwo',
  team_support_ops: 'M. Chen',
  team_legal: 'R. Iyer',
  team_growth: 'L. Brandt',
  team_cx: 'A. Diallo',
  team_compliance: 'N. Haddad',
  team_risk: 'T. Novak',
  team_bi: 'J. Park',
  team_internal_audit: 'K. Osei',
  team_sales: 'P. Rossi',
  team_people: 'E. Varga',
  team_platform: 'D. Alvarez',
}

const OWNER_TEAM: Record<string, string> = {
  team_finance_ops: 'Finance Ops',
  team_support_ops: 'Support Ops',
  team_legal: 'Legal',
  team_growth: 'Growth',
  team_cx: 'Customer Experience',
  team_compliance: 'Compliance',
  team_risk: 'Risk',
  team_bi: 'BI',
  team_internal_audit: 'Internal Audit',
  team_sales: 'Sales',
  team_people: 'People',
  team_platform: 'AI Platform',
}

export interface MockOptions {
  /** Policy preview demo: the applied run holds one workflow the preview did not. */
  forceDiff: boolean
}

interface State {
  graph: Graph
  runs: Map<string, Run>
  tasks: Map<string, Task>
  incidents: Map<string, Incident>
  feed: FeedRow[]
  resumeLog: { workflow_id: string; reason: string; at: string }[]
  seq: number
  incidentSeq: number
}

export const mockOptions: MockOptions = { forceDiff: false }

let state: State

const MIN = 60_000
const clone = <T>(x: T): T => structuredClone(x)

function node(id: string): GraphNode | undefined {
  return state.graph.nodes.find((n) => n.id === id)
}

// ---------------------------------------------------------------- resolve

const FIELDS_BY_TYPE = (() => {
  const m = new Map<string, Set<string>>()
  for (const n of MOCK_NODES) {
    const s = m.get(n.type) ?? new Set<string>()
    Object.keys(n).forEach((k) => s.add(k))
    m.set(n.type, s)
  }
  return m
})()

function condHolds(n: GraphNode, c: Cond): boolean {
  const v = n[c.field]
  const list = Array.isArray(c.value) ? c.value.map(String) : [String(c.value)]
  const vs = Array.isArray(v) ? v.map(String) : [String(v ?? '')]
  switch (c.op) {
    case 'eq':
      return vs.includes(String(c.value))
    case 'neq':
      return !vs.includes(String(c.value))
    case 'in':
      return vs.some((x) => list.includes(x))
    case 'not_in':
      return !vs.some((x) => list.includes(x))
    case 'contains':
      return vs.some((x) => x.includes(String(c.value)))
    case 'prefix':
      return vs.some((x) => x.startsWith(String(c.value)))
  }
}

function conds(change: ChangeEvent): { conds: Cond[]; any: boolean } {
  return 'all' in change.where
    ? { conds: change.where.all, any: false }
    : { conds: change.where.any, any: true }
}

function select(change: ChangeEvent): GraphNode[] {
  const { conds: cs, any } = conds(change)
  return state.graph.nodes
    .filter((n) => n.type === change.target)
    .filter((n) => (any ? cs.some((c) => condHolds(n, c)) : cs.every((c) => condHolds(n, c))))
    .sort((a, b) => a.id.localeCompare(b.id))
}

function users(id: string): number {
  return state.graph.edges.filter((e) => e.target === id && (e.type === 'RUNS_ON' || e.type === 'READS')).filter((e) => state.graph.nodes.find((n) => n.id === e.source)?.type === 'agent').length
}

function readbackFor(change: ChangeEvent, matches: GraphNode[]): string {
  const m = matches.length
  const head = `${plural(m, 'node')} ${m === 1 ? 'matches' : 'match'}`
  if (change.target === 'tool') {
    const n = matches.reduce((s, x) => s + users(x.id), 0)
    return `${head} · ${plural(n, 'agent')} use${n === 1 ? 's' : ''} it`
  }
  if (change.target === 'data') {
    const n = matches.reduce((s, x) => s + users(x.id), 0)
    return `${head} · ${plural(n, 'agent')} read${n === 1 ? 's' : ''} it`
  }
  return `${plural(m, change.target)} ${m === 1 ? 'matches' : 'match'}`
}

export function resolveChange(change: ChangeEvent): ParsedChange {
  const fields = FIELDS_BY_TYPE.get(change.target) ?? new Set()
  const missing = conds(change).conds.find((c) => !fields.has(c.field))
  if (missing) {
    const subject = missing.field === 'vendor' ? 'which tools that vendor makes' : 'which nodes it means'
    return {
      change,
      state: 'none',
      matches: [],
      candidates: [],
      readback: `The graph has no ${missing.field} field.`,
      reason: `The graph has no ${missing.field} field on a ${change.target}. Radius does not guess ${subject}.`,
    }
  }
  const matches = select(change)
  if (matches.length === 0) {
    return {
      change,
      state: 'none',
      matches: [],
      candidates: [],
      readback: readbackFor(change, matches),
      reason: 'No node in the graph matches. Check the name and the exact version.',
    }
  }
  const versionPinned = conds(change).conds.some((c) => c.field === 'version' && c.op === 'eq')
  if (change.target === 'tool' && matches.length > 1 && !versionPinned) {
    const candidates: Candidate[] = matches
      .slice()
      .sort((a, b) => users(b.id) - users(a.id) || (b.version ?? '').localeCompare(a.version ?? ''))
      .map((n, i) => ({ id: n.id, label: nodeLabel(n), score: Math.round((0.9 - i * 0.15) * 100) / 100 }))
    return {
      change,
      state: 'ambiguous',
      matches: matches.map((n) => n.id),
      candidates,
      readback: `“${conds(change).conds.map((c) => String(c.value).replace(/\.$/, '')).join(' ')}” matches ${plural(matches.length, 'version')}.`,
    }
  }
  return {
    change,
    state: 'exact',
    matches: matches.map((n) => n.id),
    candidates: [],
    readback: readbackFor(change, matches),
  }
}

// ---------------------------------------------------------------- parse (mock only)

const CVE = /CVE-\d{4}-\d{3,}/i
const FIX = /(?:fixed|fix|patched)\s*(?:in|:)?\s*v?(\d+(?:\.\d+)+)/i

function proseToChange(raw: string): ChangeEvent | null {
  const text = raw.trim()
  const lower = text.toLowerCase()
  const source = { lane: 'words' as const, raw: text }
  const parse = { by: 'model' as const, confidence: 0.96, receipt: `rcpt_mock_${text.length}` }

  const vendor = /(?:every|all)\s+tools?\s+from\s+([\w-]+)/i.exec(text) ?? /\bvendor\s+([A-Z][\w-]+)/.exec(text)
  if (vendor) {
    return {
      kind: 'faulty_tool',
      title: `Every tool from ${vendor[1]}`,
      target: 'tool',
      where: { all: [{ field: 'vendor', op: 'eq', value: vendor[1] }] },
      effect: { type: 'fault' },
      source,
      parse,
    }
  }

  const toolNames = [...new Set(MOCK_NODES.filter((n) => n.type === 'tool').map((n) => n.name!))]
  for (const name of toolNames) {
    const m = new RegExp(`${name.replace(/[-.]/g, '\\$&')}\\s*v?(\\d+(?:\\.\\d+)*)`, 'i').exec(text)
    if (!m) continue
    const version = m[1]
    const exact = version.split('.').length >= 3
    const ref = CVE.exec(text)?.[0].toUpperCase()
    const fix = FIX.exec(text)?.[1]
    return {
      kind: 'faulty_tool',
      title: [ref, `${name} ${version}`].filter(Boolean).join(' · '),
      target: 'tool',
      where: {
        all: [
          { field: 'name', op: 'eq', value: name },
          { field: 'version', op: exact ? 'eq' : 'prefix', value: exact ? version : `${version}.` },
        ],
      },
      effect: { type: 'fault', ref, fix },
      source,
      parse,
    }
  }

  const col = /\b(customers|orders|invoices|contracts|tickets|employees)[ .]+(phone|email|amount|text|body|ssn)\b/i.exec(text)
  if (col && /(pii|personal|gdpr|sensitive)/i.test(text)) {
    const [table, column] = [col[1].toLowerCase(), col[2].toLowerCase()]
    return {
      kind: 'personal_data',
      title: `${table}.${column} → PII`,
      target: 'data',
      where: { all: [{ field: 'table', op: 'eq', value: table }, { field: 'column', op: 'eq', value: column }] },
      effect: { type: 'add_label', label: 'pii' },
      source,
      parse,
    }
  }

  if (/\beu\b/i.test(text) && /(model|region|host)/i.test(lower)) {
    return {
      kind: 'new_rule',
      title: 'EU models only',
      target: 'agent',
      where: { all: [{ field: 'model_region', op: 'not_in', value: ['EU'] }] },
      effect: { type: 'rule', ref: 'POL-0035' },
      source,
      parse,
    }
  }

  const model = /\b(gpt-x|gpt-4\.1(?:-mini)?|claude-sonnet-4|mistral-\w+|luminous-2)\b/i.exec(text)
  if (model) {
    return {
      kind: 'other',
      title: `${model[1]} ${/retir/i.test(text) ? 'retires' : 'changes'}`,
      target: 'agent',
      where: { all: [{ field: 'model_id', op: 'eq', value: model[1].toLowerCase() }] },
      effect: { type: 'fault' },
      source,
      parse,
    }
  }
  return null
}

function asChangeJson(text: string): ChangeEvent | null {
  try {
    const obj = JSON.parse(text)
    if (obj && typeof obj === 'object' && obj.target && obj.where) {
      return {
        kind: obj.kind ?? 'other',
        effect: obj.effect ?? { type: 'fault' },
        ...obj,
        source: { lane: 'paste', raw: text },
        parse: { by: 'code', confidence: 1 },
      }
    }
  } catch {
    /* not JSON: prose lane */
  }
  return null
}

export function mockParse(text: string): ParsedChange {
  const change = asChangeJson(text) ?? proseToChange(text)
  if (!change) {
    return {
      change: {
        kind: 'other',
        target: 'tool',
        where: { all: [] },
        effect: { type: 'fault' },
        source: { lane: 'words', raw: text },
      },
      state: 'none',
      matches: [],
      candidates: [],
      readback: 'Radius could not read a start node.',
      reason: 'The mock reads a few sample changes only. Start the engine (VITE_API=live) to read any text.',
    }
  }
  return resolveChange(change)
}

// ---------------------------------------------------------------- runs

function personFor(ownerId: string): string {
  const team = OWNER_TEAM[ownerId] ?? ownerId
  const person = OWNER_PEOPLE[ownerId]
  return person ? `${team} · ${person}` : team
}

function reasonSentence(change: ChangeEvent): string {
  switch (change.effect.type) {
    case 'fault':
      return change.target === 'tool'
        ? 'A fault was found in a tool that your workflow uses.'
        : 'An agent that your workflow runs is affected by a change.'
    case 'add_label':
      return 'Your workflow reads a field that is now marked as personal data.'
    case 'rule':
      return 'An agent that your workflow runs breaks a new rule.'
  }
}

function nextStep(change: ChangeEvent, agentName: string, wfName: string, startLabel: string): string {
  const fix = change.effect.fix
  if (change.effect.type === 'fault' && change.target === 'tool' && fix) {
    return `move ${agentName} to ${startLabel.split(' ')[0]} ${fix}`
  }
  if (change.effect.type === 'add_label') return `confirm ${lowerFirst(wfName)} may use ${startLabel} as personal data`
  if (change.effect.type === 'rule') return `move ${agentName} to an EU-hosted model`
  return `replace the model behind ${agentName}`
}

function openActions(run: Run, at: Date, overrides: Record<string, string> = {}, taskIds: Record<string, string> = {}) {
  const byId = new Map(run.reached.map((r) => [r.id, r]))
  const suffix = run.run_id.replace(/^run_/, '')
  for (const v of run.verdicts) {
    if (v.action === 'none') continue
    const wf = node(v.workflow_id)!
    const r = byId.get(v.workflow_id)!
    const agentId = [...r.path].reverse().find((id) => node(id)?.type === 'agent')!
    const agentName = node(agentId)!.name!
    const start = node(r.path[0])!
    const startLabel = nodeLabel(start)
    const downstream = run.reached.filter((x) => x.path[x.path.length - 2] === v.workflow_id)
    const duties = downstream.filter((x) => x.type === 'obligation').map((x) => x.name)
    const firstOut = downstream.find((x) => x.type === 'output')
    const pathNames = r.path
      .slice(start.type === 'agent' ? 0 : 1)
      .map((id) => node(id)!.name!)
      .concat(firstOut ? [firstOut.name] : [])
    const pathText = [start.type === 'agent' ? 'rule' : start.type, ...pathNames].join(' → ')
    const next = nextStep(run.change, agentName, wf.name!, startLabel)

    let incident_id: string | null = null
    if (v.action === 'paused') {
      incident_id = overrides[v.workflow_id] ?? `INC-${state.incidentSeq++}`
      state.incidents.set(incident_id, {
        id: incident_id,
        cause: run.change.title ?? startLabel,
        path: pathText,
        risk: wf.sends_external
          ? 'high · sends output outside the company'
          : `high · serves ${duties[0] ?? 'an obligation'}`,
        duty: duties.length ? duties.join(' · ') : 'none',
        action: `paused at ${clockTime(at.toISOString())}`,
        owner: personFor(wf.owner_id!),
        next,
      })
      run.incidents.push(incident_id)
    }
    const taskId = taskIds[v.workflow_id] ?? `t_${v.workflow_id.replace(/^wf_/, '')}_${suffix}`
    const head =
      v.action === 'paused'
        ? `Your ${lowerFirst(wf.name!)} is paused.`
        : `Your ${lowerFirst(wf.name!)} keeps running, with a warning.`
    const warnNext =
      v.workflow_id === 'wf_contract_review' && run.change.target === 'tool'
        ? 'Review 2 summaries produced since Tuesday.'
        : `Review what ${agentName} produced since the change.`
    state.tasks.set(taskId, {
      id: taskId,
      owner_id: wf.owner_id!,
      workflow_id: v.workflow_id,
      incident_id,
      message:
        v.action === 'paused'
          ? `${head}\n${reasonSentence(run.change)}`
          : `${head}\n${reasonSentence(run.change)}\nNext: ${warnNext}`,
      state: 'open',
    })
    run.tasks.push(taskId)
    if (v.action === 'paused') wf.state = 'paused'
  }
}

function feedState(run: Run): string {
  if (run.mode === 'preview') return 'Preview'
  if (run.counts.paused) return `${run.counts.paused} paused`
  if (run.counts.warned) return `${run.counts.warned} warned`
  return 'No impact'
}

function addFeedRow(run: Run, at: Date, stateOverride?: string) {
  state.feed.unshift({
    change_id: run.change.id ?? `chg_${run.run_id}`,
    title: run.change.title ?? 'Untitled change',
    kind: run.change.kind,
    reach: { agents: run.counts.agents, workflows: run.counts.workflows },
    state: stateOverride ?? feedState(run),
    at: at.toISOString(),
    run_id: run.run_id,
  })
}

function clearRun(run: Run) {
  for (const id of run.tasks) {
    const t = state.tasks.get(id)
    if (t) t.state = 'closed'
  }
  for (const v of run.verdicts) {
    const wf = node(v.workflow_id)
    if (wf && v.action === 'paused' && !isPausedElsewhere(v.workflow_id, run.run_id)) wf.state = 'running'
  }
}

function isPausedElsewhere(wfId: string, exceptRun: string): boolean {
  for (const r of state.runs.values()) {
    if (r.run_id === exceptRun || r.mode !== 'live') continue
    const v = r.verdicts.find((x) => x.workflow_id === wfId && x.action === 'paused')
    if (!v) continue
    const t = r.tasks.map((id) => state.tasks.get(id)).find((x) => x?.workflow_id === wfId)
    if (t && t.state !== 'closed') return true
  }
  return false
}

function specByKey(key: string): RunSpec {
  return SPECS.find((s) => s.key === key)!
}

function seedRun(key: string, change: ChangeEvent, mode: RunMode, minutesAgo: number, runId: string, cleared = false) {
  const at = new Date(Date.now() - minutesAgo * MIN)
  const run = buildRun(state.graph, specByKey(key), change, mode, runId)
  state.runs.set(run.run_id, run)
  if (mode === 'live') openActions(run, at)
  if (cleared) clearRun(run)
  addFeedRow(run, at, cleared ? 'Cleared' : undefined)
}

export function resetMock() {
  state = {
    graph: { nodes: clone(MOCK_NODES), edges: clone(MOCK_EDGES), synced_at: new Date(Date.now() - 4 * MIN).toISOString(), coverage: 0.94 },
    runs: new Map(),
    tasks: new Map(),
    incidents: new Map(),
    feed: [],
    resumeLog: [],
    seq: 200,
    incidentSeq: 2031,
  }
  mockOptions.forceDiff = false

  seedRun('orders_email', {
    id: 'DC-8809', kind: 'personal_data', title: 'DC-8809 · orders.email → PII', target: 'data',
    where: { all: [{ field: 'table', op: 'eq', value: 'orders' }, { field: 'column', op: 'eq', value: 'email' }] },
    effect: { type: 'add_label', label: 'pii', ref: 'DC-8809' },
    source: { lane: 'feed', raw: 'DC-8809 orders.email labelled pii' },
  }, 'live', 26 * 60, 'run_dc8809', true)
  seedRun('libxml', {
    id: 'CVE-2026-4390', kind: 'faulty_tool', title: 'CVE-2026-4390 · libxml 2.9.1', target: 'tool',
    where: { all: [{ field: 'name', op: 'eq', value: 'libxml' }, { field: 'version', op: 'eq', value: '2.9.1' }] },
    effect: { type: 'fault', ref: 'CVE-2026-4390', fix: '2.9.2' },
    source: { lane: 'feed', raw: 'CVE-2026-4390 libxml 2.9.1' },
  }, 'live', 22 * 60, 'run_cve4390', true)
  seedRun('S3', {
    id: 'POL-0034', kind: 'new_rule', title: 'POL-0034 · EU models only', target: 'agent',
    where: { all: [{ field: 'model_region', op: 'not_in', value: ['EU'] }] },
    effect: { type: 'rule', ref: 'POL-0034' },
    source: { lane: 'feed', raw: 'Policy register: models must run in the EU' },
  }, 'preview', 120, 'run_pol0034')
  seedRun('S2', {
    id: 'DC-8812', kind: 'personal_data', title: 'DC-8812 · customers.phone → PII', target: 'data',
    where: { all: [{ field: 'table', op: 'eq', value: 'customers' }, { field: 'column', op: 'eq', value: 'phone' }] },
    effect: { type: 'add_label', label: 'pii', ref: 'DC-8812' },
    source: { lane: 'feed', raw: 'Data catalog: customers.phone labelled pii' },
  }, 'live', 60, 'run_dc8812')

  const s1 = clone(runS1 as Run)
  s1.incidents = []
  s1.tasks = []
  const s1At = new Date(Date.now() - 4 * MIN)
  s1At.setHours(8, 41, 3)
  state.runs.set(s1.run_id, s1)
  state.incidentSeq = 2043
  openActions(
    s1,
    s1At,
    { wf_finance_feed: 'INC-2041', wf_customer_reply: 'INC-2042' },
    { wf_finance_feed: 't_finance_feed', wf_customer_reply: 't_customer_reply', wf_contract_review: 't_contract_review' },
  )
  s1.incidents.sort()
  s1.tasks = ['t_finance_feed', 't_customer_reply', 't_contract_review']
  addFeedRow(s1, new Date(Date.now() - 4 * MIN))
}

resetMock()

// ---------------------------------------------------------------- endpoints

export const mockServer = {
  getGraph(): Graph {
    return clone(state.graph)
  },

  parseChange(text: string): ParsedChange {
    return clone(mockParse(text))
  },

  postChange(change: ChangeEvent, mode: RunMode): Run {
    const starts = select(change).map((n) => n.id)
    const spec = specFor(starts)
    if (!spec) {
      throw new MockError(
        404,
        starts.length
          ? 'The mock has no reach for this change. Start the engine (VITE_API=live) to run it.'
          : 'No node in the graph matches this change.',
      )
    }
    const run_id = `run_${++state.seq}`
    const extra =
      mode === 'live' && mockOptions.forceDiff && spec.key === 'S3'
        ? [['ag_report_builder', 'wf_document_archive']]
        : []
    if (extra.length && !state.graph.edges.some((e) => e.source === 'wf_document_archive' && e.target === 'ag_report_builder')) {
      state.graph.edges.push({ source: 'wf_document_archive', target: 'ag_report_builder', type: 'INVOKES' })
    }
    const run = buildRun(state.graph, spec, { ...change, id: change.id ?? `chg_${state.seq}` }, mode, run_id, extra)
    const at = new Date()
    state.runs.set(run_id, run)
    if (mode === 'live') openActions(run, at)
    addFeedRow(run, at)
    return clone(run)
  },

  getChanges(): FeedRow[] {
    return clone(state.feed)
  },

  getRun(id: string): Run {
    const run = state.runs.get(id)
    if (!run) throw new MockError(404, `No run ${id}`)
    return clone(run)
  },

  resumeWorkflow(id: string, reason: string): Verdict {
    const wf = node(id)
    if (!wf || wf.type !== 'workflow') throw new MockError(404, `No workflow ${id}`)
    if (!reason.trim()) throw new MockError(422, 'Resume needs a reason.')
    wf.state = 'running'
    state.resumeLog.push({ workflow_id: id, reason, at: new Date().toISOString() })
    const risk = [...state.runs.values()].flatMap((r) => r.verdicts).find((v) => v.workflow_id === id)?.risk ?? 'low'
    return { workflow_id: id, risk, action: 'none' }
  },

  getTask(id: string): TaskWithIncident {
    const task = state.tasks.get(id)
    if (!task) throw new MockError(404, `No task ${id}`)
    return clone({ task, incident: task.incident_id ? (state.incidents.get(task.incident_id) ?? null) : null })
  },

  acceptTask(id: string): Task {
    const task = state.tasks.get(id)
    if (!task) throw new MockError(404, `No task ${id}`)
    if (task.state === 'open') task.state = 'accepted'
    return clone(task)
  },

  setToolVersion(id: string, version: string): Verdict[] {
    const tool = node(id)
    if (!tool || tool.type !== 'tool') throw new MockError(404, `No tool ${id}`)
    const out: Verdict[] = []
    for (const run of state.runs.values()) {
      if (run.mode !== 'live' || run.reached[0]?.id !== id) continue
      if (run.change.effect.fix && run.change.effect.fix !== version) continue
      clearRun(run)
      for (const v of run.verdicts) out.push({ ...v, action: 'none' })
      const row = state.feed.find((f) => f.run_id === run.run_id)
      if (row) row.state = 'Cleared'
    }
    tool.version = version
    return out
  },
}