"""What the API serves, kept in one JSON file so a person can open it and read it.

The LangGraph checkpoints (var/radius.db) hold each run's pipeline state. This file holds the
results: changes, receipts, runs, incidents, tasks, graph edits, and the append-only record.
"""
from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

COLLECTIONS = ("changes", "receipts", "runs", "incidents", "tasks")
# Where each id starts, so a fresh demo opens chg_0142, rcpt_88 and INC-2041 as on the pages.
FIRST = {"change": 142, "receipt": 88, "run": 1, "incident": 2041}
FORMAT = {"change": "chg_{:04d}", "receipt": "rcpt_{}", "run": "run_{:04d}", "incident": "INC-{}"}


class Store:
    def __init__(self, path: Path, clock: Callable[[], datetime] | None = None):
        self.path = Path(path)
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.lock = threading.RLock()  # the API finishes messages on a background thread
        empty = {**{c: {} for c in COLLECTIONS}, "record": [], "overrides": {}, "counters": dict(FIRST)}
        self.data = {**empty, **json.loads(self.path.read_text())} if self.path.exists() else empty

    def save(self) -> None:
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data, indent=1, ensure_ascii=False))
        tmp.replace(self.path)  # atomic: a crash never leaves half a file

    def now(self) -> str:
        return self.clock().isoformat(timespec="seconds")

    def clock_line(self) -> str:
        return self.clock().astimezone().strftime("%H:%M:%S")

    def next_id(self, kind: str) -> str:
        with self.lock:
            n = self.data["counters"][kind]
            self.data["counters"][kind] = n + 1
            self.save()
            return FORMAT[kind].format(n)

    def set_counter(self, kind: str, n: int) -> None:
        with self.lock:
            self.data["counters"][kind] = n
            self.save()

    def get(self, coll: str, key: str) -> dict | None:
        return self.data[coll].get(key)

    def all(self, coll: str) -> list[dict]:
        return list(self.data[coll].values())

    def put(self, coll: str, key: str, doc: dict) -> dict:
        with self.lock:
            self.data[coll][key] = doc
            self.save()
            return doc

    def update(self, coll: str, key: str, **fields) -> dict:
        with self.lock:
            self.data[coll][key].update(fields)
            self.save()
            return self.data[coll][key]

    def log(self, event: str, **fields) -> None:
        """The record: fired, paused, warned, resumed (with reason), closed, dispatched. Append only."""
        with self.lock:
            self.data["record"].append({"at": self.now(), "event": event, **fields})
            self.save()

    def override(self, node_id: str, field: str, value) -> None:
        with self.lock:
            self.data["overrides"].setdefault(node_id, {})[field] = value
            self.save()
