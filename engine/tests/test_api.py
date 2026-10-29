"""A6 · the nine endpoints of page 31d answer in the page's shapes, against the shared S1 fixture."""
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from radius.api import create_app

from .conftest import S1_JSON

FIXTURE = json.loads((Path(__file__).parent / "run_S1.json").read_text())


def same_shape(got, want, where="run"):
    """Every key the page names is there, with the same JSON type. Extra optional keys are allowed."""
    if isinstance(want, dict):
        assert isinstance(got, dict), where
        for k, v in want.items():
            assert k in got, f"{where}.{k} missing"
            if v is not None and got[k] is not None:
                same_shape(got[k], v, f"{where}.{k}")
    elif isinstance(want, list):
        assert isinstance(got, list), where
        for i, item in enumerate(got[:1] if want else []):
            same_shape(item, want[0], f"{where}[{i}]")
    else:
        assert type(got) is type(want) or {type(got), type(want)} <= {int, float}, f"{where}: {got!r} vs {want!r}"


@pytest.fixture
def api(radius):
    with TestClient(create_app(radius)) as c:
        yield c


def fire_s1(api):
    parsed = api.post("/changes/parse", json={"text": S1_JSON}).json()
    assert set(parsed) == {"change", "state", "matches", "candidates", "readback", "reason"}
    return api.post("/changes", json={"change": parsed["change"], "mode": "live"})


def test_graph(api):
    g = api.get("/graph").json()
    assert len(g["nodes"]) == 45 and g["edges"][0].keys() == {"from", "to", "type"}
    assert {"synced_at", "coverage"} <= set(g)


def test_s1_run_has_the_fixture_shape_and_counts(api):
    run = fire_s1(api).json()
    same_shape(run, FIXTURE)
    assert run["counts"] == FIXTURE["counts"] and run["verdicts"] == FIXTURE["verdicts"]
    assert run["incidents"] == FIXTURE["incidents"] and run["tasks"] == FIXTURE["tasks"]
    assert api.get(f"/runs/{run['run_id']}").json() == run


def test_feed_task_accept_version_record(api):
    fire_s1(api)
    rows = api.get("/changes").json()
    assert set(rows[0]) == {"change_id", "title", "kind", "reach", "state", "at"}
    assert rows[0]["reach"] == "3 agents · 3 workflows" and rows[0]["state"] == "2 paused"
    t = api.get("/tasks/t_finance_feed").json()
    assert {"id", "cause", "path", "risk", "duty", "action", "owner", "next"} <= set(t["incident"])
    assert api.post("/tasks/t_finance_feed/accept").json()["state"] == "accepted"
    verdicts = api.post("/tools/tl_pdf_parse_214/version", json={"version": "2.1.6"}).json()
    assert {v["workflow_id"] for v in verdicts} >= {"wf_finance_feed", "wf_customer_reply"}
    assert api.get("/tasks/t_finance_feed").json()["task"]["state"] == "closed"
    events = [e["event"] for e in api.get("/record").json()]
    assert {"fired", "paused", "warned", "dispatched", "accepted", "closed", "resumed"} <= set(events)


def test_errors_409_422_404(api):
    vendor = {"target": "tool", "where": {"all": [{"field": "vendor", "op": "eq", "value": "Acme"}]},
              "effect": {"type": "fault"}}
    r = api.post("/changes", json={"change": vendor, "mode": "live"})
    assert r.status_code == 409 and r.json()["state"] == "none"
    assert api.post("/workflows/wf_finance_feed/resume", json={"reason": ""}).status_code == 422
    assert api.get("/tasks/t_nope").status_code == 404 and api.get("/runs/run_9999").status_code == 404
