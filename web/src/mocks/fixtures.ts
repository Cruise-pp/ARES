import type { ChangeEvent, Counts, EdgeType, Graph, Reached, Run, RunMode, Verdict } from '../api/types'
import { nodeLabel } from '../lib/format'
import runS1 from './run_S1.json'

// Hand-written reach for each change the mock knows. The mock does not search:
// each spec lists the paths the engine is expected to return, keyed by start nodes.
export interface RunSpec {
  key: string
  starts: string[]
  paths: string[][]
  verdicts: [string, Verdict['risk'], Exclude<Verdict['action'], 'none'>][]
  elapsed_ms: number
}

const chains = (...cs: string[][]) => cs

const REPORT_BUILDER_REACH = (prefix: string[]) =>
  chains(
    [...prefix, 'ag_report_builder'],
    [...prefix, 'ag_report_builder', 'wf_audit_sampling'],
    [...prefix, 'ag_report_builder', 'wf_board_pack'],
    [...prefix, 'ag_report_builder', 'wf_weekly_report'],
    [...prefix, 'ag_report_builder', 'wf_audit_sampling', 'ob_sox_404'],
    [...prefix, 'ag_report_builder', 'wf_audit_sampling', 'out_audit_samples'],
    [...prefix, 'ag_report_builder', 'wf_board_pack', 'out_board_deck'],
  )

export const SPECS: RunSpec[] = [
  {
    key: 'S1',
    starts: ['tl_pdf_parse_214'],
    paths: (runS1 as Run).reached.map((r) => r.path),
    verdicts: [
      ['wf_customer_reply', 'high', 'paused'],
      ['wf_finance_feed', 'high', 'paused'],
      ['wf_contract_review', 'low', 'warned'],
    ],
    elapsed_ms: 3800,
  },
  {
    key: 'S2',
    starts: ['dt_customers_phone'],
    paths: chains(
      ['dt_customers_phone'],
      ['dt_customers_phone', 'ag_callback_scheduler'],
      ['dt_customers_phone', 'ag_churn_predictor'],
      ['dt_customers_phone', 'ag_claims_reader'],
      ['dt_customers_phone', 'ag_kyc_checker'],
      ['dt_customers_phone', 'ag_support_triage'],
      ['dt_customers_phone', 'sa_reply_drafter'],
      ['dt_customers_phone', 'sa_sms_composer'],
      ['dt_customers_phone', 'ag_callback_scheduler', 'wf_callback_booking'],
      ['dt_customers_phone', 'ag_churn_predictor', 'wf_churn_dashboard'],
      ['dt_customers_phone', 'ag_churn_predictor', 'wf_retention_offers'],
      ['dt_customers_phone', 'ag_claims_reader', 'wf_customer_reply'],
      ['dt_customers_phone', 'ag_kyc_checker', 'wf_kyc_review'],
      ['dt_customers_phone', 'ag_support_triage', 'wf_sms_alerts'],
      ['dt_customers_phone', 'ag_support_triage', 'wf_ticket_routing'],
      ['dt_customers_phone', 'ag_callback_scheduler', 'wf_callback_booking', 'out_callback_confirmations'],
      ['dt_customers_phone', 'ag_churn_predictor', 'wf_retention_offers', 'ob_gdpr_art6'],
      ['dt_customers_phone', 'ag_churn_predictor', 'wf_retention_offers', 'out_retention_emails'],
      ['dt_customers_phone', 'ag_claims_reader', 'wf_customer_reply', 'out_customer_replies'],
      ['dt_customers_phone', 'ag_kyc_checker', 'wf_kyc_review', 'ob_amld5'],
      ['dt_customers_phone', 'ag_kyc_checker', 'wf_kyc_review', 'ob_gdpr_art32'],
      ['dt_customers_phone', 'ag_kyc_checker', 'wf_kyc_review', 'out_kyc_filings'],
      ['dt_customers_phone', 'ag_support_triage', 'wf_sms_alerts', 'out_sms_alerts'],
    ),
    verdicts: [
      ['wf_callback_booking', 'high', 'paused'],
      ['wf_churn_dashboard', 'low', 'warned'],
      ['wf_customer_reply', 'high', 'paused'],
      ['wf_kyc_review', 'high', 'paused'],
      ['wf_retention_offers', 'high', 'paused'],
      ['wf_sms_alerts', 'high', 'paused'],
      ['wf_ticket_routing', 'low', 'warned'],
    ],
    elapsed_ms: 3700,
  },
  {
    key: 'S3',
    starts: ['ag_claims_reader', 'ag_contract_summariser', 'ag_invoice_extractor', 'ag_report_builder'],
    paths: chains(
      ['ag_claims_reader'],
      ['ag_contract_summariser'],
      ['ag_invoice_extractor'],
      ['ag_report_builder'],
      ['ag_claims_reader', 'wf_customer_reply'],
      ['ag_contract_summariser', 'wf_contract_review'],
      ['ag_invoice_extractor', 'wf_finance_feed'],
      ['ag_report_builder', 'wf_audit_sampling'],
      ['ag_report_builder', 'wf_board_pack'],
      ['ag_report_builder', 'wf_weekly_report'],
      ['ag_claims_reader', 'wf_customer_reply', 'out_customer_replies'],
      ['ag_invoice_extractor', 'wf_finance_feed', 'ob_sox_404'],
      ['ag_invoice_extractor', 'wf_finance_feed', 'out_gl_posting'],
      ['ag_report_builder', 'wf_audit_sampling', 'out_audit_samples'],
      ['ag_report_builder', 'wf_board_pack', 'out_board_deck'],
    ),
    verdicts: [
      ['wf_audit_sampling', 'high', 'paused'],
      ['wf_board_pack', 'high', 'paused'],
      ['wf_contract_review', 'low', 'warned'],
      ['wf_customer_reply', 'high', 'paused'],
      ['wf_finance_feed', 'high', 'paused'],
      ['wf_weekly_report', 'low', 'warned'],
    ],
    elapsed_ms: 3900,
  },
  {
    key: 'libxml',
    starts: ['tl_libxml_291'],
    paths: chains(
      ['tl_libxml_291'],
      ['tl_libxml_291', 'ag_fraud_scorer'],
      ['tl_libxml_291', 'ag_fraud_scorer', 'wf_fraud_alerts'],
      ['tl_libxml_291', 'ag_fraud_scorer', 'wf_fraud_alerts', 'ob_pci_dss'],
    ),
    verdicts: [['wf_fraud_alerts', 'high', 'paused']],
    elapsed_ms: 3400,
  },
  {
    key: 'orders_email',
    starts: ['dt_orders_email'],
    paths: chains(
      ['dt_orders_email'],
      ['dt_orders_email', 'ag_order_tracker'],
      ['dt_orders_email', 'ag_sales_drafter'],
      ['dt_orders_email', 'ag_order_tracker', 'wf_order_updates'],
      ['dt_orders_email', 'ag_sales_drafter', 'wf_sales_outreach'],
      ['dt_orders_email', 'ag_order_tracker', 'wf_order_updates', 'out_order_emails'],
      ['dt_orders_email', 'ag_sales_drafter', 'wf_sales_outreach', 'out_sales_emails'],
    ),
    verdicts: [
      ['wf_order_updates', 'high', 'paused'],
      ['wf_sales_outreach', 'high', 'paused'],
    ],
    elapsed_ms: 3500,
  },
  {
    key: 'pdf_parse_213',
    starts: ['tl_pdf_parse_213'],
    paths: [['tl_pdf_parse_213'], ['tl_pdf_parse_213', 'sa_pdf_reader'], ...REPORT_BUILDER_REACH(['tl_pdf_parse_213'])],
    verdicts: [
      ['wf_audit_sampling', 'high', 'paused'],
      ['wf_board_pack', 'high', 'paused'],
      ['wf_weekly_report', 'low', 'warned'],
    ],
    elapsed_ms: 3600,
  },
  {
    key: 'gpt_x',
    starts: ['ag_report_builder'],
    paths: REPORT_BUILDER_REACH([]),
    verdicts: [
      ['wf_audit_sampling', 'high', 'paused'],
      ['wf_board_pack', 'high', 'paused'],
      ['wf_weekly_report', 'low', 'warned'],
    ],
    elapsed_ms: 3600,
  },
]

export function specFor(startIds: string[]): RunSpec | undefined {
  const key = [...startIds].sort().join(',')
  return SPECS.find((s) => [...s.starts].sort().join(',') === key)
}

function edgeBetween(graph: Graph, a: string, b: string): EdgeType {
  const e = graph.edges.find(
    (x) => (x.source === a && x.target === b) || (x.source === b && x.target === a),
  )
  if (!e) throw new Error(`mock spec has no edge between ${a} and ${b}`)
  return e.type
}

export function buildReached(graph: Graph, paths: string[][]): Reached[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const seen = new Set<string>()
  const out: Reached[] = []
  for (const path of paths) {
    const id = path[path.length - 1]
    if (seen.has(id)) continue
    seen.add(id)
    const node = byId.get(id)
    if (!node) throw new Error(`mock spec names unknown node ${id}`)
    const via = path.slice(1).map((n, i) => edgeBetween(graph, path[i], n))
    out.push({ id, type: node.type, name: nodeLabel(node), hops: path.length - 1, path, via })
  }
  return out.sort((x, y) => x.hops - y.hops || x.id.localeCompare(y.id))
}

export function buildRun(
  graph: Graph,
  spec: RunSpec,
  change: ChangeEvent,
  mode: RunMode,
  run_id: string,
  extraPaths: string[][] = [],
): Run {
  const reached = buildReached(graph, [...spec.paths, ...extraPaths])
  const verdicts: Verdict[] = spec.verdicts.map(([workflow_id, risk, action]) => ({
    workflow_id,
    risk,
    action: mode === 'preview' ? 'none' : action,
  }))
  for (const r of reached) {
    if (r.type === 'workflow' && !verdicts.some((v) => v.workflow_id === r.id)) {
      verdicts.push({ workflow_id: r.id, risk: 'high', action: mode === 'preview' ? 'none' : 'paused' })
    }
  }
  const count = (t: string) => reached.filter((r) => r.type === t && r.hops <= 4).length
  const counts: Counts = {
    agents: count('agent'),
    workflows: count('workflow'),
    paused: verdicts.filter((v) => v.action === 'paused').length,
    warned: verdicts.filter((v) => v.action === 'warned').length,
    duties: count('obligation'),
    outputs: count('output'),
    untouched:
      graph.nodes.filter((n) => n.type !== 'subagent').length - reached.filter((r) => r.type !== 'subagent').length,
  }
  return {
    run_id,
    mode,
    elapsed_ms: spec.elapsed_ms,
    change: { ...change, mode },
    counts,
    reached,
    verdicts,
    incidents: [],
    tasks: [],
  }
}
