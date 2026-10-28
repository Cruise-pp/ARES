"""The page-31 demo in the terminal, no server.

    python demo.py                     # S1-S3; prose via OpenAI if OPENAI_API_KEY is set, else JSON
    python demo.py "gpt-4.1 retires Friday"   # any sentence (needs OPENAI_API_KEY)
"""
from __future__ import annotations

import json
import os
import sys

from core import Engine
from intake import parse

# (sentence for the model, the same change as JSON for running with no key)
SCENES = [
    ("Vendor says pdf-parse 2.1.4 has a remote code bug, CVE-2026-4471. Fixed in 2.1.6.",
     {"kind": "faulty_tool", "title": "CVE-2026-4471 · pdf-parse 2.1.4", "target": "tool",
      "where": {"all": [{"field": "name", "op": "eq", "value": "pdf-parse"},
                        {"field": "version", "op": "eq", "value": "2.1.4"}]},
      "effect": {"type": "fault", "ref": "CVE-2026-4471", "fix": "2.1.6"}}),
    ("The data steward marked customers.phone as personal data.",
     {"kind": "personal_data", "title": "customers.phone → PII", "target": "data",
      "where": {"all": [{"field": "table", "op": "eq", "value": "customers"},
                        {"field": "column", "op": "eq", "value": "phone"}]},
      "effect": {"type": "add_label", "label": "pii"}}),
    ("New rule POL-0034: use EU models only.",
     {"kind": "new_rule", "title": "POL-0034 · EU models only", "target": "agent",
      "where": {"all": [{"field": "model_region", "op": "not_in", "value": ["EU"]}]},
      "effect": {"type": "rule", "ref": "EU models only"}}),
]


def show(engine: Engine, text: str) -> None:
    print("\n" + "═" * 72 + f"\n▶ {text if len(text) < 100 else text[:97] + '...'}")
    card = parse(engine.g, text)
    print(f"  card: {card['state']} · by {card['change']['parse']['by'] if card['change'] else 'nobody'}"
          f" · {card['readback'] or card['reason']}")
    for c in card["candidates"]:
        print(f"    candidate: {c['label']} ({c['id']})")
    if card["state"] != "exact":
        return

    run = engine.fire(card["change"])
    c = run["counts"]
    print(f"  reach: {c['agents']} agents · {c['workflows']} workflows · {c['paused']} paused · "
          f"{c['warned']} warned · {c['duties']} duties · {c['outputs']} outputs · {c['untouched']} untouched"
          f"  ({run['elapsed_ms']} ms)")
    for v in run["verdicts"]:
        print(f"    {v['action']:>7}  {v['risk']:<4}  {engine.g.label(v['workflow_id'])}")
    if run["incidents"]:
        # Show the incident with a duty when there is one: it is the one an auditor asks about.
        inc = max((engine.incidents[i] for i in run["incidents"]), key=lambda i: i["duty"] != "none")
        print(f"\n  {inc['id']}")
        for k in ("cause", "path", "risk", "duty", "action", "owner", "next"):
            print(f"    {k:<7} {inc[k]}")
        task = next(t for t in engine.tasks.values() if t["incident_id"] == inc["id"])
        print(f"\n  message to {inc['owner']}:")
        print("    " + task["message"].replace("\n", "\n    "))


def main() -> None:
    engine = Engine()
    if len(sys.argv) > 1:
        return show(engine, " ".join(sys.argv[1:]))
    use_model = bool(os.environ.get("OPENAI_API_KEY"))
    print("OpenAI:", "on (prose)" if use_model else "off (no OPENAI_API_KEY, sending JSON changes)")
    for words, change in SCENES:
        show(engine, words if use_model else json.dumps(change))
    # The resolver catches what the graph cannot answer, with no model involved.
    show(engine, json.dumps({"target": "tool", "where": {"all": [{"field": "vendor", "op": "eq", "value": "Acme"}]},
                             "effect": {"type": "fault"}}))
    show(engine, json.dumps({"target": "tool", "where": {"all": [{"field": "name", "op": "eq", "value": "pdf-parse"},
                                                                  {"field": "version", "op": "eq", "value": "2.1"}]},
                             "effect": {"type": "fault"}}))


if __name__ == "__main__":
    main()
