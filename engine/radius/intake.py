"""The intake (pages 07a, 24a): sniff -> adapter or model -> gate -> resolve. No model in this file.

Feeds and pastes are read by code: OSV JSON, CycloneDX VEX, a data-catalog record, `key: value`
lines, or a ChangeEvent. Only prose goes to the model (llm.py). The gate and the resolver then
read the selector against the graph, whoever wrote it. The model proposes; this code decides.
"""
from __future__ import annotations

import json
import re

from .core import FIELDS, Graph, at_least, conds, is_exact, vtuple

OPS = ("eq", "neq", "in", "not_in", "contains", "prefix")
_LINE = re.compile(r"^\s*([A-Za-z_][\w .-]*?)\s*:\s*(.+?)\s*$")


def listify(v) -> list:
    return v if isinstance(v, list) else [v]


# ---- 1 · sniff -------------------------------------------------------------------------------

def sniff(raw: str) -> tuple[str, dict | None]:
    """Which adapter reads this text. Anything no adapter knows is prose."""
    text = raw.strip()
    try:
        doc = json.loads(text)
    except ValueError:
        doc = None
    if isinstance(doc, dict):
        if "affected" in doc:
            return "osv", doc
        if "vulnerabilities" in doc:
            return "vex", doc
        if "target" in doc and "where" in doc:
            return "changeevent", doc
        if "table" in doc and "column" in doc:
            return "fields", doc
    lines = [line for line in text.splitlines() if line.strip()]
    if len(lines) >= 2 and all(_LINE.match(line) for line in lines):
        return "lines", {m[1].strip().lower(): m[2] for m in map(_LINE.match, lines)}
    return "prose", None


# ---- adapters: each field maps by name, no model ---------------------------------------------

def adapt(adapter: str, doc: dict, g: Graph) -> dict | None:
    return {"osv": osv, "vex": vex, "fields": catalog, "lines": lines, "changeevent": changeevent}[adapter](doc, g)


def osv(doc: dict, g: Graph) -> dict:
    """OSV JSON. Listed versions are taken as they are; a range becomes the versions the graph holds."""
    ref = next((a for a in doc.get("aliases", []) if a.startswith("CVE-")), doc.get("id"))
    aff = doc["affected"][0]
    name, eco = aff["package"]["name"], aff["package"]["ecosystem"].lower()
    events = [ev for r in aff.get("ranges", []) for ev in r.get("events", [])]
    fix = next((ev["fixed"] for ev in events if "fixed" in ev), None)
    versions = aff.get("versions") or held_in_range(g, name, eco, events)
    return {"kind": "faulty_tool", "title": f"{ref} · {name} {', '.join(versions) or '(no held version)'}",
            "target": "tool",
            "where": {"all": [{"field": "name", "op": "eq", "value": name},
                              {"field": "ecosystem", "op": "eq", "value": eco},
                              {"field": "version", "op": "in", "value": versions}]},
            "effect": {"type": "fault", "ref": ref, **({"fix": fix} if fix else {})}}


def held_in_range(g: Graph, name: str, eco: str, events: list[dict]) -> list[str]:
    lo = next((ev["introduced"] for ev in events if "introduced" in ev), "0")
    hi = next((ev["fixed"] for ev in events if "fixed" in ev), None)
    held = sorted({g.nodes[t]["version"] for t in g.of_type("tool")
                   if g.nodes[t]["name"] == name and g.nodes[t]["ecosystem"] == eco}, key=lambda v: vtuple(v) or ())
    return [v for v in held if (lo == "0" or at_least(v, lo)) and not (hi and at_least(v, hi))]


def vex(doc: dict, g: Graph) -> dict:
    """CycloneDX VEX: the first vulnerability, its affected component by purl, the fix from the recommendation."""
    v = doc["vulnerabilities"][0]
    comps = {c.get("bom-ref"): c for c in doc.get("components", [])}
    affects = v["affects"][0]
    purl = (comps.get(affects["ref"]) or {}).get("purl") or affects["ref"]
    m = re.match(r"pkg:([^/]+)/(?:.+/)?([^@/]+)@([^?#]+)", purl)
    if not m:
        raise ValueError(f"cannot read the purl {purl!r}")
    eco, name, ver = m[1].lower(), m[2], m[3]
    versions = [x["version"] for x in affects.get("versions", []) if x.get("status", "affected") == "affected"] or [ver]
    fix = (re.findall(r"\d+\.\d+(?:\.\d+)*", v.get("recommendation", "")) or [None])[-1]
    return {"kind": "faulty_tool", "title": f"{v['id']} · {name} {', '.join(versions)}", "target": "tool",
            "where": {"all": [{"field": "name", "op": "eq", "value": name},
                              {"field": "ecosystem", "op": "eq", "value": eco},
                              {"field": "version", "op": "in", "value": versions}]},
            "effect": {"type": "fault", "ref": v["id"], **({"fix": fix} if fix else {})}}


def catalog(doc: dict, g: Graph) -> dict:
    """A data-catalog record: a column gets a classification."""
    label = str(doc.get("classification") or doc.get("label") or "label").lower()
    return {"kind": "personal_data" if label in ("pii", "phi") else "other",
            "title": f"{doc['table']}.{doc['column']} → {label.upper()}", "target": "data",
            "where": {"all": [{"field": "table", "op": "eq", "value": doc["table"]},
                              {"field": "column", "op": "eq", "value": doc["column"]}]},
            "effect": {"type": "add_label", "label": label, **({"ref": doc["id"]} if doc.get("id") else {})}}


def lines(kv: dict, g: Graph) -> dict | None:
    """`key: value` lines: a policy register entry, a tool advisory, or a column label."""
    if "target" in kv:  # policy register: every other key is a condition on the target, held or not
        reserved = {"policy", "id", "rule", "title", "target", "effect", "ref", "fix", "label"}
        where = [cond_from_text(k, v) for k, v in kv.items() if k not in reserved]
        ref = kv.get("policy") or kv.get("id") or kv.get("ref")
        effect = kv.get("effect", "rule")
        return {"kind": "new_rule" if effect == "rule" else "other",
                "title": " · ".join(x for x in (ref, kv.get("rule")) if x) or "new rule", "target": kv["target"],
                "where": {"all": where},
                "effect": {"type": effect, **({"ref": ref} if ref else {}), **({"fix": kv["fix"]} if "fix" in kv else {})}}
    tool = kv.get("tool") or kv.get("package")
    if tool:
        ref = kv.get("cve") or kv.get("advisory") or kv.get("ref") or kv.get("id")
        fix = kv.get("fixed") or kv.get("fix")
        where = [{"field": "name", "op": "eq", "value": tool}]
        where += [{"field": "ecosystem", "op": "eq", "value": kv["ecosystem"].lower()}] if "ecosystem" in kv else []
        where += [{"field": "version", "op": "eq", "value": kv["version"]}] if "version" in kv else []
        return {"kind": "faulty_tool", "title": " · ".join(x for x in (ref, f"{tool} {kv.get('version', '')}".strip()) if x),
                "target": "tool", "where": {"all": where},
                "effect": {"type": "fault", **({"ref": ref} if ref else {}), **({"fix": fix} if fix else {})}}
    if "table" in kv and "column" in kv:
        return catalog(kv, g)
    return None  # lines no adapter knows: read them as prose


def cond_from_text(field: str, text: str) -> dict:
    """"not_in [EU]" -> {op: not_in, value: [EU]}; a bare value means eq."""
    m = re.match(rf"^({'|'.join(OPS)})\s+(.+)$", text.strip())
    op, val = (m[1], m[2]) if m else ("eq", text.strip())
    if val.startswith("[") and val.endswith("]"):
        val = [x.strip() for x in val[1:-1].split(",") if x.strip()]
    return {"field": field, "op": op, "value": val}


def changeevent(doc: dict, g: Graph) -> dict:
    return {k: doc[k] for k in ("id", "kind", "title", "target", "where", "effect") if k in doc}


# ---- 3 · gate: two closed questions, answered by code, kept in the receipt -------------------

def gate(change: dict) -> dict:
    target = change.get("target")
    missing = [c["field"] for c in conds(change) if c["field"] not in FIELDS.get(target, ())]
    partial = [v for c in conds(change) if c["field"] == "version" for v in listify(c["value"]) if not is_exact(v)]
    return {"by": "code",
            "answers": [{"q": f"Does each field exist on {target}?", "a": not missing, "missing": missing},
                        {"q": "Is each version exact?", "a": not partial, "partial": partial}]}


# ---- 4 · resolve: exact, ambiguous or none ---------------------------------------------------

def resolve(g: Graph, change: dict) -> dict:
    """Runs the selector on the graph. Never completes a version and never picks between two names."""
    target, cs = change.get("target"), conds(change)
    none = lambda reason: {"state": "none", "matches": [], "candidates": [], "readback": "", "reason": reason}
    if target not in FIELDS or not cs:
        return none(f"no target type or no condition (target {target!r})")
    missing = [c["field"] for c in cs if c["field"] not in FIELDS[target]]
    if missing:
        return none(f"the graph holds no field {', '.join(missing)} on {target}; nobody guesses which {target}s it means")

    partial = [c for c in cs if c["field"] == "version" and c["op"] == "eq" and not is_exact(c["value"])]
    if partial:
        loose = [{**c, "op": "prefix", "value": f"{c['value']}."} if c in partial else c for c in cs]
        near = sorted(g.select(target, {"all": loose}), key=lambda i: vtuple(g.nodes[i]["version"]) or (), reverse=True)
        if not near:
            return none(f"version {partial[0]['value']} is partial and the graph holds no version under it")
        return ambiguous(g, near, f"version {partial[0]['value']} is partial; pick one")

    matches = g.select(target, change["where"])
    if not matches:
        named = next((c["value"] for c in cs if c["field"] == "name" and c["op"] == "eq"), None)
        wanted = next((c["value"] for c in cs if c["field"] == "version"), None)
        if target == "tool" and named and wanted is not None:
            held = sorted(g.nodes[t]["version"] for t in g.of_type("tool") if g.nodes[t]["name"] == named)
            return none(f"0 agents use {named} {', '.join(map(str, listify(wanted)))}; "
                        f"the graph holds {', '.join(held) if held else 'no version of it'}")
        return none(f"no {target} matches this selector")

    ecos = {g.nodes[m].get("ecosystem") for m in matches}
    if target == "tool" and len(ecos) > 1 and not any(c["field"] == "ecosystem" for c in cs):
        return ambiguous(g, matches, f"{len(ecos)} ecosystems hold this name ({', '.join(sorted(ecos))}); pick one")

    users = {u for m in matches for u, _ in g.incoming(m, ["RUNS_ON", "READS", "INVOKES", "SERVES", "SENDS"])}
    unit = g.users(matches[0])[1]
    labels = ", ".join(g.label(m) for m in matches[:4]) + (f" (+{len(matches) - 4} more)" if len(matches) > 4 else "")
    noun = "node matches" if len(matches) == 1 else "nodes match"
    return {"state": "exact", "matches": matches, "candidates": [], "reason": None,
            "readback": f"{labels} · {len(matches)} {noun} · {len(users)} {unit} use {'it' if len(matches) == 1 else 'them'}"}


def ambiguous(g: Graph, ids: list[str], reason: str) -> dict:
    cands = [{"id": i, "label": g.label(i) + (f" ({g.nodes[i]['ecosystem']})" if g.type(i) == "tool" else ""),
              "score": round(1 - k * 0.1, 2)} for k, i in enumerate(ids)]
    return {"state": "ambiguous", "matches": [], "candidates": cands, "readback": "", "reason": reason}
