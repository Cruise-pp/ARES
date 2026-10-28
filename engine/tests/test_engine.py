"""A1 seed graph · A3 search and risk: the counts on pages 05, 07 and 30, from the graph alone."""
import time

import pytest

from radius.core import Graph, blast_radius, counts, score

g = Graph()


def run(target, *conds, mode="all"):
    starts = g.select(target, {mode: [{"field": f, "op": op, "value": v} for f, op, v in conds]})
    reached = blast_radius(g, starts)
    verdicts = score(g, reached)
    return counts(g, reached, verdicts), {v["workflow_id"]: v["action"] for v in verdicts}


def test_seed_graph_has_238_nodes_in_the_page_31_shape():
    kinds = {t: len(g.of_type(t)) for t in ("tool", "data", "agent", "workflow", "obligation", "output")}
    assert kinds == {"tool": 42, "data": 12, "agent": 26, "workflow": 63, "obligation": 19, "output": 76}
    assert len(g.unknown_agents()) == 3 and 0.9 < g.coverage() < 1


def test_s1_faulty_tool():
    c, v = run("tool", ("name", "eq", "pdf-parse"), ("version", "eq", "2.1.4"))
    assert c == {"agents": 3, "workflows": 3, "paused": 2, "warned": 1, "duties": 1, "outputs": 2, "untouched": 60}
    assert v == {"wf_customer_reply": "paused", "wf_finance_feed": "paused", "wf_contract_review": "warned"}


def test_s2_personal_data():
    c, _ = run("data", ("table", "eq", "customers"), ("column", "eq", "phone"))
    assert (c["agents"], c["workflows"], c["paused"], c["warned"]) == (5, 7, 2, 5)


def test_s3_eu_models_only():
    c, v = run("agent", ("model_region", "not_in", ["EU"]))
    assert (c["agents"], c["workflows"]) == (4, 6)
    assert sorted(v.values()) == ["paused"] * 5 + ["warned"]


@pytest.mark.parametrize("conds,agents,workflows", [
    ((("model_id", "eq", "gpt-x"),), 2, 2),
    ((("ecosystem", "eq", "npm"),), 14, 34),
])
def test_unseen_changes_need_no_new_code(conds, agents, workflows):
    target = "agent" if conds[0][0] == "model_id" else "tool"
    c, _ = run(target, *conds)
    assert (c["agents"], c["workflows"]) == (agents, workflows)


def test_a_change_to_an_obligation_reaches_the_workflows_that_serve_it():
    c, _ = run("obligation", ("name", "eq", "SOX 404"))
    assert c["workflows"] == 5


def test_same_input_same_output_in_100_runs_under_10_ms():
    start = g.select("tool", {"all": [{"field": "name", "op": "eq", "value": "pdf-parse"}]})
    first = blast_radius(g, start)
    t0 = time.perf_counter()
    for _ in range(100):
        assert blast_radius(g, start) == first
    assert (time.perf_counter() - t0) / 100 < 0.010
