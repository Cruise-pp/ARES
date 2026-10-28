"""The five-minute demo of page 31, beat by beat, through the real pipeline (no server needed).

    python demo.py                 # reset var/, then each beat; Enter moves on
    python demo.py --auto          # no pauses
    python demo.py "any notice"    # one change on the current state: the card, then a click

With OPENAI_API_KEY set, the sentences go to the model. Without it, each sentence beat sends the
same change as a paste, and prose waits in Unmatched, as the brief says it must.
"""
from __future__ import annotations

import json
import sys

from radius import llm
from radius.core import soft
from radius.service import VAR, Radius, reset

AUTO = "--auto" in sys.argv
MODEL = llm.available()


def beat(clock: str, title: str) -> None:
    if not AUTO and clock != "0:00":
        input("\n  ⏎ next")
    print(f"\n{'═' * 76}\n {clock}  {title}\n{'═' * 76}")


def card(r: Radius, text: str, lane: str | None = None) -> dict:
    first = text.strip().splitlines()[0]
    print(f"\n  ▶ {first if len(first) < 90 else first[:87] + '...'}")
    p = r.parse(text, lane)
    by = p["change"]["parse"]["by"] if p["change"] else "nobody"
    print(f"  card  {p['state']} · read by {by} · {p['readback'] or p['reason']}")
    for c in p["candidates"]:
        print(f"        candidate {c['label']} ({c['id']})")
    return p


def show_run(r: Radius, run: dict) -> None:
    c = run["counts"]
    print(f"  reach {c['agents']} agents · {c['workflows']} workflows · {c['duties']} duties · "
          f"{c['outputs']} outputs · {c['untouched']} untouched   ({run['elapsed_ms']} ms, {run['mode']})")
    for v in run["verdicts"]:
        wf = r.g.nodes[v["workflow_id"]]
        held = [r.g.nodes[o] for o, _ in r.g.outgoing(v["workflow_id"], ["SENDS"])]
        stake = f"{held[0]['volume']:,} {soft(held[0]['name'])} held" if held and held[0].get("volume") else ""
        print(f"    {v['action']:>7}  {v['risk']:<4}  {wf['name']:<24} {stake}")


def show_task(r: Radius, task_id: str) -> None:
    t = r.task(task_id)
    if t["incident"]:
        inc = t["incident"]
        print(f"\n  {inc['id']}")
        for k in ("cause", "path", "risk", "duty", "action", "owner", "next"):
            print(f"    {k:<7} {inc[k]}")
    print(f"\n  /task/{task_id} · message by {t['task']['message_by']} · to {t['task']['owner_id']}")
    print("    " + t["task"]["message"].replace("\n", "\n    "))


def feed_rows(r: Radius) -> None:
    for row in r.changes():
        print(f"    {row['change_id']}  {row['title'][:36]:<36} {row['reach']:<24} {row['state']}")


def words_or_paste(sentence: str, change: dict) -> str:
    return sentence if MODEL else json.dumps(change)


def main() -> None:
    if len(sys.argv) > 1 and not AUTO:
        r = Radius(VAR)
        p = card(r, " ".join(sys.argv[1:]))
        if p["state"] == "exact":
            run = r.fire(p["change"])
            show_run(r, run)
            if run["tasks"]:
                show_task(r, run["tasks"][0])
        return

    r = reset(VAR)
    print(f"OpenAI: {'on, ' + llm.MODEL if MODEL else 'off (no OPENAI_API_KEY): sentences are sent as pastes'}")

    beat("0:00", "Show the graph")
    g = r.graph_view()
    kinds = {}
    for n in g["nodes"]:
        kinds[n["type"]] = kinds.get(n["type"], 0) + 1
    print(f"  {len(g['nodes'])} nodes · " + " · ".join(f"{v} {k if k == 'data' else k + 's'}" for k, v in kinds.items()))
    print(f"  coverage {g['coverage']:.0%} · {len(g['unknown_agents'])} agents with no bill of materials")
    print("  the feed, from yesterday:")
    feed_rows(r)

    beat("0:40", "Send the vulnerability notice (an OSV feed record: it fires on its own)")
    out = r.feed(open("samples/feed/01_osv_pdf_parse.json").read())
    print(f"  card  {out['parsed']['state']} · read by code (osv adapter) · {out['parsed']['readback']}")
    run = out["run"]
    show_run(r, run)

    beat("1:30", "Let it pause the work")
    print(f"  {run['counts']['paused']} workflows paused with no human action · {len(run['incidents'])} incidents open"
          f" · {run['counts']['warned']} keeps running with a warning")
    show_task(r, "t_finance_feed")

    beat("2:40", "Fire the second kind of change: a column becomes personal data")
    s2 = {"kind": "personal_data", "title": "customers.phone → PII", "target": "data",
          "where": {"all": [{"field": "table", "op": "eq", "value": "customers"},
                            {"field": "column", "op": "eq", "value": "phone"}]},
          "effect": {"type": "add_label", "label": "pii", "ref": "DC-8812"}}
    p = card(r, words_or_paste("The data steward marked customers.phone as personal data (DC-8812).", s2))
    if p["state"] == "exact":
        print("  click: Fire")
        show_run(r, r.fire(p["change"]))

    beat("3:30", "Hand the keyboard over: changes nobody has seen")
    gpt = {"kind": "other", "title": "gpt-4.1 retirement", "target": "agent",
           "where": {"all": [{"field": "model_id", "op": "eq", "value": "gpt-4.1"}]},
           "effect": {"type": "fault", "ref": "gpt-4.1 retirement"}}
    p = card(r, words_or_paste("OpenAI says gpt-4.1 retires on Friday.", gpt))
    if p["state"] == "exact":
        show_run(r, r.fire(p["change"]))
    card(r, "Every tool from Acme is breached.")  # a field the graph does not hold, or the model is down
    p = card(r, open("samples/words/10_partial_version.txt").read() if MODEL else json.dumps(
        {"target": "tool", "effect": {"type": "fault"},
         "where": {"all": [{"field": "name", "op": "eq", "value": "pdf-parse"},
                           {"field": "version", "op": "eq", "value": "2.1"}]}}))
    if p["state"] == "ambiguous":
        pick = p["candidates"][-1]
        print(f"  pick  {pick['label']}")
        show_run(r, r.fire({**p["change"], "where": {"all": [{"field": "id", "op": "eq", "value": pick["id"]}]}}))

    beat("4:20", "Preview a policy, then apply it: the two lists match")
    p = card(r, open("samples/feed/04_policy_eu_models.txt").read())
    preview = r.fire(p["change"], mode="preview")
    show_run(r, preview)
    live = r.fire(p["change"], mode="live")
    same = [v["workflow_id"] for v in preview["verdicts"]] == [v["workflow_id"] for v in live["verdicts"]]
    print(f"  applied: {live['counts']['paused']} paused, {live['counts']['warned']} warned · "
          f"{'LISTS MATCH' if same else 'LISTS DIFFER'}")

    beat("5:00", "The fix lands: pdf-parse 2.1.6")
    for v in r.tool_version("tl_pdf_parse_214", "2.1.6"):
        wf = v["workflow_id"]
        holding = [i for i in r.store.all("incidents") if i["workflow_id"] == wf and i["state"] == "open"]
        why = f"  (still held by {', '.join(i['id'] + ' · ' + i['cause'] for i in holding)})" if holding else ""
        print(f"    {r.g.nodes[wf]['name']:<24} now {r.g.nodes[wf]['state']}{why}")
    print("  resume by hand needs a reason:", end=" ")
    try:
        r.resume("wf_month_end_close", "")
    except ValueError as e:
        print(f"refused ({e})")
    r.resume("wf_month_end_close", "Risk accepted the US model until the quarter closes")
    print("  the feed now:")
    feed_rows(r)
    print(f"\n  {len(r.record())} events in the record · messages sent: {r.dir / 'outbox.jsonl'}")


if __name__ == "__main__":
    main()
