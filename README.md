# ARES

**Agent Risk & Exposure Sentinel**: code repo for the Solix EMPOWER Hackathon 2026 (AI Security track).

ARES takes one outside change, such as a vulnerability notice, a vendor e-mail or a new rule, and finds every AI agent, workflow, obligation and output it touches. It pauses the high-risk workflows on its own, opens an incident that names the cause, and gives each owner one plain next step. Low-risk workflows keep running with a warning.

> 1 notice in. 3 agents reached. 2 workflows paused, 1 warned, the rest confirmed safe, in seconds.

---

## Contents

- [The problem](#the-problem)
- [What ARES does](#what-ares-does)
- [How it decides](#how-it-decides)
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [API at a glance](#api-at-a-glance)
- [Console screens](#console-screens)
- [Sample inputs](#sample-inputs)
- [Testing](#testing)
- [Documentation](#documentation)

---

## The problem

Companies run AI agents that answer customers, move money and handle personal data, often on shared tools. When a flaw lands in one tool version, teams spend days asking "what's affected?" while the risky workflows keep running.

The hackathon brief: take one outside change, follow the links in a seed graph (tool → agents → workflows → obligations and outputs), then act on the result. Handle at least two of the three kinds of change:

| Kind | Example |
|---|---|
| Vulnerability on a tool version | `pdf-parse 2.3.1` has a CVE |
| Data newly marked as personal | `customers.phone` is now PII |
| New policy | "EU-only models from now on" |

ARES handles all three, plus the stretch goal: a **preview** mode that shows what a new policy *would* stop before anyone adopts it, and that list matches the real run.

## What ARES does

1. **Takes the change in, in any of three lanes**
   - **Feed**: structured records (OSV, CycloneDX VEX, catalog records, policies). An exact match fires on its own.
   - **Paste**: an advisory, `key: value` lines or a ChangeEvent pasted by a person.
   - **Words**: a sentence or a vendor e-mail. The model turns it into a structured change.
2. **Reads it back** ("here is what I understood") and resolves it against the graph as `exact`, `ambiguous` or `none`. Anything not exact waits for one click from a person; anything unmatched goes to the **Unmatched** queue.
3. **Finds the blast radius** with a reverse breadth-first search over the graph: every agent that uses the tool, every workflow that runs those agents, every obligation and output those workflows serve.
4. **Scores and acts**
   - High risk → the workflow is **paused**, with one incident per pause that names the cause.
   - Low risk → the workflow keeps running with a **warning**.
   - Each owner gets **one task** with a clear next step.
5. **Tells the owners.** The model rewrites each message in plain words from the incident fields only. Code checks the message before it is sent; on failure it retries once, then falls back to a template.
6. **Resumes on its own.** When a fixed version of the tool lands, the tasks it fixes close and every workflow nothing else holds restarts. A person can also resume a workflow with a written reason.
7. **Keeps a record.** Every fire, pause, warning, resume (with reason), close and dispatch goes into an append-only record.

## How it decides

**No AI model sits in the decision path.** Software that pauses live operations has to be right every time and easy to audit, so code decides and the model only handles language.

- The company is one graph of tools, agents, workflows, data, obligations and outputs (`engine/data/graph.json`).
- From the change $c$, everything within $k$ hops is exposed: $R_k(c) = \{\, v : d(c, v) \le k \,\}$. The search returns 6 hops and acts on 4.
- A workflow is **high risk** from two booleans plus its rung: does it send data outside the company, and does it carry a legal duty (e.g. SOX 404)?
- The same input always gives the same answer. If every model is down, the blast radius is unchanged: JSON and `key: value` input still work, prose waits in Unmatched, and messages use the template.

## Architecture

```
            ┌───────────────────────────┐        HTTP / JSON        ┌───────────────────────────┐
            │  web/  (console)          │  ───────────────────────▶ │  engine/  (decides)       │
            │  React + TypeScript       │                           │  Python, FastAPI          │
            │  Vite, React Router       │  ◀─────────────────────── │  LangGraph pipeline       │
            └───────────────────────────┘        :5173 → :8000      │  SQLite checkpoints       │
                                                                    └────────────┬──────────────┘
                                                                                 │ two calls only
                                                                                 ▼
                                                                     OpenAI (extract prose,
                                                                     write owner messages)
```

The engine is a LangGraph `StateGraph`:

```
START → extract → gate_start → resolve ─exact / ambiguous→ confirm ──→ search ─any workflow→ score ─live→ act → compose → gate_msg ─ok→ dispatch → END
                                  ▲    └─none→ triage ─┐   (interrupt:     │                    │  └preview→ END      ▲            │
                                  └────────────────────┘    one click)     └─none→ END          │                     └──retry once┘
                                     (interrupt: Unmatched queue)
```

| Node | Who | What it does |
|---|---|---|
| `extract` | code, or the model for prose | Picks an adapter (OSV, VEX, catalog, `key: value`, ChangeEvent) or sends prose through one forced tool call |
| `gate_start` | code | Checks that each field exists on the target type and each version is exact |
| `resolve` | code | Runs the selector on the graph: `exact`, `ambiguous` or `none` |
| `confirm` / `triage` | human (`interrupt()`) | One click to confirm, or map an unmatched change |
| `search` · `score` | code | Reverse BFS and the risk rule |
| `act` | code | Pause or warn, open incidents, create one task per owner |
| `compose` · `gate_msg` | model, then code | Rewrite the message; code rejects any version, advisory id or name not in the incident fields |
| `dispatch` | code | Sends each owner its message (here `var/outbox.jsonl`, standing in for Slack or e-mail) |

Every run is checkpointed in SQLite (`var/radius.db`). A run that stops at any node, including a crash, resumes from the checkpoint with the same result.

## Repository layout

```
.
├── README.md
├── doc/                     brief, task description and flow diagrams
├── engine/                  the decision engine and intake (Python)
│   ├── radius/
│   │   ├── core.py          graph, search, risk rule, incident wording, message gate   (no model)
│   │   ├── intake.py        sniffer, adapters, gate, resolver                          (no model)
│   │   ├── llm.py           the two OpenAI calls: extract a selector, write a message
│   │   ├── pipeline.py      the LangGraph StateGraph
│   │   ├── store.py         state.json: changes, receipts, runs, incidents, tasks, record
│   │   ├── service.py       one object shared by the API, demo and tests
│   │   └── api.py           FastAPI app
│   ├── data/graph.json      seed graph: 45 nodes (8 tools, 11 agents, 11 workflows, 4 data, 2 obligations, 9 outputs)
│   ├── samples/             12 real-shaped inputs, 4 per lane, plus expected.json
│   ├── tests/               pytest suite, one file per task group
│   ├── demo.py              terminal demo, beat by beat
│   └── Makefile
└── web/                     the console (React + TypeScript)
    └── src/
        ├── screens/         Home, Feed, BlastRadius, WorkflowView, Incident, GraphView, Policy, Record, TaskMessage
        ├── components/      Shell, RadiusGraph, WorkflowGraph, ReadCard
        ├── api/             typed client, hooks and the engine contract types
        ├── lib/             layout, reach, flow, formatting and motion helpers
        └── mocks/           fixtures for running the console without the engine
```

> The Python package is still named `radius`, the project's working name before it became ARES.

## Quick start

### Prerequisites

- Python 3.11 and [`uv`](https://github.com/astral-sh/uv)
- Node.js 20+ and npm
- An OpenAI API key (optional: everything except prose input and rewritten messages works without one)

### 1. Run the engine

```bash
cd engine
make install        # creates a Python 3.11 venv with uv and installs dependencies
make test           # offline test suite, about 2 seconds
make reset          # empties var/ and loads yesterday's two changes into the feed
make serve          # API on http://localhost:8000
```

To turn on the two model calls, either export the key or put it in `engine/.env`:

```bash
export OPENAI_API_KEY=sk-...
```

### 2. Run the console

```bash
cd web
npm install
cp .env.example .env    # VITE_API=live, VITE_API_BASE=http://localhost:8000
npm run dev             # http://localhost:5173
```

Use `npm run dev:mock` to run the console on its own with the fixtures in `src/mocks`, with no engine needed.

### 3. Try the demo in the terminal

```bash
cd engine
make demo                                                      # the full demo, beat by beat (resets var/)
.venv/bin/python demo.py --auto                                # the same, without pauses
.venv/bin/python demo.py "OpenAI says gpt-4.1 retires on Friday."   # one change on the current state
```

## Configuration

### Engine

| Variable | Default | Effect |
|---|---|---|
| `OPENAI_API_KEY` | none | Without it, JSON and `key: value` still work, prose waits in Unmatched, messages use the template |
| `OPENAI_MODEL` | `gpt-4.1-mini` | Model for the extractor and owner messages (both at `temperature=0`) |
| `RADIUS_OFFLINE` | off | Set to `1` to make no model calls, even with a key |
| `RADIUS_GRAPH` | `data/graph.json` | Point at a different graph: a new company is a new JSON file, not new code |
| `RADIUS_STATE` | `var/` | Holds `radius.db` (checkpoints), `state.json` (what the API serves) and `outbox.jsonl` |

### Console

| Variable | Default | Effect |
|---|---|---|
| `VITE_API` | `live` | `live` calls the engine; `mock` uses `src/mocks` |
| `VITE_API_BASE` | `http://localhost:8000` | Engine URL |

## API at a glance

| Endpoint | Purpose |
|---|---|
| `GET /graph` | The graph, owners, coverage and unknown agents |
| `POST /changes/parse` | Read a change back without firing it |
| `POST /changes` | Fire a change in `live` or `preview` mode (409 when it is not exact) |
| `GET /changes` | The feed, newest first |
| `GET /runs/{id}` | One run and its blast radius |
| `POST /workflows/{id}/resume` | Resume a paused workflow with a reason (422 without one) |
| `GET /tasks/{id}` · `POST /tasks/{id}/accept` | An owner's task and its incident |
| `POST /tools/{id}/version` | Land a fix: closes the tasks it fixes and resumes what nothing else holds |
| `POST /feed` | Push a feed record; an exact one fires on its own |
| `GET /record` | The append-only record |

Request and response shapes are in [engine/README.md](engine/README.md#endpoints-page-31d--two-engine-only).

## Console screens

| Route | Screen | What it shows |
|---|---|---|
| `/` | Home | Enter a change in any lane and see the read-back card |
| `/changes` | Feed | Every change, its reach and state |
| `/runs/:runId` | Blast Radius | Affected agents, workflows, obligations and outputs; paused, warned and safe |
| `/runs/:runId/workflows/:wfId` | Workflow | One workflow's path from the change and its status |
| `/runs/:runId/incident` | Incident | The incident that names the cause |
| `/task/:taskId` | Task Message | The owner's view: one next step to accept |
| `/graph` | Graph | The whole company graph |
| `/policy` | Policy | Preview what a new rule would stop before adopting it |
| `/record` | Record | The append-only audit trail |

## Sample inputs

`engine/samples/` holds 12 inputs, 4 per lane, with the expected outcome of each in `expected.json`:

| Lane | Samples |
|---|---|
| `feed/` | OSV advisory on `pdf-parse`, VEX advisory on `pdf-parse`, catalog record marking `customers.phone` as personal, EU-models policy |
| `paste/` | OSV version range, VEX on a translate SDK, `key: value` lines, a vendor ChangeEvent |
| `words/` | Vendor e-mail, partial version, vendor field, personal-data sentence |

## Testing

```bash
cd engine && make test        # offline engine suite, ~2 s
cd engine && make test-live   # the 4 prose samples through OpenAI (needs OPENAI_API_KEY)
cd web    && npm test         # console tests: API client normalisation, mock server, layout, reach, policy compare
cd web    && npm run typecheck
```

The engine suite also proves the checkpoint guarantee: a run interrupted at any node resumes with the same result.

## Documentation

- [engine/README.md](engine/README.md): pipeline details, full endpoint contract and where the build differs from the brief
- [doc/TASK_description.md](doc/TASK_description.md): the hackathon task and expected result
- [doc/Radius-Brief-v1.pdf](doc/Radius-Brief-v1.pdf): the design brief
- [doc/radius-simple-flow.pdf](doc/radius-simple-flow.pdf): the flow at a glance
