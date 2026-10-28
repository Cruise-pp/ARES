// Contract types, typed from brief page 31d (and 07b for ChangeEvent, 21 for nodes).
// If this file and page 31d disagree, page 31d wins.

export type NodeType = 'tool' | 'data' | 'agent' | 'workflow' | 'obligation' | 'output'
export type EdgeType = 'RUNS_ON' | 'READS' | 'INVOKES' | 'SERVES' | 'SENDS'

export type Target = 'tool' | 'data' | 'agent' | 'workflow' | 'obligation'
export type Op = 'eq' | 'neq' | 'in' | 'not_in' | 'contains' | 'prefix'
export type CondValue = string | number | boolean | string[]

export interface Cond {
  field: string
  op: Op
  value: CondValue
}

export type Where = { all: Cond[] } | { any: Cond[] }

export type Kind = 'faulty_tool' | 'personal_data' | 'new_rule' | 'other'

export interface Effect {
  type: 'fault' | 'add_label' | 'rule'
  ref?: string
  fix?: string
  label?: string
}

export interface ChangeEvent {
  id?: string
  kind: Kind
  title?: string
  target: Target
  where: Where
  effect: Effect
  mode?: RunMode
  source?: { lane: 'feed' | 'paste' | 'words'; raw: string }
  parse?: { by: 'model' | 'code'; confidence?: number; receipt?: string }
}

export interface GraphNode {
  id: string
  type: NodeType
  name?: string
  owner_id?: string
  // tool
  version?: string
  ecosystem?: string
  // data
  table?: string
  column?: string
  labels?: string[]
  // agent
  model_id?: string
  model_region?: string
  // workflow
  sends_external?: boolean
  state?: string
  // obligation
  authority?: string
  // output
  channel?: string
  volume?: number | null
  [extra: string]: unknown
}

export interface GraphEdge {
  source: string
  target: string
  type: EdgeType
}

export interface Graph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  synced_at: string
  coverage: number
}

export type MatchState = 'exact' | 'ambiguous' | 'none'

export interface Candidate {
  id: string
  label: string
  score: number
}

export interface ParsedChange {
  change: ChangeEvent
  state: MatchState
  matches: string[]
  candidates: Candidate[]
  readback: string
  reason?: string
}

export type RunMode = 'live' | 'preview'

export interface Counts {
  agents: number
  workflows: number
  paused: number
  warned: number
  duties: number
  outputs: number
  untouched: number
}

export interface Reached {
  id: string
  type: NodeType
  name: string
  hops: number
  path: string[]
  via: EdgeType[]
}

export interface Verdict {
  workflow_id: string
  risk: 'high' | 'low'
  action: 'paused' | 'warned' | 'none'
}

export interface Run {
  run_id: string
  mode: RunMode
  elapsed_ms: number
  change: ChangeEvent
  counts: Counts
  reached: Reached[]
  verdicts: Verdict[]
  incidents: string[]
  tasks: string[]
}

export interface Incident {
  id: string
  cause: string
  path: string | string[]
  risk: string
  duty: string
  action: string
  owner: string
  next: string
}

export type TaskState = 'open' | 'accepted' | 'closed'

export interface Task {
  id: string
  owner_id: string
  workflow_id: string
  incident_id: string | null
  message: string
  state: TaskState
}

export interface TaskWithIncident {
  task: Task
  incident: Incident | null
}

export interface FeedRow {
  change_id: string
  title: string
  kind: Kind | string
  reach: string | { agents: number; workflows: number }
  state: string
  at: string
  // Not on page 31d. Without it a feed row cannot open its run; reported to the human as a contract gap.
  run_id?: string
}
