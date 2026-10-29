# Radius engine (Builder A)

The engine and the intake: everything that decides. A change comes in as a feed record, a pasted
advisory or a sentence. The engine reads it back, walks the graph, pauses high-risk workflows,
opens seven-line incidents and gives each owner one next step. Screens are Builder B's (`/web`).

## The pipeline (pages 24 and 24a), in LangGraph

```
START → extract → gate_start → resolve ─exact / ambiguous→ confirm ──→ search ─any workflow→ score ─live→ act → compose → gate_msg ─ok→ dispatch → END
                                  ▲    └─none→ triage ─┐   (interrupt:     │                    │  └preview→ END      ▲            │
                                  └────────────────────┘    one click)     └─none→ END          │                     └──retry once┘
                                     (interrupt: Unmatched queue)
```

| Node | Who | What it does |
|---|---|---|
| `extract` | code, or the model for prose | A sniffer picks the adapter: OSV (`affected`), CycloneDX VEX (`vulnerabilities`), catalog record (`table`/`column`), `key: value` lines, or a ChangeEvent. Anything else is prose: one forced OpenAI tool call. |
| `gate_start` | code | "Does each field exist on the target type?" "Is each version exact?" Answers go into the receipt. |
| `resolve` | code | The selector runs on the graph: `exact`, `ambiguous` or `none`. |
| `confirm` | `interrupt()` | A feed with an exact match fires on its own. Every other card waits for one click (`POST /changes`). |
| `triage` | `interrupt()` | The Unmatched queue: the run waits until a person maps the change. |
| `search` · `score` | code | Reverse BFS (6 hops returned, actions at 4) and the risk rule (two booleans + the workflow's rung). |
| `act` | code | Pause or warn, one incident per pause, one task per owner, the template message at once. |
| `compose` · `gate_msg` | model, then code | The model rewrites each message from the incident fields only. Code rejects any version, advisory id or name not in the fields. One retry, then the template. |
| `dispatch` | code | Sends each owner its message (here: `var/outbox.jsonl`, standing in for Slack or e-mail). |

The checkpointer (`SqliteSaver`, `var/radius.db`) keeps every run. A run that stops at any node,
including a crash, resumes from the checkpoint with the same result (tested). No model sits between
`resolve` and `act`: if every model is down, the blast radius is unchanged.

## Run it

```bash
make install       # Python 3.11 venv via uv, then deps
make test          # A1-A7: 35 tests, offline, ~2 s
make demo          # page 31, beat by beat, in the terminal (resets var/)
make reset         # empty var/ + yesterday's two changes in the feed (restart the server after)
make serve         # the API on :8000

# turns on the two model calls: prose in, owner message out
# either export it, or put OPENAI_API_KEY=... in engine/.env (the server reads that file)
export OPENAI_API_KEY=sk-...
make test-live                 # the 4 prose samples through the model
.venv/bin/python demo.py "OpenAI says gpt-4.1 retires on Friday."
```

| Setting | Default | What it does |
|---|---|---|
| `OPENAI_API_KEY` | — | Without it: JSON and `key: value` still work, prose waits in Unmatched, messages use the template |
| `OPENAI_MODEL` | `gpt-4.1-mini` | Extractor and owner-message model. Both calls send `temperature=0` |
| `RADIUS_OFFLINE=1` | off | No model calls, even with a key |
| `RADIUS_GRAPH` | `data/graph.json` | A different graph is a different JSON file, not new code |
| `RADIUS_STATE` | `var/` | `radius.db` (LangGraph checkpoints), `state.json` (what the API serves, readable), `outbox.jsonl` |

## Files

```
radius/core.py      graph, search, risk rule, incident wording, message template and gate   (no model)
radius/intake.py    sniffer, adapters, gate, resolver                                         (no model)
radius/llm.py       the two OpenAI calls: extract a selector, write a message
radius/pipeline.py  the LangGraph StateGraph above
radius/store.py     state.json: changes, receipts, runs, incidents, tasks, the record
radius/service.py   Radius: one object the API, demo and tests share; fix lands; yesterday's feed
radius/api.py       FastAPI
samples/            12 real-shaped inputs, 4 per lane, and expected.json
tests/              one file per task group, plus the page-31d S1 fixture
```

## Endpoints (page 31d) + two engine-only

| Endpoint | Body | Returns |
|---|---|---|
| `GET /graph` | — | `{nodes, edges, synced_at, coverage, owners, unknown_agents}` |
| `POST /changes/parse` | `{text, lane?}` | `ParsedChange {change, state, matches, candidates, readback, reason}` |
| `POST /changes` | `{change, mode: "live"\|"preview"}` | `Run`; **409** + `ParsedChange` when the card is not exact |
| `GET /changes` | — | `FeedRow[] {change_id, title, kind, reach, state, at}`, newest first |
| `GET /runs/{id}` | — | `Run` |
| `POST /workflows/{id}/resume` | `{reason}` | `Verdict`; **422** when the reason is empty |
| `GET /tasks/{id}` | — | `{task, incident}`; `incident` is `null` for a warning |
| `POST /tasks/{id}/accept` | — | `Task` |
| `POST /tools/{id}/version` | `{version}` | `Verdict[]`: tasks the version fixes close; workflows nothing else holds resume |
| `POST /feed` | `{payload}` | `{parsed}` or `{parsed, run}`: an exact feed fires on its own |
| `GET /record` | — | the append-only record: fired, paused, warned, resumed (with reason), closed, dispatched |

To pick an ambiguous candidate, send the same change (same `id`) with
`where: {all: [{field: "id", op: "eq", value: <candidate id>}]}`. The run that waits at `confirm` resumes.
To map an unmatched change, do the same with a selector that resolves: the run waiting at `triage` resumes.

## Where this differs from the brief

1. **No Jev.** Both gates are code only. The receipt keeps the two questions and the code's answers.
2. **OpenAI, not Anthropic,** called with the OpenAI SDK directly (no LangChain). Same contract:
   one forced `emit_change` tool call at temperature 0, and the message model sees the incident fields only.
3. **A change aimed at an obligation or an output** ("SOX 404 changed") walks SERVES/SENDS backward at
   hop 0 only. Without it, that change reaches nothing. S1-S3 do not change.
4. **Graph size.** 45 nodes and 44 links: the demo paths only, so a blast radius stays readable.
