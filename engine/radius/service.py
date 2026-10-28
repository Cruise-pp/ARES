"""Radius as one object: the graph, the store and the pipeline. The API, the demo and the tests use it.

    python -m radius.service reset    # empty var/, then give the feed yesterday's two changes
"""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import sys
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.types import Command

from .core import GRAPH_PATH, Graph, at_least, conds, risk
from .intake import listify, resolve
from .pipeline import build_pipeline
from .store import Store

VAR = Path(os.environ.get("RADIUS_STATE", Path(__file__).resolve().parent.parent / "var"))


class NotExact(Exception):
    def __init__(self, parsed: dict):
        super().__init__(parsed["reason"])
        self.parsed = parsed


class Radius:
    def __init__(self, state_dir: Path = VAR, graph_path: Path = Path(os.environ.get("RADIUS_GRAPH", GRAPH_PATH)),
                 background: bool = False, interrupt_after: tuple[str, ...] = ("act",), clock=None):
        """interrupt_after=("act",): a fire returns as soon as the pauses are in, and the owner
        messages (a model call each) finish after it, inline or on a background thread."""
        self.dir = Path(state_dir)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.store = Store(self.dir / "state.json", clock)
        self.g = Graph(graph_path)
        for nid, fields in self.store.data["overrides"].items():  # graph edits survive a restart
            for field, value in fields.items():
                self.g.set(nid, field, value)
        self.background = background
        self.conn = sqlite3.connect(self.dir / "radius.db", check_same_thread=False)
        self.app = build_pipeline(self, SqliteSaver(self.conn), interrupt_after)

    # ---- the pipeline ------------------------------------------------------------------------

    def _cfg(self, cid: str) -> dict:
        return {"configurable": {"thread_id": cid}}

    def waiting_at(self, cid: str) -> str | None:
        """The node a change's run is stopped before: confirm, triage, compose, ... or None when done."""
        nxt = self.app.get_state(self._cfg(cid)).next
        return nxt[0] if nxt else None

    def values(self, cid: str) -> dict:
        return self.app.get_state(self._cfg(cid)).values

    def _finish(self, cid: str) -> None:
        """Past act, only the messages are left: write, check, send."""
        if self.waiting_at(cid) not in (None, "confirm", "triage"):
            if self.background:
                threading.Thread(target=self.app.invoke, args=(None, self._cfg(cid)), daemon=True).start()
            else:
                self.app.invoke(None, self._cfg(cid))

    def parsed(self, cid: str) -> dict:
        v = self.values(cid)
        card = v["card"]
        return {"change": v.get("change"), "state": card["state"], "matches": card["matches"],
                "candidates": card["candidates"], "readback": card["readback"], "reason": card["reason"]}

    def parse(self, text: str, lane: str | None = None) -> dict:
        """POST /changes/parse: a new run that stops at the card (or, for an exact feed, fires)."""
        cid = self.store.next_id("change")
        self.app.invoke({"change_id": cid, "raw": text, "lane": lane}, self._cfg(cid))
        self._finish(cid)
        return self.parsed(cid)

    def feed(self, payload: str) -> dict:
        """POST /feed: an exact feed fires on its own; anything else waits like a paste."""
        parsed = self.parse(payload, lane="feed")
        run_id = self.values(parsed["change"]["id"]).get("run_id") if parsed["change"] else None
        return {"parsed": parsed, **({"run": self.run(run_id)} if run_id else {})}

    def fire(self, change: dict, mode: str = "live") -> dict:
        """POST /changes: the click on the card. Resumes the run that waits for it, or starts one."""
        card = resolve(self.g, change)
        if card["state"] != "exact":
            raise NotExact({"change": change, **card})
        cid = change.get("id")
        if not (cid and self.waiting_at(cid) in ("confirm", "triage")):
            cid = self.store.next_id("change")
            self.app.invoke({"change_id": cid, "raw": json.dumps(change), "lane": "paste"}, self._cfg(cid))
        self.app.invoke(Command(resume={"change": change, "mode": mode}), self._cfg(cid))
        run_id = self.values(cid).get("run_id")
        self._finish(cid)
        return self.run(run_id)

    # ---- reads -------------------------------------------------------------------------------

    def run(self, run_id: str | None) -> dict | None:
        return self.store.get("runs", run_id) if run_id else None

    def task(self, task_id: str) -> dict | None:
        t = self.store.get("tasks", task_id)
        if not t:
            return None
        return {"task": {k: v for k, v in t.items() if k != "fields"},
                "incident": self.store.get("incidents", t["incident_id"]) if t["incident_id"] else None}

    def graph_view(self) -> dict:
        g = self.g
        return {"nodes": list(g.nodes.values()), "edges": g.edges(), "synced_at": g.synced_at,
                "coverage": g.coverage(), "owners": list(g.owners.values()), "unknown_agents": g.unknown_agents()}

    def changes(self) -> list[dict]:
        """GET /changes: the feed, newest first. A card still waiting for its click is not in it."""
        rows = []
        for c in sorted(self.store.all("changes"), key=lambda c: (c["at"], c["change_id"]), reverse=True):
            run = self.run(c.get("run_id"))
            if not run and c["card"] != "none":
                continue
            n = run["counts"] if run else {"agents": 0, "workflows": 0}
            rows.append({"change_id": c["change_id"], "title": c["title"], "kind": c["kind"],
                         "reach": f"{n['agents']} agents · {n['workflows']} workflows",
                         "state": self._row_state(run), "at": c["at"]})
        return rows

    def _row_state(self, run: dict | None) -> str:
        if not run:
            return "unmatched"
        if run["mode"] == "preview":
            return "preview"
        if not run["verdicts"]:
            return "no impact"
        tasks = [self.store.get("tasks", t) for t in run["tasks"]]
        open_inc = [self.store.get("incidents", t["incident_id"]) for t in tasks if t["incident_id"]]
        open_inc = [i for i in open_inc if i["state"] == "open"]
        paused = [i for i in open_inc if self.g.nodes[i["workflow_id"]]["state"] == "paused"]
        if paused:
            return f"{len(paused)} paused"
        if open_inc:
            return f"{len(open_inc)} open"  # resumed by hand, the fix has not landed
        warned = [t for t in tasks if t["action"] == "warned" and t["state"] != "closed"]
        return f"{len(warned)} warned" if warned else "cleared"

    def record(self) -> list[dict]:
        return self.store.data["record"]

    # ---- writes ------------------------------------------------------------------------------

    def set_node(self, nid: str, field: str, value) -> None:
        self.g.set(nid, field, value)
        self.store.override(nid, field, value)

    def new_task_id(self, wf: str) -> str:
        base = "t_" + wf.removeprefix("wf_")
        tid, n = base, 1
        while self.store.get("tasks", tid):
            n += 1
            tid = f"{base}_{n}"
        return tid

    def _verdict(self, wf: str) -> dict:
        return {"workflow_id": wf, "risk": risk(self.g, wf),
                "action": "paused" if self.g.nodes[wf]["state"] == "paused" else "none"}

    def resume(self, wf: str, reason: str) -> dict:
        """Symmetry (page 33): a pause has a way back, in the same place. It needs a reason."""
        if wf not in self.g.nodes or self.g.type(wf) != "workflow":
            raise KeyError(wf)
        if not reason.strip():
            raise ValueError("a resume needs a reason")
        self.set_node(wf, "state", "running")
        self.store.log("resumed", workflow_id=wf, reason=reason, by="person")
        return self._verdict(wf)

    def accept(self, task_id: str) -> dict:
        task = self.store.get("tasks", task_id)
        if task is None:
            raise KeyError(task_id)
        if task["state"] == "open":
            task = self.store.update("tasks", task_id, state="accepted")
            self.store.log("accepted", task_id=task_id, owner_id=task["owner_id"])
        return {k: v for k, v in task.items() if k != "fields"}

    def close_task(self, task_id: str, note: str) -> None:
        task = self.store.update("tasks", task_id, state="closed")
        if task["incident_id"]:
            self.store.update("incidents", task["incident_id"], state="closed")
        self.store.log("closed", task_id=task_id, incident_id=task["incident_id"], reason=note)

    def tool_version(self, tool_id: str, version: str) -> list[dict]:
        """POST /tools/{id}/version: a new version lands. Close what it fixes; resume what nothing else holds."""
        if tool_id not in self.g.nodes or self.g.type(tool_id) != "tool":
            raise KeyError(tool_id)
        old = self.g.nodes[tool_id]["version"]
        self.set_node(tool_id, "version", version)
        self.store.log("version_changed", tool_id=tool_id, old=old, new=version)
        touched = []
        for task in self.store.all("tasks"):
            if task["state"] == "closed" or task["start_id"] != tool_id:
                continue
            change = self.store.get("runs", self.store.get("changes", task["change_id"])["run_id"])["change"]
            fix = change["effect"].get("fix")
            affected = [str(v) for c in conds(change) if c["field"] == "version" for v in listify(c["value"])]
            if fix and at_least(version, fix) or not fix and version not in affected:
                self.close_task(task["id"], f"{self.g.nodes[tool_id]['name']} {version} landed")
                touched.append(task["workflow_id"])
        for wf in sorted(set(touched)):
            still_open = [i for i in self.store.all("incidents") if i["workflow_id"] == wf and i["state"] == "open"]
            if self.g.nodes[wf]["state"] == "paused" and not still_open:
                self.set_node(wf, "state", "running")
                self.store.log("resumed", workflow_id=wf, reason=f"fix landed: {self.g.label(tool_id)}", by="radius")
        return [self._verdict(wf) for wf in sorted(set(touched))]


# ---- yesterday's feed (page 12) --------------------------------------------------------------

LIBXML = "tool: libxml\nversion: 2.9.1\necosystem: system\ncve: CVE-2026-4390\nfixed: 2.9.2"
ORDERS_EMAIL = json.dumps({"event": "classification.changed", "id": "DC-8809", "table": "orders",
                           "column": "email", "classification": "PII", "steward": "K. Osei"})


def reset(state_dir: Path = VAR) -> Radius:
    """Empty the state, then replay two changes from yesterday through the real pipeline, both cleared.
    Ids are set so the live demo still opens chg_0142, rcpt_88 and INC-2041, as on the pages."""
    shutil.rmtree(state_dir, ignore_errors=True)
    when = {"t": datetime.now(timezone.utc) - timedelta(hours=27)}
    env, os.environ["RADIUS_OFFLINE"] = os.environ.get("RADIUS_OFFLINE"), "1"  # history needs no model
    try:
        r = Radius(state_dir, clock=lambda: when["t"])
        r.store.set_counter("change", 139)
        r.store.set_counter("receipt", 85)
        r.store.set_counter("incident", 2031)
        r.feed(LIBXML)  # an exact feed fires on its own
        when["t"] += timedelta(hours=2)
        r.tool_version("tl_libxml_291", "2.9.2")
        when["t"] += timedelta(hours=1)
        run = r.feed(ORDERS_EMAIL)["run"]
        when["t"] += timedelta(hours=3)
        for tid in run["tasks"]:
            r.close_task(tid, "Owner confirmed orders.email is processed under GDPR Art. 6")
        r.store.set_counter("change", 142)
        r.store.set_counter("receipt", 88)
        r.store.set_counter("incident", 2041)
        r.conn.close()
    finally:
        if env is None:
            os.environ.pop("RADIUS_OFFLINE")
        else:
            os.environ["RADIUS_OFFLINE"] = env
    return Radius(state_dir)


if __name__ == "__main__" and sys.argv[1:] == ["reset"]:
    r = reset()
    for row in r.changes():
        print(f"  {row['change_id']}  {row['title']:<34} {row['reach']:<24} {row['state']}")
