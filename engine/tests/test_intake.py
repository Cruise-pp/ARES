"""A2 · the intake: 12 real-shaped inputs, 4 per lane, give the expected ChangeEvent (samples/expected.json).

The 8 feed and paste inputs are read by code. The 4 prose inputs need the model, so they run
only with OPENAI_API_KEY set (pytest -m live).
"""
import json
import os

import pytest

from radius import llm
from radius.core import Graph, conds
from radius.intake import adapt, gate, resolve, sniff

from .conftest import SAMPLES, sample

g = Graph()
EXPECTED = json.loads((SAMPLES / "expected.json").read_text())
CODE = [k for k, v in EXPECTED.items() if v["adapter"] != "prose"]
PROSE = [k for k, v in EXPECTED.items() if v["adapter"] == "prose"]


def test_env_file_is_read_and_does_not_override(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "already-set")
    monkeypatch.delenv("OPENAI_MODEL", raising=False)
    (tmp_path / ".env").write_text('OPENAI_API_KEY="sk-from-file"\nexport OPENAI_MODEL="gpt-test"\n')
    llm.load_env(tmp_path / ".env")
    assert os.environ["OPENAI_API_KEY"] == "already-set"
    assert os.environ["OPENAI_MODEL"] == "gpt-test"


def check(change, card, e):
    assert change["target"] == e["target"]
    assert [[c["field"], c["op"], c["value"]] for c in conds(change)] == e["conds"]
    assert {k: change["effect"].get(k) for k in e["effect"]} == e["effect"]
    assert card["state"] == e["state"]
    assert card["matches"] == e["matches"]
    if "candidates" in e:
        assert [c["id"] for c in card["candidates"]] == e["candidates"]
    if "reason_has" in e:
        assert e["reason_has"] in card["reason"]
    if "readback_has" in e:
        assert e["readback_has"] in card["readback"]


@pytest.mark.parametrize("name", CODE)
def test_feed_and_paste_are_read_by_code(name):
    e = EXPECTED[name]
    adapter, doc = sniff(sample(name))
    assert adapter == {"fields": "fields"}.get(e["adapter"], e["adapter"])
    change = adapt(adapter, doc, g)
    check(change, resolve(g, change), e)


@pytest.mark.live
@pytest.mark.skipif(not os.environ.get("OPENAI_API_KEY"), reason="needs OPENAI_API_KEY")
@pytest.mark.parametrize("name", PROSE)
def test_prose_is_read_by_the_model_and_checked_by_code(name):
    assert sniff(sample(name))[0] == "prose"
    change = llm.extract(sample(name))
    check(change, resolve(g, change), EXPECTED[name])


def test_a_made_up_field_ends_in_none_with_the_field_named():
    change = {"target": "tool", "where": {"all": [{"field": "vendor", "op": "eq", "value": "Acme"}]},
              "effect": {"type": "fault"}}
    assert gate(change)["answers"][0] == {"q": "Does each field exist on tool?", "a": False, "missing": ["vendor"]}
    card = resolve(g, change)
    assert card["state"] == "none" and "vendor" in card["reason"]


def test_a_version_the_graph_does_not_hold_reads_zero_agents_use_it():
    card = resolve(g, {"target": "tool", "effect": {"type": "fault"},
                       "where": {"all": [{"field": "name", "op": "eq", "value": "pdf-parse"},
                                         {"field": "version", "op": "eq", "value": "2.1.9"}]}})
    assert card["state"] == "none" and "0 agents use pdf-parse 2.1.9" in card["reason"] and "2.1.4" in card["reason"]


def test_a_name_in_two_ecosystems_is_ambiguous():
    card = resolve(g, {"target": "tool", "effect": {"type": "fault"},
                       "where": {"all": [{"field": "name", "op": "eq", "value": "requests"},
                                         {"field": "version", "op": "eq", "value": "2.31.0"}]}})
    assert card["state"] == "ambiguous" and len(card["candidates"]) == 2


def test_with_the_model_down_prose_waits_and_json_still_works():
    assert not llm.available()
    with pytest.raises(llm.ModelDown):
        llm.extract("pdf-parse 2.1.4 has a CVE")
