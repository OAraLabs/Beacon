#!/usr/bin/env python3
"""Write src/main/fixtures/chat_projects.json from the daemon's OWN chat-projects routes.

Not hand-written. Every exchange below is a real request to the daemon's real app (`create_app`, its bearer middleware, device
tokens, the session path guard, the conversation store and its projects store, a real WebSocketBridge for the frame), made in
process with FastAPI's TestClient, as the daemon's own tests do (tests/test_chat_projects_routes.py). What is fixed is only the
INPUT: a frozen clock, counted ids and the invented names. The answers are the daemon's.

    PROMETHEUS_SRC=<a COPY of Prometheus's src/ directory> PROMETHEUS_TESTS=<a copy of its tests/ parent> \
    PROMETHEUS_REV=<commit> <a python with Prometheus's dependencies> -I scripts/record-chat-projects.py

PROMETHEUS_TESTS is a directory holding `tests/` (the daemon's World helper lives there). Copy both first: importing writes
bytecode next to the source, and this must not write into a checkout.
"""
import itertools
import json
import os
import pathlib
import shutil
import sys
import time
import types
import urllib.parse
import uuid

SRC = os.environ.get("PROMETHEUS_SRC", "")
TESTS = os.environ.get("PROMETHEUS_TESTS", "")
if not os.path.isdir(os.path.join(SRC, "prometheus")) or not os.path.isdir(os.path.join(TESTS, "tests")):
    sys.exit("PROMETHEUS_SRC must hold prometheus/ and PROMETHEUS_TESTS must hold tests/: copy the daemon's src and tests first")

BASE = pathlib.Path("/tmp") / "beacon-chat-projects-fixture"  # a fixed place: the answers carry folder paths
shutil.rmtree(BASE, ignore_errors=True)
BASE.mkdir(parents=True)
for env, sub in (("PROMETHEUS_CONFIG_DIR", "config"), ("PROMETHEUS_DATA_DIR", "data"), ("PROMETHEUS_LOGS_DIR", "logs"),
                 ("HOME", "home")):
    (BASE / sub).mkdir()
    os.environ[env] = str(BASE / sub)
sys.path[:0] = [SRC, TESTS]

NOW = 1793667600.0  # 2026-11-03T01:00:00Z
time.time = lambda: NOW
_count = itertools.count(1)
uuid.uuid4 = lambda: uuid.UUID(int=(0xB3760000 + next(_count)) << 96)
_ids = itertools.count(1)

import prometheus.projects.store as _store  # noqa: E402

_store.secrets = types.SimpleNamespace(token_hex=lambda n: f"{next(_ids):0{2 * n}x}")
OUT = pathlib.Path(__file__).resolve().parent.parent / "src" / "main" / "fixtures"

from prometheus.memory.lcm_types import MessagePart  # noqa: E402
from tests.test_chat_projects_routes import World, _Socket  # noqa: E402


def q(session_id: str) -> str:
    """A session id as Beacon puts it in a path (encodeURIComponent): the colon is escaped."""
    return urllib.parse.quote(session_id, safe="")


def main() -> dict:
    tmp = BASE / "world"
    tmp.mkdir()
    w = World(tmp)
    os.environ["HOME"] = str(w.home)  # the daemon compares folders against the home it sees
    exchanges: list[dict] = []

    # An owner's socket and a chat-only device's, registered the way the daemon's own test does: every frame the routes send
    # is kept, and only the owner's socket may hear it.
    from prometheus.config.api_token import GLOBAL_IDENTITY, DeviceIdentity

    owner_sock, device_sock = _Socket(), _Socket()
    w.bridge._clients.update({owner_sock, device_sock})
    w.bridge._ws_identity[owner_sock] = GLOBAL_IDENTITY
    w.bridge._ws_identity[device_sock] = DeviceIdentity(id=w.a["id"])

    def call(label: str, who: str, method: str, url: str, body=None, **kw) -> dict:
        r = w.call(who, method, url, **({"json": body} if body is not None else {}), **kw)
        try:
            parsed = r.json()
        except ValueError:
            parsed = None
        exchanges.append({"label": label, "as": who, "method": method, "path": url, "request": body, "status": r.status_code,
                          "body": parsed})
        return parsed if isinstance(parsed, dict) else {}

    # The daemon says what it serves in the `subscribed` reply.
    capabilities = w.bridge._server_capabilities()

    call("a route this daemon does not have", "op", "GET", "/api/there-is-no-such-route")  # what a daemon without projects says
    call("list, none yet", "op", "GET", "/api/chat-projects")
    kitchen = call("create, a managed folder", "op", "POST", "/api/chat-projects",
                   {"name": "Kitchen remodel", "import_key": "beacon-desktop:p1"})["project"]
    call("create again, same import key", "op", "POST", "/api/chat-projects", {"name": "Kitchen remodel", "import_key": "beacon-desktop:p1"})
    call("create, same name in another case", "op", "POST", "/api/chat-projects", {"name": "  KITCHEN remodel "})
    repo = w.folder("repo")
    garden = call("create, a folder the owner picked", "op", "POST", "/api/chat-projects", {"name": "Garden", "folder": repo})["project"]
    call("create, a name taken (with another folder)", "op", "POST", "/api/chat-projects", {"name": "garden", "folder": w.folder("other")})
    call("create, a folder already used", "op", "POST", "/api/chat-projects", {"name": "Another", "folder": repo})
    call("create, the home folder", "op", "POST", "/api/chat-projects", {"name": "Home", "folder": str(w.home)})
    call("create, a folder that is not there", "op", "POST", "/api/chat-projects", {"name": "Nowhere", "folder": str(w.home / "nope")})
    call("create, no name", "op", "POST", "/api/chat-projects", {"name": "   "})
    call("create, a chat-only device", "a", "POST", "/api/chat-projects", {"name": "Not allowed"})
    call("list", "op", "GET", "/api/chat-projects")
    call("list, as a chat-only device", "a", "GET", "/api/chat-projects")
    call("get one", "op", "GET", f"/api/chat-projects/{garden['id']}")
    call("get, unknown", "op", "GET", "/api/chat-projects/cp_000000000000")
    call("rename", "op", "PUT", f"/api/chat-projects/{garden['id']}", {"name": "Back garden"})
    call("rename, a name taken", "op", "PUT", f"/api/chat-projects/{garden['id']}", {"name": "Kitchen REMODEL"})

    # Conversations: the owner's, a second one a person set a folder on by hand, and a chat-only device's.
    s1 = w.session("op")
    s2 = w.session("op")
    s3 = w.session("a")
    s4 = w.session("op")
    call("a conversation's folder chosen by hand", "op", "PUT", f"/api/sessions/{q(s2)}/workspace", {"path": w.folder("hand-picked")})
    call("file", "op", "PUT", f"/api/sessions/{q(s1)}/project", {"chat_project_id": kitchen["id"]})
    call("file, a folder was chosen by hand", "op", "PUT", f"/api/sessions/{q(s2)}/project", {"chat_project_id": kitchen["id"]})
    call("file, replacing the hand-chosen folder", "op", "PUT", f"/api/sessions/{q(s2)}/project",
         {"chat_project_id": kitchen["id"], "replace_workspace": True})
    call("file, as a label only (the folder is kept)", "op", "PUT", f"/api/sessions/{q(s4)}/project",
         {"chat_project_id": garden["id"], "keep_workspace": True})
    call("file, a chat-only device's conversation", "op", "PUT", f"/api/sessions/{q(s3)}/project", {"chat_project_id": kitchen["id"]})
    call("file a device's conversation as a label only", "op", "PUT", f"/api/sessions/{q(s3)}/project",
         {"chat_project_id": kitchen["id"], "keep_workspace": True})
    call("list, as a chat-only device that has a conversation filed", "a", "GET", "/api/chat-projects")
    call("file, a session the daemon does not have", "op", "PUT", f"/api/sessions/{q('desktop:gone')}/project", {"chat_project_id": kitchen["id"], "keep_workspace": True})
    w.conv.add_message("eval:nightly", MessagePart(role="user", content="tick", session_id="eval:nightly", turn_index=0))
    call("file, a machine session", "op", "PUT", f"/api/sessions/{q('eval:nightly')}/project", {"chat_project_id": kitchen["id"], "keep_workspace": True})
    call("file, a project that is not there", "op", "PUT", f"/api/sessions/{q(s1)}/project", {"chat_project_id": "cp_000000000000"})
    call("file, as a chat-only device", "a", "PUT", f"/api/sessions/{q(s3)}/project", {"chat_project_id": kitchen["id"]})
    listed = w.call("op", "GET", "/api/sessions").json()
    exchanges.append({"label": "the session list carries the filing", "as": "op", "method": "GET", "path": "/api/sessions",
                      "request": None, "status": 200,
                      "body": [{"session_id": r["session_id"], "chat_project_id": r.get("chat_project_id"),
                                "has_chat_project_id": "chat_project_id" in r} for r in listed]})
    call("get, with its conversations", "op", "GET", f"/api/chat-projects/{kitchen['id']}")
    call("start a conversation inside a project", "op", "POST", "/api/sessions", {"gateway": "desktop", "chat_project_id": garden["id"]})
    call("start a conversation, a project that is not there", "op", "POST", "/api/sessions", {"gateway": "desktop", "chat_project_id": "cp_000000000000"})

    # A suggestion from tool calls into a folder that is a project, and one that is not.
    s5 = w.session("op")
    for i, path in enumerate([f"{repo}/a.ts", f"{repo}/b.ts", f"{repo}/c.ts"]):
        blocks = [{"type": "text", "text": "ok"}, {"type": "tool_use", "id": f"t{i}", "name": "read_file", "input": {"path": path}}]
        w.conv.add_message(s5, MessagePart(role="assistant", content="ok", content_json=json.dumps(blocks), session_id=s5, turn_index=i + 1))
    s6 = w.session("op")
    elsewhere = str(w.home / "projects" / "new-thing" / "src")
    for i, path in enumerate([f"{elsewhere}/a.ts", f"{elsewhere}/b.ts", f"{elsewhere}/c.ts"]):
        blocks = [{"type": "text", "text": "ok"}, {"type": "tool_use", "id": f"u{i}", "name": "read_file", "input": {"path": path}}]
        w.conv.add_message(s6, MessagePart(role="assistant", content="ok", content_json=json.dumps(blocks), session_id=s6, turn_index=i + 1))
    call("suggestions", "op", "GET", "/api/chat-project-suggestions")
    call("suggestions, as a chat-only device", "a", "GET", "/api/chat-project-suggestions")

    call("file, unfile", "op", "PUT", f"/api/sessions/{q(s1)}/project", {"chat_project_id": None})

    framed = call("create, for the frame it makes", "op", "POST", "/api/chat-projects", {"name": "Framed"})["project"]
    call("delete", "op", "DELETE", f"/api/chat-projects/{framed['id']}")
    frames = [f for f in owner_sock.frames if f["type"] == "chat_project_changed"]
    device_frames = [f for f in device_sock.frames if f["type"] == "chat_project_changed"]
    call("delete, a project that is not there", "op", "DELETE", "/api/chat-projects/cp_000000000000")
    call("delete, as a chat-only device", "a", "DELETE", f"/api/chat-projects/{kitchen['id']}")
    return {"made_from": os.environ.get("PROMETHEUS_REV", "unknown"), "capabilities": capabilities,
            "sessions": {"filed": s1, "hand_chosen_folder": s2, "device": s3, "label_only": s4, "suggested_into_project": s5,
                         "suggested_new": s6},
            "frames": frames, "device_got_frames": len(device_frames), "exchanges": exchanges}


fixture = main()
(OUT / "chat_projects.json").write_text(json.dumps(fixture, indent=2, ensure_ascii=False) + "\n")
print("wrote", OUT / "chat_projects.json", f"({len(fixture['exchanges'])} exchanges, {len(fixture['frames'])} frames)")
