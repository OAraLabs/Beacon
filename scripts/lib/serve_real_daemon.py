#!/usr/bin/env python3
"""Serve the REAL Prometheus app (the pairing routes included) for Beacon's probes, on an ephemeral loopback port.

Not a stub: this builds `prometheus.web.server.create_app` with the real bearer middleware, the real DeviceStore and
the real pairing store, and serves it with uvicorn. It exists so a probe can check Beacon against what the daemon
does, not against a second reading of the contract (docs/PAIRING-APPROVAL-API.md on Prometheus #697/#698).

    python serve_real_daemon.py --src <prometheus clone>/src --home <scratch dir> --token T --ws-port N [--no-requests] [--tls]
                                [--setup-mode] [--no-auth] [--daemon-limits]

Every Prometheus location (HOME, XDG, PROMETHEUS_*) is pointed INTO --home before prometheus is imported, so nothing
is written to the real ~/.prometheus. Binds 127.0.0.1 port 0 and prints one JSON line when ready:
    {"ready": true, "port": N, "fp": "...", "module": "<path of the imported prometheus>"}
It runs until stdin closes (the probe's death included) or it is sent SIGTERM.

--tls adds the home-network TLS listeners (Prometheus #721) the way web/launcher.py starts them: the same app through
`start_web(..., tls=plan)` and the WebSocket bridge with `server_ssl_context(plan)`, over the instance certificate, with
`app.state.lan_tls` set. The plan's host is 127.0.0.1, never a LAN address: a real daemon only runs these on a home-network
bind, which this never makes. The ready line then also has "tls_port", "tls_ws_port" and "pin" (instance_spki_sha256).

--setup-mode serves what `oara daemon` serves when it finds no config: web/setup_server.py's create_setup_app (its own app, the
real route surface not mounted), over the same instance key, on 127.0.0.1. --no-auth is the full app with no API token, which a
daemon runs when web.api_token is unset. --daemon-limits keeps the daemon's own pairing limits (pairing.max_pending and friends)
instead of the probes' generous ones. With --no-ws, --ws-port is only what the config SAYS (the port an approval names); nothing
listens on it.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import signal
import sys
import threading
import time
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("--src", required=True)
ap.add_argument("--home", required=True)
ap.add_argument("--token", required=True)
ap.add_argument("--ws-port", type=int, required=True)
ap.add_argument("--name", default="Probe Prometheus")
ap.add_argument("--no-requests", action="store_true", help="pairing.requests_enabled: false (hello then says pair=token)")
ap.add_argument("--ttl", type=int, default=300)
ap.add_argument("--no-ws", action="store_true", help="do not start the WebSocket bridge (Prometheus #699 and later send the pairing frames over it)")
ap.add_argument("--tls", action="store_true", help="also serve the app and the bridge over TLS on 127.0.0.1, as a home-network daemon does on its LAN bind")
ap.add_argument("--per-source", type=int, default=20, help="pairing.max_pending_per_source (the daemon's own default is 1)")
ap.add_argument("--setup-mode", action="store_true", help="serve setup mode (create_setup_app), as `oara daemon` does with no config")
ap.add_argument("--no-auth", action="store_true", help="the full app with no API token (web.api_token unset)")
ap.add_argument("--daemon-limits", action="store_true", help="the daemon's own pairing limits, not the probes' generous ones")
args = ap.parse_args()

home = Path(args.home).resolve()
for key in [k for k in os.environ if k.startswith("PROMETHEUS_") or k.endswith("_PROXY") or k.endswith("_proxy") or k == "FORWARDED_ALLOW_IPS"]:
    del os.environ[key]
dirs = {
    "HOME": home,
    "XDG_DATA_HOME": home / "xdg/data",
    "XDG_CONFIG_HOME": home / "xdg/config",
    "XDG_CACHE_HOME": home / "xdg/cache",
    "XDG_STATE_HOME": home / "xdg/state",
    "TMPDIR": home / "tmp",
    "PROMETHEUS_HOME": home / ".prometheus",
    "PROMETHEUS_CONFIG_DIR": home / ".prometheus",
    "PROMETHEUS_DATA_DIR": home / ".prometheus/data",
    "PROMETHEUS_LOGS_DIR": home / ".prometheus/logs",
    "PROMETHEUS_NODE_DIR": home / ".prometheus/node",
    "PROMETHEUS_WORKSPACE_DIR": home / ".prometheus/workspace",
    "PROMETHEUS_FILES_ROOT": home / ".prometheus/files",
    "PROMETHEUS_DOCUMENTS_DIR": home / ".prometheus/documents",
    "PROMETHEUS_ARTIFACTS_DIR": home / ".prometheus/artifacts",
    "PROMETHEUS_WIKI": home / ".prometheus/wiki",
    "PROMETHEUS_VAULT": home / ".prometheus/vault",
    "PROMETHEUS_LOCAL_PAIRING_DIR": home / ".prometheus/local-pairing",
}
for key, path in dirs.items():
    path.mkdir(parents=True, exist_ok=True)
    os.environ[key] = str(path)
os.environ["PROMETHEUS_ENV_FILE"] = str(home / ".prometheus/.env")
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"

src = str(Path(args.src).resolve())
sys.path.insert(0, src)

import uvicorn  # noqa: E402
import prometheus  # noqa: E402

assert str(Path(prometheus.__file__).resolve()).startswith(src), f"prometheus came from {prometheus.__file__}, not {src}"

from prometheus.config import display_name as display_name_mod  # noqa: E402
from prometheus.config import instance_key  # noqa: E402
from prometheus.config.device_store import DeviceStore  # noqa: E402
from prometheus.web.server import create_app  # noqa: E402
from prometheus.engine.session import SessionManager  # noqa: E402
from prometheus.web.ws_server import WebSocketBridge  # noqa: E402

der = instance_key.ensure_instance_key()  # the daemon makes this at boot
pairing: dict = {"display_name": args.name, "request_ttl_seconds": args.ttl}
if not args.daemon_limits:
    pairing.update({"max_pending": 20, "max_pending_per_source": args.per_source, "max_requests_per_source_per_hour": 500})
if args.no_requests:
    pairing["requests_enabled"] = False
config = {"web": {"ws_port": args.ws_port}, "pairing": pairing}
if not args.no_auth:
    config["web"]["api_token"] = args.token
plan = None
if args.tls:
    import socket

    from prometheus.config.instance_cert import cert_path, ensure_instance_certificate, instance_spki_sha256, key_path
    from prometheus.web.tls import LanTlsPlan

    def _free_port() -> int:
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            return s.getsockname()[1]

    ensure_instance_certificate()  # the daemon makes it at boot, over the instance key
    plan = LanTlsPlan(host="127.0.0.1", api_port=_free_port(), ws_port=_free_port(), certfile=cert_path(), keyfile=key_path())
    # What a home-network daemon's config says: the switch on, and the TLS ports it listens on.
    config["web"].update({"tls_api_port": plan.api_port, "tls_ws_port": plan.ws_port})
    config["network"] = {"home_network": True}
display_name_mod._cache = (time.monotonic() + 10 ** 9, args.name)
store = DeviceStore(home / "devices.db")
setup_port = None
if args.setup_mode:
    import socket

    from prometheus.web.setup_server import PairingState, SetupModeState, create_setup_app

    with socket.socket() as _s:  # setup mode is told its port up front, as run_setup_mode tells it
        _s.bind(("127.0.0.1", 0))
        setup_port = _s.getsockname()[1]
    app = create_setup_app(PairingState(), api_port=setup_port, ws_port=args.ws_port, bind="127.0.0.1", state=SetupModeState())
    args.no_ws = True  # setup mode has no bridge
else:
    app = create_app(config, device_store=store)
if plan is not None:
    app.state.lan_tls = plan  # as web/launcher.py sets it

# The REAL WebSocket bridge, attached the way the launcher attaches it (web/launcher.py): a daemon from Prometheus #699 sends the owner's
# sockets pairing_pending / pairing_resolved here. Nothing of a model, a session or an agent is behind it: only what a Beacon needs to connect.
bridge = None
if not args.no_ws:
    bridge = WebSocketBridge(session_mgr=SessionManager(), api_token=None if args.no_auth else args.token, device_store=store, loop_context=None)
    app.state.ws_bridge = bridge
    if hasattr(bridge, "attach_pairing") and getattr(app.state, "pairing", None) is not None:
        bridge.attach_pairing(app.state.pairing)

server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=setup_port or 0, log_level="warning", log_config=None))


def _stop(*_: object) -> None:
    server.should_exit = True
    tls_server = getattr(app.state, "https_server", None)  # --tls: the second server over the same app
    if tls_server is not None:
        tls_server.should_exit = True


def _watch_stdin() -> None:
    try:
        sys.stdin.read()
    finally:
        _stop()


threading.Thread(target=_watch_stdin, daemon=True).start()
signal.signal(signal.SIGTERM, _stop)


async def _main() -> None:
    task = asyncio.create_task(server.serve())
    while not server.started:
        if task.done():
            await task
        await asyncio.sleep(0.05)
    if bridge is not None:
        await bridge.start("127.0.0.1", args.ws_port)
    socks = [s for srv in server.servers for s in srv.sockets]
    name = socks[0].getsockname()
    assert name[0] == "127.0.0.1" and name[1] > 0 and name[1] not in (8005, 8006, 8010, 8011), name
    import hashlib

    ready = {"ready": True, "mode": "setup" if args.setup_mode else "daemon", "auth": not args.no_auth, "port": name[1], "fp": hashlib.sha256(der).hexdigest()[:16], "module": prometheus.__file__, "ws": bridge is not None, "frames": bool(bridge is not None and hasattr(bridge, "attach_pairing"))}
    tasks = [task]
    if plan is not None:
        from prometheus.web.server import start_web
        from prometheus.web.tls import server_ssl_context

        tasks.append(asyncio.create_task(start_web(app, host=plan.host, port=plan.api_port, config=config, tls=plan)))
        while getattr(app.state, "https_server", None) is None or not app.state.https_server.started:
            if tasks[-1].done():
                await tasks[-1]
            await asyncio.sleep(0.05)
        tls_socks = [s.getsockname() for srv in app.state.https_server.servers for s in srv.sockets]
        if bridge is not None:
            await bridge.start(host=plan.host, port=plan.ws_port, ssl=server_ssl_context(plan))
        assert tls_socks and all(n[0] == "127.0.0.1" and n[1] == plan.api_port for n in tls_socks), tls_socks
        assert {plan.api_port, plan.ws_port}.isdisjoint({8005, 8006, 8010, 8011}), plan
        ready.update({"tls_port": plan.api_port, "tls_ws_port": plan.ws_port, "pin": instance_spki_sha256()})
    print(json.dumps(ready), flush=True)
    await asyncio.gather(*tasks)


asyncio.run(_main())
