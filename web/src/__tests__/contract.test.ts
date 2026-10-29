import { beforeEach, describe, expect, it } from 'vitest'
import { normalizeGraph, normalizeTask } from '../api/client'
import type { Run } from '../api/types'
import { buildReached } from '../mocks/fixtures'
import runS1 from '../mocks/run_S1.json'
import { mockOptions, mockServer, resetMock } from '../mocks/server'
import { workflowFlow } from '../lib/flow'
import { radialLayout } from '../lib/layout'
import { getMotionPref, motionReduced } from '../lib/motion'
import { storySentence } from '../lib/story'
import { countVisible, withinHops } from '../lib/reach'
import { compareLists, listsOf } from '../screens/Policy'
import { formatElapsed } from '../lib/format'

beforeEach(() => resetMock())

describe('S1 fixture (page 31d)', () => {
  const run = runS1 as Run

  it('has the page 05 counts', () => {
    expect(run.counts).toEqual({ agents: 3, workflows: 3, paused: 2, warned: 1, duties: 1, outputs: 2, untouched: 60 })
    expect(run.elapsed_ms).toBe(3800)
    expect(run.incidents).toEqual(['INC-2041', 'INC-2042'])
    expect(run.tasks).toEqual(['t_finance_feed', 't_customer_reply', 't_contract_review'])
  })

  it('every path and via agrees with the mock graph', () => {
    const graph = mockServer.getGraph()
    const rebuilt = buildReached(graph, run.reached.map((r) => r.path))
    for (const r of run.reached) {
      const b = rebuilt.find((x) => x.id === r.id)!
      expect(b.via).toEqual(r.via)
      expect(b.hops).toBe(r.path.length - 1)
      expect(b.type).toBe(r.type)
    }
    const platform = (xs: { type: string }[]) => xs.filter((x) => x.type !== 'subagent').length
    expect(platform(graph.nodes) - platform(run.reached)).toBe(run.counts.untouched)
  })

  it('adds sub-agents to reached without moving the counts', () => {
    const subs = run.reached.filter((r) => r.type === 'subagent').map((r) => r.id).sort()
    expect(subs).toEqual(['sa_attachment_reader', 'sa_clause_extractor', 'sa_line_item_parser', 'sa_page_splitter'])
    expect(run.reached.filter((r) => r.type === 'subagent').every((r) => r.hops === 1 && r.via === 'RUNS_ON')).toBe(true)
    const live = mockServer.postChange(mockServer.parseChange('pdf-parse 2.1.4 has a CVE. Fixed in 2.1.6.').change, 'live')
    expect(live.counts).toEqual(run.counts)
  })

  it('every sub-agent uses only what its parent agent already lists', () => {
    const g = mockServer.getGraph()
    const uses = (id: string) => new Set(g.edges.filter((e) => e.source === id && (e.type === 'RUNS_ON' || e.type === 'READS')).map((e) => e.target))
    const agentOf = (id: string): string => {
      const p = g.edges.find((e) => e.type === 'DELEGATES' && e.target === id)!.source
      return g.nodes.find((n) => n.id === p)!.type === 'agent' ? p : agentOf(p)
    }
    for (const sa of g.nodes.filter((n) => n.type === 'subagent')) {
      const parent = uses(agentOf(sa.id))
      for (const t of uses(sa.id)) expect(parent.has(t), `${sa.id} → ${t}`).toBe(true)
    }
  })
})

describe('workflow drill-down', () => {
  it('lays tools, sub-agents, agents, workflow and outputs left to right, lit from reached', () => {
    const g = mockServer.getGraph()
    const run = runS1 as Run
    const flow = workflowFlow('wf_finance_feed', g, new Set(run.reached.map((r) => r.id)))
    const col = (id: string) => flow.byId.get(id)!.col
    expect(flow.columns.map((c) => c.label)).toEqual(['Tools and data', 'Nested sub-agents', 'Sub-agents', 'Agents', 'Workflow', 'Outputs and duties'])
    expect(col('tl_pdf_parse_214')).toBe(0)
    expect(col('sa_vendor_matcher')).toBe(1)
    expect(col('sa_line_item_parser')).toBe(2)
    expect(col('ag_invoice_extractor')).toBe(3)
    expect(col('wf_finance_feed')).toBe(4)
    const lit = flow.nodes.filter((n) => n.lit).map((n) => n.id).sort()
    expect(lit).toEqual(['ag_invoice_extractor', 'ob_sox_404', 'out_gl_posting', 'sa_line_item_parser', 'sa_page_splitter', 'tl_pdf_parse_214', 'wf_finance_feed'].sort())
    // The agent's own pdf-parse edge is a roll-up of its sub-agents' edges, so it is not drawn twice.
    expect(flow.edges.some((e) => e.from === 'tl_pdf_parse_214' && e.to === 'ag_invoice_extractor')).toBe(false)
  })
})

describe('mock actions after S1', () => {
  it('2 paused, 2 incidents, 3 tasks, 1 warning', () => {
    const run = mockServer.getRun('run_S1')
    expect(run.verdicts.filter((v) => v.action === 'paused')).toHaveLength(2)
    expect(run.verdicts.filter((v) => v.action === 'warned')).toHaveLength(1)
    const { task, incident } = mockServer.getTask('t_finance_feed')
    expect(incident?.id).toBe('INC-2041')
    expect(incident?.cause).toBe('CVE-2026-4471 · pdf-parse 2.1.4')
    expect(incident?.path).toBe('tool → Invoice extractor → Finance feed → GL posting')
    expect(incident?.duty).toBe('SOX 404')
    expect(incident?.action).toBe('paused at 08:41:03')
    expect(incident?.owner).toBe('Finance Ops · S. Okonkwo')
    expect(incident?.next).toBe('move Invoice extractor to pdf-parse 2.1.6')
    expect(task.state).toBe('open')
    expect(mockServer.getTask('t_contract_review').incident).toBeNull()
  })

  it('version 2.1.6 lands: both resume, tasks close', () => {
    mockServer.acceptTask('t_finance_feed')
    const verdicts = mockServer.setToolVersion('tl_pdf_parse_214', '2.1.6')
    expect(verdicts.map((v) => v.workflow_id).sort()).toEqual(['wf_contract_review', 'wf_customer_reply', 'wf_finance_feed'])
    for (const t of ['t_finance_feed', 't_customer_reply', 't_contract_review']) {
      expect(mockServer.getTask(t).task.state).toBe('closed')
    }
    const g = mockServer.getGraph()
    expect(g.nodes.find((n) => n.id === 'wf_finance_feed')?.state).toBe('running')
  })

  it('resume needs a reason', () => {
    expect(() => mockServer.resumeWorkflow('wf_finance_feed', ' ')).toThrow()
    expect(mockServer.resumeWorkflow('wf_finance_feed', 'month end close').action).toBe('none')
  })
})

describe('the box: three card states', () => {
  it('exact', () => {
    const p = mockServer.parseChange('Vendor says pdf-parse 2.1.4 has a remote code bug, CVE-2026-4471. Fixed in 2.1.6.')
    expect(p.state).toBe('exact')
    expect(p.matches).toEqual(['tl_pdf_parse_214'])
    expect(p.readback).toBe('1 node matches · 3 agents use it')
    expect(p.change.effect).toMatchObject({ ref: 'CVE-2026-4471', fix: '2.1.6' })
  })

  it('ambiguous', () => {
    const p = mockServer.parseChange('pdf-parse 2.1 has a CVE')
    expect(p.state).toBe('ambiguous')
    expect(p.candidates.map((c) => c.label)).toEqual(['pdf-parse 2.1.4', 'pdf-parse 2.1.3'])
  })

  it('unmatched: a field the graph does not hold is a gap, not a guess', () => {
    const p = mockServer.parseChange('Every tool from Acme is breached.')
    expect(p.state).toBe('none')
    expect(p.reason).toMatch(/no vendor field/)
  })

  it('a wrong version shows 0 agents', () => {
    const p = mockServer.parseChange('pdf-parse 2.1.9 is broken')
    expect(p.state).toBe('none')
    expect(p.readback).toMatch(/0 agents/)
  })

  it('JSON lane passes a ChangeEvent through', () => {
    const p = mockServer.parseChange(JSON.stringify((runS1 as Run).change))
    expect(p.state).toBe('exact')
    expect(p.change.parse?.by).toBe('code')
  })
})

describe('S2 and S3 reach', () => {
  it('S2 = 5 agents, 7 workflows', () => {
    const p = mockServer.parseChange('Data steward: customers.phone is now personal data (PII).')
    const run = mockServer.postChange(p.change, 'live')
    expect(run.counts.agents).toBe(5)
    expect(run.counts.workflows).toBe(7)
  })

  it('S3 = 4 agents, 6 workflows, multi-start', () => {
    const p = mockServer.parseChange('New rule: all models must run in the EU.')
    const run = mockServer.postChange(p.change, 'preview')
    expect(run.counts.agents).toBe(4)
    expect(run.counts.workflows).toBe(6)
    expect(run.reached.filter((r) => r.hops === 0)).toHaveLength(4)
    expect(run.verdicts.every((v) => v.action === 'none')).toBe(true)
    expect(run.tasks).toHaveLength(0)
  })
})

describe('hop slider filters, it does not search', () => {
  it('at 2 the outputs and duties are hidden', () => {
    const run = runS1 as Run
    const vis = withinHops(run.reached, 2)
    expect(vis.some((r) => r.type === 'output' || r.type === 'obligation')).toBe(false)
    expect(countVisible(run.reached, run.verdicts, 2)).toMatchObject({ agents: 3, workflows: 3, duties: 0, outputs: 0, paused: 2 })
    expect(countVisible(run.reached, run.verdicts, 1)).toMatchObject({ workflows: 0, paused: 0 })
  })
})

describe('policy preview', () => {
  const rule = () => mockServer.parseChange('model.region must be EU').change

  it('preview equals apply → LISTS MATCH', () => {
    const predicted = mockServer.postChange(rule(), 'preview')
    const actual = mockServer.postChange(rule(), 'live')
    const cmp = compareLists(listsOf(predicted), listsOf(actual))
    expect(cmp.match).toBe(true)
    expect(listsOf(predicted).paused).toHaveLength(4)
  })

  it('a forced difference shows the extra item', () => {
    const predicted = mockServer.postChange(rule(), 'preview')
    mockOptions.forceDiff = true
    const actual = mockServer.postChange(rule(), 'live')
    const cmp = compareLists(listsOf(predicted), listsOf(actual))
    expect(cmp.match).toBe(false)
    expect(cmp.workflows.onlyB).toEqual(['wf_document_archive'])
  })
})

describe('layout', () => {
  it('is deterministic and keys on stable ids', () => {
    const g = mockServer.getGraph()
    const nodes = new Map(g.nodes.map((n) => [n.id, n]))
    const run = runS1 as Run
    const reached = run.reached.filter((r) => r.type !== 'subagent')
    const a = radialLayout(reached, nodes, g.edges)
    const b = radialLayout([...reached].reverse(), nodes, g.edges)
    expect(a.nodes.map((n) => [n.id, n.x.toFixed(2), n.y.toFixed(2)])).toEqual(
      b.nodes.map((n) => [n.id, n.x.toFixed(2), n.y.toFixed(2)]),
    )
    expect(a.nodes[0].id).toBe('tl_pdf_parse_214')
    expect(a.rings.map((r) => r.label)).toEqual(['AGENTS', 'WORKFLOWS', 'OUTPUTS'])
  })

  it('puts a virtual change node at the centre when there are many starts', () => {
    const g = mockServer.getGraph()
    const nodes = new Map(g.nodes.map((n) => [n.id, n]))
    const run = mockServer.postChange(mockServer.parseChange('EU models only').change, 'preview')
    const l = radialLayout(run.reached, nodes, g.edges, { rootLabel: 'EU models only' })
    expect(l.multiStart).toBe(true)
    expect(l.nodes[0]).toMatchObject({ id: '__change', label: 'EU models only' })
    expect(l.rings[0].label).toBe('AGENTS')
  })
})

describe('live normalisers', () => {
  it('accepts page 21 embedded edges and fraction coverage', () => {
    const g = normalizeGraph({
      nodes: [
        { id: 'wf_a', type: 'workflow', edges: [{ INVOKES: 'ag_a' }, { SERVES: 'ob_a' }] } as never,
      ],
      edges: [{ from: 'ag_a', to: 'tl_a', type: 'RUNS_ON' } as never],
      coverage: 0.94,
      synced_at: '2026-10-28T08:40:00Z',
    })
    expect(g.coverage).toBe(0.94)
    expect(g.owners).toEqual([])
    expect(g.unknown_agents).toEqual([])
    expect(g.edges).toEqual([
      { source: 'wf_a', target: 'ag_a', type: 'INVOKES' },
      { source: 'wf_a', target: 'ob_a', type: 'SERVES' },
      { source: 'ag_a', target: 'tl_a', type: 'RUNS_ON' },
    ])
  })

  it('accepts Task + Incident flat or nested', () => {
    const task = { id: 't', owner_id: 'o', workflow_id: 'w', incident_id: null, message: 'm', state: 'open' as const }
    expect(normalizeTask({ task, incident: null }).task.id).toBe('t')
    expect(normalizeTask({ ...task, incident: null }).task.id).toBe('t')
  })
})

describe('panel sentence', () => {
  it('names what stopped and the duty it serves', () => {
    expect(
      storySentence({
        preview: false,
        paused: [
          { name: 'Customer reply', duties: [] },
          { name: 'Finance feed', duties: ['SOX 404'] },
        ],
        warned: ['Contract review'],
        resumed: [],
      }),
    ).toBe('Customer reply and Finance feed are paused — Finance feed serves SOX 404.')
    expect(storySentence({ preview: false, paused: [{ name: 'Finance feed', duties: ['SOX 404'] }], warned: [], resumed: [] })).toBe(
      'Finance feed is paused, and it serves SOX 404.',
    )
    expect(storySentence({ preview: true, paused: [], warned: [], resumed: [] })).toBe('If you fire this, nothing pauses.')
    expect(storySentence({ preview: false, paused: [], warned: [], resumed: ['Finance feed'] })).toBe('Finance feed is running again.')
  })
})

describe('elapsed readout', () => {
  it('keeps a millisecond search visible, and still prints a multi-second search in seconds', () => {
    expect(formatElapsed(8.23)).toBe('8.2ms')
    expect(formatElapsed(0)).toBe('0ms')
    expect(formatElapsed(3800)).toBe('3.8s')
  })
})

describe('motion', () => {
  it('plays when nobody has chosen, and only "off" or "system" can stop it', () => {
    expect(getMotionPref()).toBe('on')
    expect(motionReduced('on')).toBe(false)
    expect(motionReduced('off')).toBe(true)
  })
})
