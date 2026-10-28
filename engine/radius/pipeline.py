"""The LangGraph pipeline (page 24, with resolve and confirm from page 24a). Jev is left out:
both gates are code.

    START → extract → gate_start → resolve ─exact/ambiguous→ confirm ─→ search ─any workflow→ score ─live→ act
                                     ▲     └─none→ triage ─┘    (interrupt: one click)       │            │    └preview→ END
                                     └─────── (interrupt: Unmatched, a person maps it)       └none→ END   ▼
                                                                         dispatch ←ok─ gate_msg ←─ compose ◄─┐
                                                                                         └─retry once───────┘

Every box is a node and every diamond is a conditional edge. interrupt() is the confirm click
and the Unmatched queue: the run stops, waits for a person, and resumes on the same state. The
SqliteSaver checkpoint keeps every run, so a run stopped at any node resumes with the same result.
The search and the risk rule are plain functions from core.py; no model sits between resolve and act.
"""
from __future__ import annotations

import json
import time
from typing import TYPE_CHECKING, Any, TypedDict

from langgraph.graph import END, START, StateGraph
from langgraph.types import interrupt

from . import llm
from .core import blast_radius, check_message, conds, counts, incident_fields, reached_rows, score, template
from .intake import adapt, gate, listify, resolve, sniff

if TYPE_CHECKING:
    from .service import Radius


class RadiusState(TypedDict, total=False):
    change_id: str
    raw: str             # the notice as it arrived
    lane: str            # feed | paste | words
    change: dict | None  # the ChangeEvent (page 07b)
    receipt: str         # every parse leaves one: raw text, tool call, gate answers, resolver result
    error: str | None    # why nothing could be read
    card: dict           # the read-back card: state, matches, candidates, readback, reason
    confirmed_by: str    # feed | person
    mode: str            # live | preview
    run_id: str
    reached: dict        # id -> {hops, path, via}
    verdicts: list[dict]
    drafts: dict         # task id -> {text, by, tries, invented}


def build_pipeline(r: "Radius", checkpointer: Any, interrupt_after: tuple[str, ...] = ()):
    g, store = r.g, r.store

    # ---- intake ------------------------------------------------------------------------------

    def extract(s: RadiusState) -> dict:
        """Step 1-2 of page 24a: a sniffer picks the adapter; only prose goes to the model."""
        raw, cid = s["raw"], s["change_id"]
        adapter, doc = sniff(raw)
        change, error, tool_call, by, confidence = None, None, None, "code", 1.0
        if adapter != "prose":
            try:
                change = adapt(adapter, doc, g)
            except (KeyError, IndexError, TypeError, ValueError) as e:
                error = f"the {adapter} adapter could not read it: {e}"
            adapter = adapter if change or error else "prose"
        if adapter == "prose":
            try:
                tool_call = llm.extract(raw)
                change = {k: tool_call[k] for k in ("kind", "title", "target", "where", "effect") if k in tool_call}
                by, confidence = "model", tool_call.get("confidence")
            except llm.ModelDown as e:
                error = f"the model is unavailable, so prose waits in Unmatched ({e})"
        lane = s.get("lane") or ("words" if adapter == "prose" else "paste")
        receipt = store.next_id("receipt")
        store.put("receipts", receipt, {"id": receipt, "at": store.now(), "change_id": cid, "lane": lane,
                                        "adapter": adapter, "raw": raw, "tool_call": tool_call,
                                        "model": llm.MODEL if by == "model" else None, "error": error})
        if change:
            named = " ".join(str(v) for c in conds(change) for v in listify(c["value"]))  # "pdf-parse 2.1"
            change = {"id": cid, "kind": "other", "title": change.get("effect", {}).get("ref") or named or "external change",
                      **change, "mode": "live", "source": {"lane": lane, "raw": raw},
                      "parse": {"by": by, "confidence": confidence, "receipt": receipt, "adapter": adapter}}
            change["id"] = cid
        return {"lane": lane, "change": change, "error": error, "receipt": receipt}

    def gate_start(s: RadiusState) -> dict:
        """Step 3: two closed questions, answered by code. The answers go into the receipt."""
        if s.get("change"):
            store.update("receipts", s["receipt"], gate=gate(s["change"]))
        return {}

    def resolve_node(s: RadiusState) -> dict:
        """Step 4: the selector runs on the graph. exact, ambiguous or none."""
        change = s.get("change")
        if change:
            card = resolve(g, change)
            store.update("receipts", s["receipt"], resolver={k: card[k] for k in ("state", "matches", "reason")})
        else:
            card = {"state": "none", "matches": [], "candidates": [], "readback": "", "reason": s.get("error")}
        prev = store.get("changes", s["change_id"]) or {}
        store.put("changes", s["change_id"], {
            **prev, "change_id": s["change_id"], "at": prev.get("at") or store.now(), "lane": s.get("lane"),
            "title": (change or {}).get("title") or s["raw"].strip().splitlines()[0][:80],
            "kind": (change or {}).get("kind", "other"), "card": card["state"], "reason": card["reason"]})
        return {"card": card}

    def take_answer(s: RadiusState, answer: dict, by: str) -> dict:
        """A person's answer: the same change, or one they edited (a picked candidate, a mapped field)."""
        change = {**(s.get("change") or {}), **answer["change"], "id": s["change_id"]}
        change.setdefault("source", {"lane": s.get("lane"), "raw": s["raw"]})
        change.setdefault("parse", {"by": "person", "confidence": None, "receipt": s["receipt"]})
        change["mode"] = answer.get("mode", "live")
        return {"change": change, "card": resolve(g, change), "mode": change["mode"], "confirmed_by": by}

    def confirm(s: RadiusState) -> dict:
        """The read-back card. A feed with an exact match fires on its own; everything else waits for one click."""
        if s["card"]["state"] == "exact" and (s.get("confirmed_by") or s.get("lane") == "feed"):
            return {"confirmed_by": s.get("confirmed_by") or "feed", "mode": s.get("mode") or "live"}
        return take_answer(s, interrupt({"waiting": "confirm", "card": s["card"]}), "person")

    def triage(s: RadiusState) -> dict:
        """The Unmatched queue (page 18): the run waits here until a person maps the change."""
        return take_answer(s, interrupt({"waiting": "triage", "card": s["card"]}), "person")

    # ---- the core: no model from here to act -------------------------------------------------

    def search(s: RadiusState) -> dict:
        t0 = time.perf_counter()
        reached = blast_radius(g, s["card"]["matches"])
        run_id = store.next_id("run")
        change = {**s["change"], "mode": s.get("mode", "live")}
        store.put("runs", run_id, {
            "run_id": run_id, "mode": change["mode"], "elapsed_ms": round((time.perf_counter() - t0) * 1000, 2),
            "change": change, "counts": counts(g, reached, []), "reached": reached_rows(g, reached),
            "verdicts": [], "incidents": [], "tasks": []})
        store.update("changes", s["change_id"], run_id=run_id, mode=change["mode"])
        return {"reached": reached, "run_id": run_id}

    def score_node(s: RadiusState) -> dict:
        t0 = time.perf_counter()
        verdicts = score(g, s["reached"])
        run = store.get("runs", s["run_id"])
        store.update("runs", s["run_id"], verdicts=verdicts, counts=counts(g, s["reached"], verdicts),
                     elapsed_ms=round(run["elapsed_ms"] + (time.perf_counter() - t0) * 1000, 2))
        return {"verdicts": verdicts}

    def act(s: RadiusState) -> dict:
        """Pause the high-risk workflows, warn the rest, one incident per pause, one task per owner.
        Each task gets the template message at once, so a pause never waits on a network."""
        run_id, change = s["run_id"], s["change"]
        if store.get("runs", run_id)["tasks"]:
            return {}  # already acted: a resumed run never pauses twice
        store.log("fired", change_id=change["id"], run_id=run_id, title=change.get("title"), lane=s.get("lane"),
                  confirmed_by=s.get("confirmed_by"))
        if change["effect"]["type"] == "add_label":  # the column now carries the label in the graph
            for m in s["card"]["matches"]:
                labels = g.nodes[m].get("labels") or []
                if change["effect"].get("label") and change["effect"]["label"] not in labels:
                    r.set_node(m, "labels", [*labels, change["effect"]["label"]])
        incidents, tasks = [], []
        order = sorted(s["verdicts"], key=lambda v: ({"paused": 0, "warned": 1}.get(v["action"], 2),
                                                      not g.outgoing(v["workflow_id"], ["SERVES"]), v["workflow_id"]))
        for v in order:
            wf = v["workflow_id"]
            if v["action"] == "none":
                store.log("observed", run_id=run_id, workflow_id=wf)
                continue
            path = s["reached"][wf]["path"]
            fields = incident_fields(g, change, path, wf)
            inc_id = None
            if v["action"] == "paused":
                inc_id = store.next_id("incident")
                was = "still paused" if g.nodes[wf].get("state") == "paused" else "paused"
                r.set_node(wf, "state", "paused")
                store.put("incidents", inc_id, {"id": inc_id, **fields, "action": f"{was} at {store.clock_line()}",
                                                "workflow_id": wf, "change_id": change["id"], "run_id": run_id,
                                                "path_ids": path, "state": "open", "opened_at": store.now()})
                incidents.append(inc_id)
            store.log(v["action"], run_id=run_id, workflow_id=wf, incident_id=inc_id, risk=fields["risk"])
            task_id = r.new_task_id(wf)
            store.put("tasks", task_id, {
                "id": task_id, "owner_id": g.nodes[wf].get("owner_id") or "unowned", "workflow_id": wf,
                "incident_id": inc_id, "message": template(g, change, wf, v["action"], fields, path[0]),
                "state": "open", "change_id": change["id"], "start_id": path[0], "action": v["action"],
                "message_by": "template", "fields": fields})
            tasks.append(task_id)
        store.update("runs", run_id, incidents=incidents, tasks=tasks)
        return {"drafts": {}}

    # ---- outbound language: the model writes, code checks, one retry, then the template ------

    def compose(s: RadiusState) -> dict:
        drafts = dict(s.get("drafts") or {})
        for tid in store.get("runs", s["run_id"])["tasks"]:
            d = drafts.get(tid)
            if d and d["ok"]:
                continue
            task = store.get("tasks", tid)
            try:
                text = llm.write_message(task["fields"], feedback=", ".join(d["invented"]) if d else None)
                drafts[tid] = {"text": text, "by": "model", "tries": (d["tries"] if d else 0) + 1, "ok": None}
            except llm.ModelDown:
                drafts[tid] = {"text": task["message"], "by": "template", "tries": 0, "ok": True, "invented": []}
        return {"drafts": drafts}

    def gate_msg(s: RadiusState) -> dict:
        drafts = dict(s["drafts"])
        for tid, d in drafts.items():
            if d["ok"] is not None:
                continue
            invented = check_message(g, d["text"], store.get("tasks", tid)["fields"])
            if not invented:
                drafts[tid] = {**d, "ok": True, "invented": []}
            elif d["tries"] >= 2:  # one retry, then the template: a message always goes out
                drafts[tid] = {"text": store.get("tasks", tid)["message"], "by": "template", "tries": d["tries"],
                               "ok": True, "invented": invented}
            else:
                drafts[tid] = {**d, "ok": False, "invented": invented}
        return {"drafts": drafts}

    def dispatch(s: RadiusState) -> dict:
        """Send each owner one message. The outbox file stands in for Slack or e-mail."""
        for tid, d in s["drafts"].items():
            task = store.update("tasks", tid, message=d["text"], message_by=d["by"])
            owner = g.owners.get(task["owner_id"], {})
            with open(r.dir / "outbox.jsonl", "a") as f:
                f.write(json.dumps({"at": store.now(), "to": owner.get("channel", task["owner_id"]),
                                    "task_id": tid, "message": d["text"]}, ensure_ascii=False) + "\n")
            store.log("dispatched", task_id=tid, to=owner.get("channel"), by=d["by"], gate_rejected=d.get("invented"))
        return {}

    # ---- the diamonds ------------------------------------------------------------------------

    def matched(s: RadiusState) -> str:
        return "triage" if s["card"]["state"] == "none" else "confirm"

    def confirmed(s: RadiusState) -> str:
        return "search" if s["card"]["state"] == "exact" else "confirm"

    def any_workflow(s: RadiusState) -> str:
        return "score" if any(g.type(k) == "workflow" for k in s["reached"]) else END

    def live_or_preview(s: RadiusState) -> str:
        return "act" if s.get("mode", "live") == "live" and s["verdicts"] else END

    def msg_ok(s: RadiusState) -> str:
        return "dispatch" if all(d["ok"] for d in s["drafts"].values()) else "compose"

    sg = StateGraph(RadiusState)
    for name, fn in [("extract", extract), ("gate_start", gate_start), ("resolve", resolve_node),
                     ("confirm", confirm), ("triage", triage), ("search", search), ("score", score_node),
                     ("act", act), ("compose", compose), ("gate_msg", gate_msg), ("dispatch", dispatch)]:
        sg.add_node(name, fn)
    sg.add_edge(START, "extract")
    sg.add_edge("extract", "gate_start")
    sg.add_edge("gate_start", "resolve")
    sg.add_conditional_edges("resolve", matched, ["confirm", "triage"])
    sg.add_edge("triage", "resolve")
    sg.add_conditional_edges("confirm", confirmed, ["search", "confirm"])
    sg.add_conditional_edges("search", any_workflow, ["score", END])
    sg.add_conditional_edges("score", live_or_preview, ["act", END])
    sg.add_edge("act", "compose")
    sg.add_edge("compose", "gate_msg")
    sg.add_conditional_edges("gate_msg", msg_ok, ["dispatch", "compose"])
    sg.add_edge("dispatch", END)
    return sg.compile(checkpointer=checkpointer, interrupt_after=list(interrupt_after))
