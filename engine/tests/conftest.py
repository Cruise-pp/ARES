import json
from pathlib import Path

import pytest

from radius.service import Radius, reset

SAMPLES = Path(__file__).resolve().parent.parent / "samples"


def sample(name: str) -> str:
    return (SAMPLES / name).read_text()


S1 = {"kind": "faulty_tool", "title": "CVE-2026-4471 · pdf-parse 2.1.4", "target": "tool",
      "where": {"all": [{"field": "name", "op": "eq", "value": "pdf-parse"},
                        {"field": "version", "op": "eq", "value": "2.1.4"}]},
      "effect": {"type": "fault", "ref": "CVE-2026-4471", "fix": "2.1.6"}}
S1_JSON = json.dumps(S1)


@pytest.fixture(autouse=True)
def offline(monkeypatch, request):
    """No network unless a test is marked live."""
    if "live" not in request.keywords:
        monkeypatch.setenv("RADIUS_OFFLINE", "1")


@pytest.fixture
def radius(tmp_path) -> Radius:
    return reset(tmp_path / "var")
