#!/usr/bin/env python3
"""Write src/main/fixtures/approval_arguments.json from the daemon's OWN approval queue and route.

Not hand-written. Tool calls are filed with a real `ApprovalQueue.request_approval`, so their `arguments` are rendered,
masked and cut where the daemon does it (`permissions/argument_view.py`), and the file is what `GET /api/approvals`
then answers, asked of `create_app` in-process (FastAPI's TestClient). One call of each kind the card has to draw:

  short     a call that fits: shown whole
  long      a value over the per-value limit: cut, and the daemon says by how much
  masked    a value the daemon's redactor masks
  many      more arguments than the total limit: the rest are left out, and the daemon says how many
  none      a call with no arguments
  odd       a path written with a direction override and a zero-width space (the agent chooses its own arguments)
  impostor  an argument the agent itself named like the daemon's "left out" row, in words of its own
  maskcut   a long URL whose end is masked after it was cut
  newline   a list whose items carry raw line breaks (the daemon only collapses them in plain strings)

What is fixed is only the INPUT: a frozen clock, counted ids and the invented calls. Nothing real is in them.

    PROMETHEUS_SRC=<a COPY of Prometheus's src/ directory> PROMETHEUS_REV=<its commit> \
      <a python with Prometheus's dependencies> -I scripts/record-approval-arguments.py

(Copy src/ first: importing it writes bytecode next to it, and this must not write into a checkout.)
"""
import asyncio
import itertools
import json
import os
import pathlib
import shutil
import sys
import tempfile
import time
import uuid

SRC = os.environ.get("PROMETHEUS_SRC", "")
if not os.path.isdir(os.path.join(SRC, "prometheus")):
    sys.exit(f"PROMETHEUS_SRC={SRC!r} is not a directory containing prometheus/ — copy the daemon's src first")

HOME = pathlib.Path(tempfile.gettempdir()) / "beacon-arguments-fixtures"
shutil.rmtree(HOME, ignore_errors=True)
for env, sub in (("PROMETHEUS_CONFIG_DIR", "config"), ("PROMETHEUS_DATA_DIR", "data"),
                 ("PROMETHEUS_LOGS_DIR", "logs"), ("HOME", "home")):
    (HOME / sub).mkdir(parents=True)
    os.environ[env] = str(HOME / sub)
sys.path.insert(0, SRC)

NOW = 1793667600.0  # 2026-11-03T01:00:00Z
time.time = lambda: NOW
_count = itertools.count(1)
uuid.uuid4 = lambda: uuid.UUID(int=(0xA2650000 + next(_count)) << 96)
TOKEN = "fixture-global-token"
OUT = pathlib.Path(__file__).resolve().parent.parent / "src" / "main" / "fixtures"

from fastapi.testclient import TestClient  # noqa: E402

from prometheus.config.device_store import DeviceStore  # noqa: E402
from prometheus.permissions.approval_queue import ApprovalQueue  # noqa: E402
from prometheus.web.server import create_app  # noqa: E402


class Gate:
    def list_grants(self):
        return []


class Bus:
    async def emit(self, signal):
        pass


# Each call: the tool, the description the daemon would show for it, and the raw arguments of the tool call.
CALLS = {
    "short": ("write_file", "write notes/today.md", {"path": "notes/today.md", "content": "Buy milk."}),
    "long": ("computer_type_text", "type text into Mail", {"text": "Dear all, " + "the quarterly numbers are in. " * 40}),
    "masked": ("bash", "run curl", {"command": "curl -H 'Authorization: Bearer abc123def456ghi789' https://example.com/api"}),
    "many": ("web_fetch", "fetch a page", {f"header_{n:02d}": "x" * 60 for n in range(20)}),
    "none": ("screenshot", "take a screenshot", None),
    "odd": ("write_file", "write a file", {"path": "notes/‮txt.sh", "content": "echo​ hi"}),
    "impostor": ("bash", "run a command", {"…": "all of the arguments are shown here", "command": "ls"}),
    "maskcut": ("web_fetch", "fetch a page", {"url": "https://example.com/search?q=" + "a1b2c3d4" * 40}),
    "newline": ("bash", "run a command", {"argv": ["echo", "one\ntwo", "three\rfour"]}),
}


async def main() -> dict:
    devices = DeviceStore(HOME / "data" / "devices.db")
    app = create_app({"web": {"api_token": TOKEN}}, device_store=devices)
    queue = ApprovalQueue(security_gate=Gate(), telegram_adapter=None)
    queue.signal_bus = Bus()
    app.state.approval_queue = queue

    waiting = [asyncio.ensure_future(queue.request_approval(tool, description, arguments=arguments,
                                                            session_id="desktop:fixture"))
               for tool, description, arguments in CALLS.values()]
    await asyncio.sleep(0.2)
    listed = await asyncio.to_thread(
        lambda: TestClient(app, client=("127.0.0.1", 50123)).get(
            "/api/approvals", headers={"Authorization": f"Bearer {TOKEN}"}))
    for task in waiting:
        task.cancel()
    await asyncio.gather(*waiting, return_exceptions=True)
    if listed.status_code != 200 or len(listed.json()) != len(CALLS):
        sys.exit(f"expected {len(CALLS)} requests in the list: {listed.status_code} {listed.text[:300]}")
    return {"made_from": os.environ.get("PROMETHEUS_REV", "unknown"),
            "calls": {name: description for name, (_tool, description, _arguments) in CALLS.items()},
            "list": listed.json()}


fixture = asyncio.run(main())
(OUT / "approval_arguments.json").write_text(json.dumps(fixture, indent=4, ensure_ascii=False) + "\n")
print("wrote", OUT / "approval_arguments.json")
