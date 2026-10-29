import type { EdgeType, FeedRow, GraphNode, Kind, NodeType } from '../api/types'

const ACRONYMS = new Set(['ai', 'bi', 'cx', 'hr', 'it', 'kyc', 'qa', 'sre'])

/** "Finance Ops · S. Okonkwo", the same line the engine puts on an incident. */
export function ownerLine(owners: { id: string; team: string; person: string }[] | undefined, ownerId: string | undefined): string {
  const owner = owners?.find((o) => o.id === ownerId)
  if (owner) return `${owner.team} · ${owner.person}`
  return ownerName(ownerId)
}

/** GET /graph sends a fraction. A value already above 1 is left as a percent. */
export function coveragePercent(coverage: number): number {
  return Math.round(coverage <= 1 ? coverage * 100 : coverage)
}

export function ownerName(ownerId: string | undefined): string {
  if (!ownerId) return 'No owner'
  return ownerId
    .replace(/^(team|person|user)_/, '')
    .split('_')
    .map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ')
}

export function formatNumber(n: number): string {
  return n.toLocaleString('en-US')
}

/** Search time a person can read. A live graph search is a few milliseconds; seconds with one decimal print that as 0.0s. */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0ms'
  if (ms < 1000) return `${ms < 10 ? ms.toFixed(1) : String(Math.round(ms))}ms`
  const seconds = ms / 1000
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`
}

export function nodeLabel(node: GraphNode | undefined, fallback = ''): string {
  if (!node) return fallback
  switch (node.type) {
    case 'tool':
      return node.version ? `${node.name} ${node.version}` : (node.name ?? node.id)
    case 'data':
      return node.table && node.column ? `${node.table}.${node.column}` : (node.name ?? node.id)
    case 'output':
      return typeof node.volume === 'number' && node.volume > 1
        ? `${formatNumber(node.volume)} ${node.name}`
        : (node.name ?? node.id)
    default:
      return node.name ?? node.id
  }
}

/** "Finance feed" -> "finance feed", but "KYC review" stays. */
export function lowerFirst(s: string): string {
  if (s.length > 1 && s[1] === s[1].toUpperCase() && /[A-Z]/.test(s[1])) return s
  return s.charAt(0).toLowerCase() + s.slice(1)
}

export const KIND_LABEL: Record<Kind, string> = {
  faulty_tool: 'Faulty tool',
  personal_data: 'Personal data',
  new_rule: 'New rule',
  other: 'Other change',
}

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind as Kind] ?? kind.replace(/_/g, ' ')
}

export const TYPE_PLURAL: Record<NodeType, string> = {
  tool: 'tools',
  data: 'data',
  agent: 'agents',
  subagent: 'sub-agents',
  workflow: 'workflows',
  obligation: 'duties',
  output: 'outputs',
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** How a person reads one hop of a path, from the change outward. */
export const EDGE_VERB: Record<EdgeType, string> = {
  RUNS_ON: 'used by',
  READS: 'read by',
  INVOKES: 'run by',
  DELEGATES: 'part of',
  SERVES: 'serves',
  SENDS: 'sends',
}

export function reachText(reach: FeedRow['reach']): string {
  return reach
}

/** "CVE-2026-4471 · pdf-parse 2.1.4" -> ["CVE-2026-4471", "pdf-parse 2.1.4"] */
export function splitTitle(title: string): [string, string] {
  const i = title.indexOf(' · ')
  return i === -1 ? [title, ''] : [title.slice(0, i), title.slice(i + 3)]
}

export function timeAgo(iso: string, now = Date.now()): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return d === 1 ? 'Yesterday' : `${d}d ago`
}

export function clockTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toTimeString().slice(0, 8)
}

export type RowTone = 'paused' | 'warned' | 'preview' | 'cleared'

/** Colour means state: red paused, amber warned, blue preview, grey closed. */
export function rowTone(state: string): RowTone {
  const s = state.toLowerCase()
  if (s.includes('paused')) return 'paused'
  if (s.includes('warn')) return 'warned'
  if (s.includes('preview')) return 'preview'
  return 'cleared'
}

export function pausedCount(state: string): number {
  const m = /(\d+)\s*paused/i.exec(state)
  return m ? Number(m[1]) : 0
}
