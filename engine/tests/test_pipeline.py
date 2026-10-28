"""A4 actions · A5 owner message · A7 the LangGraph pipeline, end to end on a fresh state."""
import json

from langgraph.types import Command

from radius import llm
from radius.service import Radius, reset

from .conftest import S1, S1_JSON, sample


def fire_s1(r):
    card = r.parse(S1_JSON)
    assert card["state"] == "exact" and r.waiting_at(card["change"]["id"]) == "confirm"  # waits for the click
    return r.fire(card["change"])


def test_a_feed_with_an_exact_match_fires_on_its_own(radius):
    out = radius.feed(sample("feed/01_osv_pdf_parse.json"))
    assert out["parsed"]["change"]["id"] == "chg_0142" and out["run"]["counts"]["paused"] == 2


def test_s1_two_paused_two_incidents_three_tasks_one_warning(radius):
    run = fire_s1(radius)
    assert run["incidents"] == ["INC-2041", "INC-2042"]
    assert run["tasks"] == ["t_finance_feed", "t_customer_reply", "t_contract_review"]
    inc = radius.task("t_finance_feed")["incident"]
    assert inc["path"] == "pdf-parse 2.1.4 → Invoice extractor → Finance feed → GL posting"
    assert inc["duty"] == "SOX 404" and inc["next"] == "move the Invoice extractor to pdf-parse 2.1.6"
    assert radius.task("t_contract_review")["incident"] is None  # a warning has no incident
    assert radius.changes()[0]["state"] == "2 paused"


def test_the_fixed_version_lands_and_both_workflows_resume(radius):
    fire_s1(radius)
    verdicts = radius.tool_version("tl_pdf_parse_214", "2.1.6")
    assert {v["workflow_id"]: v["action"] for v in verdicts} == {
        "wf_customer_reply": "none", "wf_finance_feed": "none", "wf_contract_review": "none"}
    assert all(t["state"] == "closed" for t in radius.store.all("tasks") if t["change_id"] == "chg_0142")
    assert radius.changes()[0]["state"] == "cleared"


def test_resume_needs_a_reason_and_leaves_the_incident_open(radius):
    fire_s1(radius)
    try:
        radius.resume("wf_finance_feed", "  ")
        raise AssertionError("resumed with no reason")
    except ValueError:
        pass
    assert radius.resume("wf_finance_feed", "Vendor patch applied by hand")["action"] == "none"
    assert radius.changes()[0]["state"] == "1 paused"  # customer reply still paused
    assert radius.record()[-1]["reason"] == "Vendor patch applied by hand"


def test_with_no_model_every_task_has_a_template_message(radius):
    run = fire_s1(radius)
    for tid in run["tasks"]:
        t = radius.task(tid)["task"]
        assert t["message_by"] == "template" and "Your next step:" in t["message"]
    sent = [json.loads(line) for line in (radius.dir / "outbox.jsonl").read_text().splitlines()]
    assert sorted(m["task_id"] for m in sent if m["task_id"] in run["tasks"]) == sorted(run["tasks"])
    assert {m["to"] for m in sent if m["task_id"] == "t_finance_feed"} == {"slack:#finance-ops"}


def test_the_model_message_is_kept_when_the_retry_uses_only_the_incident_fields(radius, monkeypatch):
    # First draft invents a version; the retry, told what it invented, uses only the fields.
    write = lambda fields, feedback=None: "Move to pdf-parse 9.9.9." if not feedback else f"Your next step: {fields['next']}."
    monkeypatch.setattr(llm, "write_message", write)
    run = fire_s1(radius)
    t = radius.task("t_finance_feed")["task"]
    assert t["message_by"] == "model" and t["message"] == "Your next step: move the Invoice extractor to pdf-parse 2.1.6."
    assert len(run["tasks"]) == 3


def test_two_invented_drafts_fall_back_to_the_template(radius, monkeypatch):
    monkeypatch.setattr(llm, "write_message", lambda fields, feedback=None: "Move to pdf-parse 9.9.9.")
    fire_s1(radius)
    assert radius.task("t_finance_feed")["task"]["message_by"] == "template"  # a message always goes out
    sent = [e for e in radius.record() if e["event"] == "dispatched" and e["task_id"] == "t_finance_feed"]
    assert sent[0]["gate_rejected"] == ["9.9.9"]


def test_preview_runs_the_search_and_changes_nothing(radius):
    policy = sample("feed/04_policy_eu_models.txt")
    card = radius.parse(policy)
    before = {k: n.get("state") for k, n in radius.g.nodes.items()}
    preview = radius.fire(card["change"], mode="preview")
    assert preview["incidents"] == [] and preview["tasks"] == []
    assert {k: n.get("state") for k, n in radius.g.nodes.items()} == before  # nothing paused
    live = radius.fire(card["change"], mode="live")
    assert preview["verdicts"] == live["verdicts"]  # the two lists match (page 17)


def test_ambiguous_waits_for_a_pick_then_fires(radius):
    partial = {**S1, "where": {"all": [{"field": "name", "op": "eq", "value": "pdf-parse"},
                                       {"field": "version", "op": "eq", "value": "2.1"}]}}
    card = radius.parse(json.dumps(partial))
    assert card["state"] == "ambiguous" and card["candidates"][0]["id"] == "tl_pdf_parse_214"
    pick = {**card["change"], "where": {"all": [{"field": "id", "op": "eq", "value": "tl_pdf_parse_214"}]}}
    run = radius.fire(pick)
    assert run["change"]["id"] == card["change"]["id"] and run["counts"]["paused"] == 2


def test_unmatched_waits_in_triage_until_a_person_maps_it(radius):
    card = radius.parse("Every tool from Acme is breached.")  # prose, and the model is down
    assert card["state"] == "none" and card["change"] is None and "model is unavailable" in card["reason"]
    row = radius.changes()[0]
    assert row["state"] == "unmatched" and radius.waiting_at(row["change_id"]) == "triage"
    run = radius.fire({**S1, "id": row["change_id"]})  # Dani maps it to a real selector
    assert run["change"]["id"] == row["change_id"] and run["counts"]["workflows"] == 3


def test_a_run_stopped_after_search_resumes_from_the_checkpoint_with_the_same_result(radius, tmp_path):
    expected = fire_s1(radius)
    # A second engine on a fresh state, stopped right after the search ...
    d = tmp_path / "crash"
    reset(d).conn.close()
    a = Radius(d, interrupt_after=("search", "act"))
    card = a.parse(S1_JSON)
    a.app.invoke(Command(resume={"change": card["change"]}), a._cfg(card["change"]["id"]))
    assert a.waiting_at(card["change"]["id"]) == "score"
    a.conn.close()  # ... the process dies here.
    b = Radius(d)  # a new process, the same var/
    b.app.invoke(None, b._cfg(card["change"]["id"]))
    b._finish(card["change"]["id"])
    got = b.run(b.values(card["change"]["id"])["run_id"])
    for k in ("counts", "verdicts", "incidents", "tasks", "reached"):
        assert got[k] == expected[k], k
