"""The engine (pages 21-22): the graph, the reverse search, the risk rule and the incident wording.

Pure functions over an in-memory graph. No model, no network, no side effects. The same change on
the same graph gives the same answer, in the same order, every run (page 22).
"""
from __future__ import annotations

import json
import re
from collections import defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path

GRAPH_PATH = Path(__file__).resolve().parent.parent / "data" / "graph.json"

# Every field the search or the risk rule needs (page 21). A selector may name only these.
FIELDS = {
    "tool": ("id", "name", "version", "ecosystem", "owner_id"),
    "data": ("id", "table", "column", "labels", "owner_id"),
    "agent": ("id", "name", "model_id", "model_region", "owner_id"),
    "workflow": ("id", "name", "owner_id", "sends_external", "state"),
    "obligation": ("id", "name", "authority", "owner_id"),
    "output": ("id", "name", "channel", "volume"),
}
BACKWARD = ("RUNS_ON", "READS", "INVOKES")  # who points AT this node: tool/data <- agent <- workflow
FORWARD = ("SERVES", "SENDS")               # from a reached workflow: what it serves and sends
API_HOPS = 6     # the reach returned to the screens (page 31a, rule 3)
ACTION_HOPS = 4  # pause or warn only this close to the change (page 22)


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Graph:
    """Adjacency lists in memory, loaded from one JSON file (page 21, "Storage")."""

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
                adj[k].sort()  # determinism: every adjacency list sorted by id
        self.synced_at = now()

    def type(self, nid: str) -> str:
        return self.nodes[nid]["type"]

    def of_type(self, t: str) -> list[str]:
        return sorted(i for i, n in self.nodes.items() if n["type"] == t)

    def outgoing(self, nid: str, types) -> list[tuple[str, str]]:
        return [(n, t) for n, t in self.out[nid] if t in types]

    def incoming(self, nid: str, types) -> list[tuple[str, str]]:
        return [(n, t) for n, t in self.inc[nid] if t in types]

    def edges(self) -> list[dict]:
        return [{"from": s, "to": d, "type": t} for s in sorted(self.out) for d, t in self.out[s]]

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

    def users(self, nid: str) -> tuple[int, str]:
        """How many things use this node directly, in words a person counts: "3 agents"."""
        t = self.type(nid)
        edge, unit = {"tool": ("RUNS_ON", "agents"), "data": ("READS", "agents"), "agent": ("INVOKES", "workflows"),
                      "obligation": ("SERVES", "workflows"), "output": ("SENDS", "workflows")}.get(t, (None, "workflows"))
        return (len(self.incoming(nid, [edge])) if edge else 0), unit

    def set(self, nid: str, field: str, value) -> None:
        if field not in FIELDS[self.type(nid)]:
            raise KeyError(f"{field} is not a field of {self.type(nid)}")
        self.nodes[nid][field] = value
        self.synced_at = now()

    def select(self, target: str, where: dict) -> list[str]:
        conds = where.get("all") or where.get("any") or []
        test = all if "all" in where else any
        return [i for i in self.of_type(target) if test(match(self.nodes[i], c) for c in conds)]

    def unknown_agents(self) -> list[str]:
        """Agents with no bill-of-materials entry: no tool is recorded for them (page 28)."""
        return [a for a in self.of_type("agent") if not self.outgoing(a, ["RUNS_ON"])]

    def coverage(self) -> float:
        unknown = set(self.unknown_agents())
        complete = sum(1 for i, n in self.nodes.items()
                       if i not in unknown and all(n.get(f) is not None for f in FIELDS[n["type"]]))
        return round(complete / len(self.nodes), 3)


def match(node: dict, cond: dict) -> bool:
    """One condition on one node. A missing value fails a positive test and passes a negative one:
    an unknown is never treated as safe."""
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


def conds(change: dict) -> list[dict]:
    where = change.get("where") or {}
    return where.get("all") or where.get("any") or []


# ---- versions --------------------------------------------------------------------------------

def vtuple(v: str) -> tuple[int, ...] | None:
    parts = str(v).strip().lstrip("v").split(".")
    return tuple(int(p) for p in parts) if all(p.isdigit() for p in parts) else None


def is_exact(v: str) -> bool:
    """"2.1.4" is exact; "2.1" is a partial version and is never completed by a guess."""
    t = vtuple(v)
    return t is None or len(t) >= 3


def at_least(v: str, floor: str) -> bool:
    a, b = vtuple(v), vtuple(floor)
    return a is not None and b is not None and a >= b


# ---- the search (page 22) --------------------------------------------------------------------

def blast_radius(g: Graph, start_ids: list[str], max_hops: int = API_HOPS) -> dict[str, dict]:
    """Every node reachable from the change, with the shortest path that reached it.

    FIFO with every start node in the first queue (page 07b), so the first path to a node is the shortest.
    """
    seen: dict[str, dict] = {}
    queue = deque({"id": s, "hops": 0, "path": [s], "via": None} for s in sorted(set(start_ids)))
    while queue:
        cur = queue.popleft()
        if cur["id"] in seen:
            continue
        seen[cur["id"]] = cur
        if cur["hops"] >= max_hops:
            continue
        kind = g.type(cur["id"])
        nxt = g.incoming(cur["id"], BACKWARD)
        if kind == "workflow":
            nxt += g.outgoing(cur["id"], FORWARD)
        elif cur["hops"] == 0 and kind in ("obligation", "output"):
            nxt += g.incoming(cur["id"], FORWARD)  # "SOX 404 changed" starts at the workflows that serve it
        for n, via in nxt:
            queue.append({"id": n, "hops": cur["hops"] + 1, "path": [*cur["path"], n], "via": via})
    return seen


# ---- the risk rule (page 22) and the rung (page 29) ------------------------------------------

def risk(g: Graph, wf: str) -> str:
    return "high" if g.nodes[wf].get("sends_external") or g.outgoing(wf, ["SERVES"]) else "low"


def action(g: Graph, wf: str) -> str:
    """What the workflow's rung allows: rung 1 observes, rungs 2-3 warn, only rung 4 pauses on its own."""
    rung = int(g.nodes[wf].get("rung", 4))
    if rung <= 1:
        return "none"
    return "paused" if risk(g, wf) == "high" and rung >= 4 else "warned"


def score(g: Graph, reached: dict[str, dict]) -> list[dict]:
    wfs = [k for k, v in reached.items() if g.type(k) == "workflow" and v["hops"] <= ACTION_HOPS]
    verdicts = [{"workflow_id": wf, "risk": risk(g, wf), "action": action(g, wf)} for wf in wfs]
    rank = {"paused": 0, "warned": 1, "none": 2}  # the order of page 31d: pauses first, then by id
    return sorted(verdicts, key=lambda v: (rank[v["action"]], v["workflow_id"]))


def counts(g: Graph, reached: dict[str, dict], verdicts: list[dict]) -> dict:
    near = [k for k, v in reached.items() if v["hops"] <= ACTION_HOPS]
    n = lambda t: sum(g.type(k) == t for k in near)
    return {"agents": n("agent"), "workflows": len(verdicts),
            "paused": sum(v["action"] == "paused" for v in verdicts),
            "warned": sum(v["action"] == "warned" for v in verdicts),
            "duties": n("obligation"), "outputs": n("output"),
            "untouched": len(g.of_type("workflow")) - len(verdicts)}


def reached_rows(g: Graph, reached: dict[str, dict]) -> list[dict]:
    return [{"id": k, "type": g.type(k), "name": g.label(k), "hops": v["hops"], "path": v["path"], "via": v["via"]}
            for k, v in reached.items()]


# ---- the incident, seven lines (page 11) -----------------------------------------------------

def incident_fields(g: Graph, change: dict, path: list[str], wf: str) -> dict:
    duties = [g.label(o) for o, _ in g.outgoing(wf, ["SERVES"])]
    outputs = [g.label(o) for o, _ in g.outgoing(wf, ["SENDS"])]
    why = [risk(g, wf)] + [f"serves {d}" for d in duties]
    why += ["sends output outside the company"] if g.nodes[wf].get("sends_external") else []
    return {
        "cause": cause(g, change, path[0]),
        "path": " → ".join([g.label(p) for p in path] + outputs[:1]),
        "risk": " · ".join(why if len(why) > 1 else why + ["stays inside the company"]),
        "duty": ", ".join(duties) or "none",
        "owner": g.owner(wf),
        "next": next_step(g, change, path, wf),
    }


def cause(g: Graph, change: dict, start: str) -> str:
    e = change["effect"]
    if e["type"] == "add_label":
        return f"{g.label(start)} → {(e.get('label') or 'label').upper()}" + (f" ({e['ref']})" if e.get("ref") else "")
    if g.type(start) == "tool" and e.get("ref"):
        return f"{e['ref']} · {g.label(start)}"
    return change.get("title") or e.get("ref") or "a change outside the company"


def next_step(g: Graph, change: dict, path: list[str], wf: str) -> str:
    e, start = change["effect"], path[0]
    agent = next((g.label(p) for p in path if g.type(p) == "agent"), None)
    subject = agent or g.label(wf)
    ref = e.get("ref") or change.get("title") or "the new rule"
    if e["type"] == "fault":
        if g.type(start) == "tool":
            if e.get("fix"):
                return f"move the {subject} to {g.nodes[start]['name']} {e['fix']}"
            return f"take the {subject} off {g.label(start)} until a fixed version is named"
        if g.type(start) == "agent" and any(c["field"] == "model_id" for c in conds(change)):
            return f"move the {subject} off {g.nodes[start]['model_id']} to a supported model"
        if g.type(start) == "data":
            return f"stop the {g.label(wf)} reading {g.label(start)} until it is checked"
        return f"check the {g.label(wf)} against {ref}"
    if e["type"] == "add_label":
        return f"confirm the {g.label(wf)} may process {g.label(start)} as {(e.get('label') or 'labelled').upper()} data"
    region = next((c for c in conds(change) if c["field"] == "model_region"), None)
    if region and agent:
        allowed = region["value"] if isinstance(region["value"], list) else [region["value"]]
        return f"move the {agent} to a model hosted in {', '.join(allowed)}"
    return f"bring the {subject} in line with {ref}"


# ---- the owner message, as a template (page 16) ----------------------------------------------

REASON = {
    ("fault", "tool"): "A fault was found in a tool that your workflow uses.",
    ("fault", "agent"): "A model that your workflow uses is faulty or being retired.",
    ("fault", "data"): "A data column that your workflow reads has a problem.",
    ("add_label", "data"): "A data column that your workflow reads is now marked as personal data.",
    ("rule", "agent"): "An agent in your workflow breaks a new company rule.",
}


def soft(name: str) -> str:
    """"Customer reply" -> "customer reply", but "CRM sync" stays."""
    return name if name[1:2].isupper() else name[:1].lower() + name[1:]


def template(g: Graph, change: dict, wf: str, verdict: str, fields: dict, start: str) -> str:
    """Five plain lines, from the incident fields only. Written at once: a pause never waits on a network."""
    name, e = soft(g.label(wf)), change["effect"]
    head = f"Your {name} is paused." if verdict == "paused" else f"Your {name} keeps running, with a warning."
    reason = REASON.get((e["type"], g.type(start)), "A change outside the company touches your workflow.")
    if verdict == "paused" and e["type"] == "fault" and e.get("fix") and g.type(start) == "tool":
        tail = f"The {name} starts again on its own after the change."
    elif verdict == "paused":
        tail = "Radius keeps it paused until the fix is in place."
    else:
        tail = "Nothing is stopped. The task closes when Radius sees the fix."
    # The cause already names a tool or a column, so the path in brackets starts after it.
    path = fields["path"].split(" → ", 1)[-1] if g.type(start) in ("tool", "data") else fields["path"]
    return "\n".join([head, reason, f"Cause: {fields['cause']} ({path})",
                      f"Your next step: {fields['next'][:1].upper()}{fields['next'][1:]}.", tail])


_VERSION = re.compile(r"\b\d+\.\d+(?:\.\d+)*\b")
_ADVISORY = re.compile(r"\b(?:CVE|GHSA|OSV|POL|DC|INC)-[\w-]+\b", re.I)


def check_message(g: Graph, message: str, fields: dict) -> list[str]:
    """The message gate (page 23), code only: every version, advisory id and graph name in the message
    must come from the incident fields. Returns what was invented; empty means it passes."""
    allowed = " ".join(str(v) for v in fields.values()).casefold()
    text = message.casefold()
    bad = [v for v in _VERSION.findall(message) if v.casefold() not in allowed]
    bad += [a for a in _ADVISORY.findall(message) if a.casefold() not in allowed]
    for n in g.nodes.values():
        name = (n.get("name") or "").casefold()
        if len(name) > 3 and name not in allowed and re.search(rf"\b{re.escape(name)}\b", text):
            bad.append(n["name"])
    if not message.strip() or len(message) > 900:
        bad.append("(empty or longer than 900 characters)")
    return sorted(set(bad))
