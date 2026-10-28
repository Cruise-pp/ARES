"""Radius MVP core: selector -> reverse search -> risk -> pause/warn, incident, owner message.

No model in this file. The same change on the same graph gives the same answer (page 23).
"""
from __future__ import annotations

import json
import time
from collections import defaultdict, deque
from pathlib import Path

GRAPH_PATH = Path(__file__).resolve().parent / "data" / "graph.json"

# The only fields a selector may name (page 21).
FIELDS = {
    "tool": ("id", "name", "version", "ecosystem", "owner_id"),
    "data": ("id", "table", "column", "labels", "owner_id"),
    "agent": ("id", "name", "model_id", "model_region", "owner_id"),
    "workflow": ("id", "name", "owner_id", "sends_external", "state"),
    "obligation": ("id", "name", "authority", "owner_id"),
    "output": ("id", "name", "channel", "volume"),
}
BACKWARD = ("RUNS_ON", "READS", "INVOKES")  # tool/data <- agent <- workflow
FORWARD = ("SERVES", "SENDS")               # workflow -> obligation / output
MAX_HOPS = 6     # the reach returned to the screen
ACTION_HOPS = 4  # pause or warn only this close to the change


class Graph:
    def __init__(self, path: Path = GRAPH_PATH):
        doc = json.loads(Path(path).read_text())
        self.owners = {o["id"]: o for o in doc["owners"]}
        self.nodes: dict[str, dict] = {}
        self.out: dict[str, list] = defaultdict(list)
        self.inc: dict[str, list] = defaultdict(list)
        for raw in doc["nodes"]:
            self.nodes[raw["id"]] = {k: v for k, v in raw.items() if k != "edges"}
            for edge in raw.get("edges", []):
                for etype, dst in edge.items():
                    self.out[raw["id"]].append((dst, etype))
                    self.inc[dst].append((raw["id"], etype))
        for adj in (self.out, self.inc):
            for k in adj:
                adj[k].sort()

    def of_type(self, t: str) -> list[str]:
        return sorted(i for i, n in self.nodes.items() if n["type"] == t)

    def outgoing(self, nid: str, types) -> list[tuple[str, str]]:
        return [(n, t) for n, t in self.out[nid] if t in types]

    def incoming(self, nid: str, types) -> list[tuple[str, str]]:
        return [(n, t) for n, t in self.inc[nid] if t in types]

    def label(self, nid: str) -> str:
        n = self.nodes[nid]
        if n["type"] == "tool":
            return f"{n['name']} {n['version']}"
        if n["type"] == "data":
            return f"{n['table']}.{n['column']}"
        return n["name"]

    def owner(self, nid: str) -> str:
        o = self.owners.get(self.nodes[nid].get("owner_id") or "")
        return f"{o['team']} · {o['person']}" if o else "unowned"

    def edges(self) -> list[dict]:
        return [{"from": s, "to": d, "type": t} for s in sorted(self.out) for d, t in self.out[s]]

    def select(self, target: str, where: dict) -> list[str]:
        conds = where.get("all") or where.get("any") or []
        test = all if "all" in where else any
        return [i for i in self.of_type(target) if test(match(self.nodes[i], c) for c in conds)]


def match(node: dict, cond: dict) -> bool:
    """A missing value fails a positive test and passes a negative one: unknown is never safe."""
    op, want = cond["op"], cond["value"]
    have = node.get(cond["field"])
    if have is None or have == []:
        return op in ("neq", "not_in")
    norm = lambda v: str(v).strip().lower()  # True -> "true", so booleans compare as text too
    haves = [norm(v) for v in (have if isinstance(have, list) else [have])]
    wants = [norm(v) for v in (want if isinstance(want, list) else [want])]
    if op == "eq":
        return wants[0] in haves
    if op == "neq":
        return wants[0] not in haves
    if op == "in":
        return any(w in haves for w in wants)
    if op == "not_in":
        return not any(w in haves for w in wants)
    if op == "contains":
        return any(wants[0] in h for h in haves)
    if op == "prefix":
        return any(h.startswith(wants[0]) for h in haves)
    raise ValueError(f"unknown op {op!r}")


def blast_radius(g: Graph, start_ids: list[str], max_hops: int = MAX_HOPS) -> dict[str, dict]:
    """Breadth-first, backward from the change (page 22). The first path to a node is the shortest."""
    seen: dict[str, dict] = {}
    queue = deque({"id": s, "hops": 0, "path": [s], "via": None} for s in sorted(set(start_ids)))
    while queue:
        cur = queue.popleft()
        if cur["id"] in seen:
            continue
        seen[cur["id"]] = cur
        if cur["hops"] >= max_hops:
            continue
        kind = g.nodes[cur["id"]]["type"]
        nxt = g.incoming(cur["id"], BACKWARD)
        if kind == "workflow":
            nxt += g.outgoing(cur["id"], FORWARD)
        elif cur["hops"] == 0 and kind in ("obligation", "output"):
            nxt += g.incoming(cur["id"], FORWARD)  # "SOX 404 changed" starts at the workflows serving it
        for n, via in nxt:
            queue.append({"id": n, "hops": cur["hops"] + 1, "path": [*cur["path"], n], "via": via})
    return seen


def risk(g: Graph, wf: str) -> str:
    """Two booleans (page 22): it sends outside the company, or it serves an obligation."""
    return "high" if g.nodes[wf].get("sends_external") or g.outgoing(wf, ["SERVES"]) else "low"


def action(g: Graph, wf: str, level: str) -> str:
    """The workflow's rung (page 29): only rung 4 pauses without a person, rung 1 only observes."""
    rung = int(g.nodes[wf].get("rung", 4))
    if rung <= 1:
        return "none"
    return "paused" if level == "high" and rung >= 4 else "warned"


def next_step(g: Graph, change: dict, path: list[str], wf: str) -> str:
    effect, start = change["effect"], path[0]
    agent = next((g.label(p) for p in path if g.nodes[p]["type"] == "agent"), g.label(wf))
    ref = effect.get("ref") or change.get("title") or "the new rule"
    if effect["type"] == "fault" and g.nodes[start]["type"] == "tool":
        if effect.get("fix"):
            return f"move the {agent} to {g.nodes[start]['name']} {effect['fix']}"
        return f"take the {agent} off {g.label(start)} until a fixed version is named"
    if effect["type"] == "add_label":
        return f"confirm the {g.label(wf)} may process {g.label(start)} as {(effect.get('label') or 'labelled').upper()} data"
    if effect["type"] == "rule":
        return f"move the {agent} to a model that meets \"{ref}\""
    return f"check the {g.label(wf)} against {ref}"


def owner_message(g: Graph, wf: str, verdict: str, inc: dict) -> str:
    """Page 16: five plain lines, built from the incident fields only."""
    name = g.label(wf)
    if not name[1:2].isupper():  # "Customer reply" -> "customer reply", but "CRM sync" stays
        name = name[0].lower() + name[1:]
    head = f"Your {name} is paused." if verdict == "paused" else f"Your {name} keeps running, with a warning."
    tail = ("Radius keeps it paused until the fix is in place." if verdict == "paused"
            else "Nothing is stopped. The task closes when the fix is in place.")
    return "\n".join([
        head,
        "A change outside the company touches your workflow.",
        f"Cause: {inc['cause']} ({inc['path'].split(' → ', 1)[-1]})",
        f"Your next step: {inc['next'][0].upper()}{inc['next'][1:]}.",
        tail,
    ])


class Engine:
    """Holds the graph and everything the API serves, in memory."""

    def __init__(self, graph: Graph | None = None):
        self.g = graph or Graph()
        self.runs: dict[str, dict] = {}
        self.incidents: dict[str, dict] = {}
        self.tasks: dict[str, dict] = {}
        self.record: list[dict] = []

    def fire(self, change: dict, mode: str = "live") -> dict:
        t0 = time.perf_counter()
        g = self.g
        starts = g.select(change["target"], change["where"])
        reached = blast_radius(g, starts)
        near = {k: v for k, v in reached.items() if v["hops"] <= ACTION_HOPS}
        by_type = lambda t: [k for k in near if g.nodes[k]["type"] == t]
        workflows = by_type("workflow")

        run_id = f"run_{len(self.runs) + 1:04d}"
        verdicts, incidents, tasks = [], [], []
        for wf in workflows:
            level = risk(g, wf)
            verdict = action(g, wf, level)
            verdicts.append({"workflow_id": wf, "risk": level, "action": verdict})
            if mode != "live" or verdict == "none":
                continue
            path = reached[wf]["path"]
            outputs = [g.label(o) for o, _ in g.outgoing(wf, ["SENDS"])]
            duties = [g.label(o) for o, _ in g.outgoing(wf, ["SERVES"])]
            inc = {
                "cause": change.get("title") or change["effect"].get("ref") or "external change",
                "path": " → ".join([g.label(p) for p in path] + outputs[:1]),
                "risk": " · ".join([level] + [f"serves {d}" for d in duties]
                                   + (["sends output outside the company"] if g.nodes[wf].get("sends_external") else [])),
                "duty": ", ".join(duties) or "none",
                "action": f"{verdict} at {time.strftime('%H:%M:%S')}",
                "owner": g.owner(wf),
                "next": next_step(g, change, path, wf),
            }
            inc_id = None
            if verdict == "paused":
                g.nodes[wf]["state"] = "paused"
                inc_id = f"INC-{2041 + len(self.incidents)}"
                self.incidents[inc_id] = {"id": inc_id, **inc}
                incidents.append(inc_id)
            task_id = f"t_{wf.removeprefix('wf_')}"
            self.tasks[task_id] = {
                "id": task_id, "owner_id": g.nodes[wf].get("owner_id"), "workflow_id": wf,
                "incident_id": inc_id, "message": owner_message(g, wf, verdict, inc), "state": "open",
            }
            tasks.append(task_id)
            self.record.append({"run_id": run_id, "workflow_id": wf, "event": verdict})

        run = {
            "run_id": run_id, "mode": mode, "change": change,
            "elapsed_ms": round((time.perf_counter() - t0) * 1000, 2),
            "counts": {
                "agents": len(by_type("agent")), "workflows": len(workflows),
                "paused": sum(v["action"] == "paused" for v in verdicts),
                "warned": sum(v["action"] == "warned" for v in verdicts),
                "duties": len(by_type("obligation")), "outputs": len(by_type("output")),
                "untouched": len(g.of_type("workflow")) - len(workflows),
            },
            "reached": [{**v, "type": g.nodes[k]["type"], "name": g.label(k)} for k, v in reached.items()],
            "verdicts": verdicts, "incidents": incidents, "tasks": tasks,
        }
        self.runs[run_id] = run
        return run

    def resume(self, wf: str, reason: str) -> dict:
        if not reason.strip():
            raise ValueError("a resume needs a reason")
        self.g.nodes[wf]["state"] = "running"
        self.record.append({"workflow_id": wf, "event": "resumed", "reason": reason})
        return {"workflow_id": wf, "risk": risk(self.g, wf), "action": "none"}
