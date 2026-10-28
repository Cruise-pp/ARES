# Radius engine, MVP

Builder A's core path from the brief, in four files and no database:

```
text ─► intake.py  (JSON → as is · prose → OpenAI, one forced tool call)
     ─► resolve    (code: exact · ambiguous · none)
     ─► core.py    (reverse BFS, risk = sends_external OR serves a duty, pause/warn ≤ 4 hops,
                    seven-line incident, owner message from a template)
     ─► api.py     (FastAPI, state in memory)
```

The model only proposes a selector. Code decides what it reaches and what pauses.

## Run

```bash
cd engine
uv venv --python 3.11 .venv && uv pip install --python .venv/bin/python -r requirements.txt   # first time only

.venv/bin/python demo.py                         # S1–S3 in the terminal (no key: JSON changes)
export OPENAI_API_KEY=sk-...                     # optional: OPENAI_MODEL (default gpt-4.1-mini)
.venv/bin/python demo.py                         # the same three, sent as sentences
.venv/bin/python demo.py "gpt-4.1 retires Friday"

.venv/bin/uvicorn api:app --port 8000            # the API for the screens
```

The graph is `data/graph.json` (238 nodes). A different graph is a different JSON file, not new code.

## Endpoints

`GET /graph` · `POST /changes/parse {text}` · `POST /changes {change, mode}` (409 if not exact) ·
`GET /changes` · `GET /runs/{id}` · `GET /tasks/{id}` · `POST /workflows/{id}/resume {reason}` (422 if empty)

Not in the MVP yet: `POST /tasks/{id}/accept`, `POST /tools/{id}/version` (fix lands → resume),
feed adapters (OSV, VEX, `key: value`), a model-written owner message, persistence, tests.
