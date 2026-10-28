"""The two model calls, both at the edge of the system (page 23), both through OpenAI.

Inbound: prose -> one ChangeEvent selector (one forced tool call, temperature 0).
Outbound: incident fields -> the owner's five-line message.
Nothing between them is decided by a model. With no OPENAI_API_KEY, or RADIUS_OFFLINE=1, both
are off: JSON and `key: value` still work, prose waits in Unmatched, messages use the template.
"""
from __future__ import annotations

import json
import os

from .core import FIELDS

MODEL = os.environ.get("OPENAI_MODEL", "gpt-4.1-mini")


class ModelDown(Exception):
    pass


def available() -> bool:
    return bool(os.environ.get("OPENAI_API_KEY")) and os.environ.get("RADIUS_OFFLINE") != "1"


def _client():
    if not available():
        raise ModelDown("no OPENAI_API_KEY (or RADIUS_OFFLINE=1)")
    from openai import OpenAI

    return OpenAI(timeout=20, max_retries=1)


# ---- inbound: the extractor (page 24a, step 2) -----------------------------------------------

EXTRACT_SYSTEM = f"""You turn one change notice into one ChangeEvent selector over a company's AI graph.
Call emit_change exactly once.

Use ONLY these fields in `where`; they are the only fields the graph holds:
{chr(10).join(f"- {t}: {', '.join(f)}" for t, f in FIELDS.items())}

Ops: eq, neq, in, not_in, contains, prefix. `where` is {{"all": [...]}} or {{"any": [...]}}.
Effects: fault (a tool version or a model is faulty or retiring; advisory id in `ref`, fixed version in `fix`),
add_label (a data column gets a label such as pii; the label in `label`, a catalog id in `ref`),
rule (a new rule; the selector picks the nodes that BREAK it; the rule id or text in `ref`).
Copy versions exactly. Never complete a partial version: "2.1" stays "2.1".
If the notice names something the field list cannot express (for example a vendor), still use that
field name; the system will reject it. Never guess which nodes it means.

Five examples (page 07b):
1. "Vendor says pdf-parse 2.1.4 has a remote code bug, CVE-2026-4471. Fixed in 2.1.6."
   -> faulty_tool, tool, all[name eq pdf-parse, version eq 2.1.4], {{fault, ref CVE-2026-4471, fix 2.1.6}}
2. "The data steward marked customers.phone as personal data."
   -> personal_data, data, all[table eq customers, column eq phone], {{add_label, label pii}}
3. "New rule: use EU models only." -> new_rule, agent, all[model_region not_in [EU]], {{rule, ref "EU models only"}}
4. "gpt-x retires Friday." -> other, agent, all[model_id eq gpt-x], {{fault, ref "gpt-x retirement"}}
5. "Re-check all npm tools." -> other, tool, all[ecosystem eq npm], {{fault}}
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
            "required": ["kind", "title", "target", "where", "effect", "confidence"],
            "properties": {
                "kind": {"type": "string", "enum": ["faulty_tool", "personal_data", "new_rule", "other"]},
                "title": {"type": "string", "description": "short, e.g. 'CVE-2026-4471 · pdf-parse 2.1.4'"},
                "target": {"type": "string", "enum": ["tool", "data", "agent", "workflow", "obligation"]},
                "where": {"type": "object", "properties": {"all": {"type": "array", "items": _COND},
                                                           "any": {"type": "array", "items": _COND}}},
                "effect": {"type": "object", "required": ["type"],
                           "properties": {"type": {"type": "string", "enum": ["fault", "add_label", "rule"]},
                                          "ref": {"type": "string"}, "fix": {"type": "string"},
                                          "label": {"type": "string"}}},
                "confidence": {"type": "number", "minimum": 0, "maximum": 1},
            },
        },
    },
}


def extract(text: str) -> dict:
    """Returns the emit_change arguments. Raises ModelDown on any failure: the change waits in Unmatched."""
    try:
        resp = _client().chat.completions.create(
            model=MODEL, temperature=0, tools=[EMIT_CHANGE],
            tool_choice={"type": "function", "function": {"name": "emit_change"}},
            messages=[{"role": "system", "content": EXTRACT_SYSTEM}, {"role": "user", "content": text}],
        )
        calls = resp.choices[0].message.tool_calls or []
        if len(calls) != 1:
            raise ModelDown("the model did not call emit_change exactly once")
        return json.loads(calls[0].function.arguments)
    except ModelDown:
        raise
    except Exception as e:  # network, auth, bad JSON: the model is down for this change
        raise ModelDown(f"{type(e).__name__}: {e}") from e


# ---- outbound: the owner message (page 16) ---------------------------------------------------

MESSAGE_SYSTEM = """You write one short message to the owner of a business workflow. The owner is not a
security engineer. Use plain words and only the facts in the incident fields. Do not add names, versions,
dates or numbers that are not in the fields. Five short lines at most:
1. what happened to their workflow, 2. why, in one sentence, 3. "Cause:" with the cause and the path,
4. "Your next step:" and the next step, 5. what happens after. No greeting, no sign-off, no markdown."""


def write_message(fields: dict, feedback: str | None = None) -> str:
    user = "Incident fields:\n" + "\n".join(f"{k}: {v}" for k, v in fields.items())
    if feedback:
        user += f"\n\nYour last draft used words that are not in the fields: {feedback}. Use only the fields."
    try:
        resp = _client().chat.completions.create(
            model=MODEL, temperature=0, max_tokens=400,
            messages=[{"role": "system", "content": MESSAGE_SYSTEM}, {"role": "user", "content": user}],
        )
        return (resp.choices[0].message.content or "").strip()
    except ModelDown:
        raise
    except Exception as e:
        raise ModelDown(f"{type(e).__name__}: {e}") from e
