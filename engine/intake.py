"""Text in, read-back card out (pages 07a, 24a).

JSON that is already a ChangeEvent skips the model. Anything else is prose: OpenAI proposes one
selector through one forced tool call. Then code decides: the resolver checks the selector
against the graph, and the card is exact, ambiguous or none. The model never picks the nodes.
"""
from __future__ import annotations

import json
import os

from core import FIELDS, Graph

MODEL = os.environ.get("OPENAI_MODEL", "gpt-4.1-mini")

SYSTEM = f"""You turn one change notice into one ChangeEvent selector over a company's AI graph.
Call emit_change exactly once.

Use ONLY these fields in `where`; they are the only fields the graph holds:
{chr(10).join(f"- {t}: {', '.join(f)}" for t, f in FIELDS.items())}

Ops: eq, neq, in, not_in, contains, prefix. Effects: fault (put the advisory id in `ref`, the fixed
version in `fix`), add_label (put the label, e.g. pii, in `label`), rule (the selector picks the
nodes that BREAK the rule; put the rule in `ref`).
Copy versions exactly; never complete a partial version. If the notice names a field that is not
in the list (e.g. vendor), still use that field name; the system will reject it. Never guess.

Examples:
"pdf-parse 2.1.4 has CVE-2026-4471, fixed in 2.1.6" -> target tool, where all[name eq pdf-parse,
  version eq 2.1.4], effect {{fault, ref CVE-2026-4471, fix 2.1.6}}
"customers.phone is now personal data" -> target data, where all[table eq customers, column eq phone],
  effect {{add_label, label pii}}
"Use EU models only" -> target agent, where all[model_region not_in [EU]], effect {{rule, ref "EU models only"}}
"gpt-x retires Friday" -> target agent, where all[model_id eq gpt-x], effect {{fault, ref "gpt-x retirement"}}
"""

_COND = {
    "type": "object",
    "properties": {
        "field": {"type": "string"},
        "op": {"type": "string", "enum": ["eq", "neq", "in", "not_in", "contains", "prefix"]},
        "value": {"anyOf": [{"type": "string"}, {"type": "number"}, {"type": "boolean"},
                            {"type": "array", "items": {"type": "string"}}]},
    },
    "required": ["field", "op", "value"],
}

EMIT_CHANGE = {
    "type": "function",
    "function": {
        "name": "emit_change",
        "description": "Emit the one ChangeEvent selector that the notice describes.",
        "parameters": {
            "type": "object",
            "required": ["kind", "title", "target", "where", "effect"],
            "properties": {
                "kind": {"type": "string", "enum": ["faulty_tool", "personal_data", "new_rule", "other"]},
                "title": {"type": "string", "description": "short, e.g. 'CVE-2026-4471 · pdf-parse 2.1.4'"},
                "target": {"type": "string", "enum": ["tool", "data", "agent", "workflow", "obligation"]},
                "where": {"type": "object", "properties": {"all": {"type": "array", "items": _COND},
                                                           "any": {"type": "array", "items": _COND}}},
                "effect": {
                    "type": "object",
                    "required": ["type"],
                    "properties": {
                        "type": {"type": "string", "enum": ["fault", "add_label", "rule"]},
                        "ref": {"type": "string"}, "fix": {"type": "string"}, "label": {"type": "string"},
                    },
                },
            },
        },
    },
}


def extract(text: str) -> dict:
    """One forced tool call, temperature 0. Raises if the model is unavailable."""
    from openai import OpenAI

    resp = OpenAI().chat.completions.create(
        model=MODEL,
        temperature=0,
        messages=[{"role": "system", "content": SYSTEM}, {"role": "user", "content": text}],
        tools=[EMIT_CHANGE],
        tool_choice={"type": "function", "function": {"name": "emit_change"}},
    )
    return json.loads(resp.choices[0].message.tool_calls[0].function.arguments)


def resolve(g: Graph, change: dict) -> dict:
    """Code decides (page 24a): every field must exist, and the selector must hit real nodes."""
    target, where = change["target"], change.get("where") or {}
    conds = where.get("all") or where.get("any") or []
    unknown = [c["field"] for c in conds if c["field"] not in FIELDS.get(target, ())]
    if unknown or not conds:
        reason = f"the graph holds no field {', '.join(unknown)} on {target}" if unknown else "no condition"
        return {"state": "none", "matches": [], "candidates": [], "reason": reason}

    matches = g.select(target, where)
    if matches:
        return {"state": "exact", "matches": matches, "candidates": [], "reason": None}

    # No exact hit. A partial version ("2.1") is ambiguous: offer the versions that start with it.
    loose = {"all" if "all" in where else "any":
             [{**c, "op": "prefix"} if c["field"] == "version" and c["op"] == "eq" else c for c in conds]}
    near = g.select(target, loose)
    if near:
        cands = [{"id": i, "label": g.label(i), "score": round(1 / (k + 1), 2)} for k, i in enumerate(near)]
        return {"state": "ambiguous", "matches": [], "candidates": cands, "reason": "no exact version; pick one"}
    return {"state": "none", "matches": [], "candidates": [], "reason": "0 nodes match this selector"}


def parse(g: Graph, text: str) -> dict:
    """POST /changes/parse: text -> ParsedChange {change, state, matches, candidates, readback, reason}."""
    try:
        change, by = json.loads(text), "code"
        if not isinstance(change, dict) or "target" not in change:
            raise ValueError
    except ValueError:
        try:
            change, by = extract(text), "model"
        except Exception as e:  # no key, network down: the change waits as unmatched
            return {"change": None, "state": "none", "matches": [], "candidates": [],
                    "readback": "", "reason": f"model unavailable ({type(e).__name__}: {e})"}
    change.setdefault("kind", "other")
    change.setdefault("title", change["effect"].get("ref") or "external change")
    change["source"] = {"raw": text}
    change["parse"] = {"by": by}

    out = resolve(g, change)
    labels = ", ".join(g.label(m) for m in out["matches"][:5])
    more = f" (+{len(out['matches']) - 5} more)" if len(out["matches"]) > 5 else ""
    readback = f"{change['effect']['type']} on {len(out['matches'])} {change['target']}(s): {labels}{more}" \
        if out["matches"] else ""
    return {"change": change, **out, "readback": readback}
