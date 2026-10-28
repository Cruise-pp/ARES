"""The page-31d endpoints the demo needs. State is in memory: restart the server to reset."""
from __future__ import annotations

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from core import Engine
from intake import parse, resolve

app = FastAPI(title="Radius MVP")
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173"], allow_methods=["*"], allow_headers=["*"])
engine = Engine()


class ParseBody(BaseModel):
    text: str


class FireBody(BaseModel):
    change: dict
    mode: str = "live"


class ResumeBody(BaseModel):
    reason: str = ""


@app.get("/graph")
def graph():
    g = engine.g
    return {"nodes": list(g.nodes.values()), "edges": g.edges(), "owners": list(g.owners.values())}


@app.post("/changes/parse")
def changes_parse(body: ParseBody):
    return parse(engine.g, body.text)


@app.post("/changes")
def changes_fire(body: FireBody):
    card = resolve(engine.g, body.change)
    if card["state"] != "exact":
        raise HTTPException(409, {"change": body.change, **card})
    return engine.fire(body.change, body.mode)


@app.get("/changes")
def changes_list():
    rows = []
    for r in reversed(engine.runs.values()):
        c = r["counts"]
        state = "preview" if r["mode"] == "preview" else \
            f"{c['paused']} paused" if c["paused"] else f"{c['warned']} warned" if c["warned"] else "no impact"
        rows.append({"change_id": r["run_id"], "title": r["change"].get("title"), "kind": r["change"].get("kind"),
                     "reach": f"{c['agents']} agents · {c['workflows']} workflows", "state": state})
    return rows


@app.get("/runs/{run_id}")
def run(run_id: str):
    if run_id not in engine.runs:
        raise HTTPException(404, "no such run")
    return engine.runs[run_id]


@app.get("/tasks/{task_id}")
def task(task_id: str):
    t = engine.tasks.get(task_id)
    if not t:
        raise HTTPException(404, "no such task")
    return {"task": t, "incident": engine.incidents.get(t["incident_id"])}


@app.post("/workflows/{wf_id}/resume")
def resume(wf_id: str, body: ResumeBody):
    try:
        return engine.resume(wf_id, body.reason)
    except ValueError as e:
        raise HTTPException(422, str(e))
