# Multi-computer in v0.4: the home-network switch, TLS pinning, and finding Prometheus on the network

**Status (2026-10-10): spec, written before the code.** The owner moved multi-computer into v0.4 (2026-10-10). Beacon builds each
part against the Prometheus PR it depends on, as that PR lands: the network setting and mDNS (**Prometheus PR 700**, draft,
"pairing PR 4 of 5"), TLS (**pairing PR 5**, not opened), and a restart route (**not opened**). Red tests come first, in
draft PRs. Where Beacon assumes a shape Prometheus has not built, this spec says so, and the shape lives in one module.

**Update (2026-10-11):** Prometheus PR 700 and TLS (Prometheus PR 721, pairing PR 5) are merged; the restart route is Prometheus PR 724 (draft). §2 is built against
answers recorded from the real daemons, and §2.2 and §2.4 now say what those answers were.

The Prometheus contract is `docs/PAIRING-APPROVAL-API.md` on Prometheus PR 700 (head `0913521`, read 2026-10-10): §2 the network setting,
§3 discovery, §7 transport security. Beacon's existing pieces: discovery (O2a, O2b), approval (O3), the owner's prompt (O5).

## 1. The whole picture

1. **On the Mac that runs Prometheus**, its owner opens Beacon's Settings and turns on **"Let other computers on my home
   network connect"** (§2). Prometheus saves the choice; a restart applies it (§2.4).
2. After the restart Prometheus listens on the home network **over TLS only** (a self-signed certificate over its instance
   key; plain HTTP stays on this Mac's loopback), and **announces itself** as `_prometheus._tcp` (Prometheus PR 700 §2.1, §3.1, §7.3).
3. **On another computer**, Beacon's first run (path B) finds it by mDNS (or a typed address, or the tailnet) and confirms
   it with `GET /api/hello` (§4).
4. That Beacon asks to join (O3). The TLS handshake shows it the certificate's public key; Beacon checks it against what
   hello and the request answer say, and **the 4-digit code both screens show is computed over that key** (§3).
5. The owner approves on the Mac (O5). The new computer keeps its credential **and the pin**, and from then on every REST
   and WebSocket connection to that Prometheus must present the pinned key, or Beacon refuses it with a clear card (§3.4).

## 2. The switch: "Let other computers on my home network connect"

### 2.1 Where it is, and who sees it

- **Beacon Settings → Other computers**, a new section in `ConnectionSettings`.
- Shown only for a connection whose `GET /api/network` answers **200** (an operator: the owner device on that Mac, or the
  master token). A **403 `operator_only`** (an ordinary approved device) shows no section. Any other failure shows the
  section with "Beacon couldn't read this setting from Prometheus." and [Try again].
- **`can_change: false`** shows the section with the state but no switch, and says why from `bind_source` (§2.3).

### 2.2 What it shows (from `GET /api/network`, Prometheus PR 700 §2.2; nine keys)

| `mode` (running) | `applied` | The switch | The line under it |
|---|---|---|---|
| `this_mac` | `live` | off | Only this Mac can use Prometheus. |
| `home_network` | `live` | on | Beacon on your other computers can find this Prometheus and ask to connect. You approve each one. |
| `open` | `live` | off, plus a note | Prometheus can already be reached from other computers, without the home-network protections. Turn this on to use them. |
| any | `on_restart` | the **saved** choice (`pending_mode`) | Restart Prometheus to finish. [Restart now] (§2.4) |

**One trap in the wire (recorded):** `GET`'s `mode` is what is **running**, with `pending_mode` for a saved change; `PUT`'s 200
reports the **saved** state in the same keys, with no `pending_mode`. Beacon shows only `GET`'s answer: after a `PUT` it reads
the setting back.

Beneath it, one line per `warnings[]` entry and for `advertising_reason` when the mode is `home_network`, in Beacon's own
words keyed by `code`; **an unknown code shows the daemon's `message`**, never nothing (Prometheus PR 700: "Clients must tolerate a code
they do not know").

| `code` | Beacon's line |
|---|---|
| `plain_http_on_lan` | Messages to Prometheus travel unencrypted on your home network. |
| `home_network_unavailable` | Prometheus can't share safely on your network yet, so it isn't announcing itself. |
| `home_network_on_loopback` | Prometheus is set to share, but it only listens on this Mac. |
| `listening_on_all_interfaces` | Prometheus listens on every network this Mac is on. |
| `restart_required` | (covered by the restart line) |
| `advertising_reason: no_usable_address` | This Mac isn't on a home network right now, so other computers can't find it. |
| `advertising_reason: library_missing` | Prometheus can't announce itself on this network (it's missing a part). Other computers can still connect by address. |
| `advertising_reason: registration_failed` | Prometheus couldn't announce itself; it will keep trying. |
| other `advertising_reason` codes while `home_network` | the daemon's `message` |

### 2.3 Changing it (`PUT /api/network {"mode"}`)

On: `home_network`. Off: `this_mac`. `open` is never sent (Prometheus PR 700: not a choice). Each answer:

| Answer | What Beacon shows |
|---|---|
| 200, `applied: on_restart` | the restart line (§2.4) |
| 200, `applied: live` | the new state, nothing to restart |
| 409 `tls_unavailable` | Prometheus needs an update before it can share safely on your network. (switch back) |
| 409 `would_lock_out` | Turn this off from the Mac running Prometheus: doing it from here would disconnect this computer. |
| 409 `bind_overridden` (`source`) | as `can_change: false` below |
| 409 `no_config_file` | Prometheus wasn't started from a settings file, so this can't be saved here. |
| 500 `persist_failed` | Prometheus couldn't save this. Nothing changed. |
| 400, 403, other | Beacon couldn't change this setting. (Copy details: status and body) |

`can_change: false` / `bind_overridden`, by `bind_source`: `flag` "Prometheus was started in a way that keeps it on this
Mac." (the Mac app's launcher passes `--bind 127.0.0.1` today; Prometheus is changing it to read `web.bind`, §6);
`env` "Prometheus's address is set where it starts, so it can't be changed here."; `caller` "Prometheus was set up to stay
on the address Beacon first reached it on."

### 2.4 Restart

`PUT` only saves (Prometheus PR 700: "It is saved, not applied"; live rebinding is not built). The restart is Prometheus PR 724's
**`POST /api/restart`** (operator only; a draft when this was built), and every answer below was recorded from it
(`src/main/fixtures/network_setting_700.json`, by `scripts/record-network-setting.mjs`):

- **202** `{"restarting": true}`: the daemon's graceful shutdown, then a re-exec of its own command line in the same process.
  A real one was gone and back in about 1 s.
- Beacon asks `GET /api/hello` **first** for the `fp`, then the route, then waits up to 60 s for Prometheus to **go away**
  and answer hello again **with the same `fp`** (an answer before it went away is the old process), then reads
  `GET /api/network` again. "Restarting Prometheus…" meanwhile; "Prometheus didn't come back." [Try again] after; another
  `fp` is "Something else answered at Prometheus's address after the restart, so Beacon isn't using it."
- **Without the route**: a Prometheus before Prometheus PR 724 answers **405** (recorded: its page catch-all owns the path; 404 is
  treated the same), and Prometheus PR 724's **503 `restart_unavailable`** is a process that was not started as the daemon. Each is "This
  Prometheus can't be restarted from Beacon. Restart it on the Mac it runs on to finish.", and [Restart now] goes.
- 400 `browser_not_allowed` (an `Origin` header: Beacon's main process sends none), 401, 403: "Beacon couldn't restart
  Prometheus."
- **Not built in the first cut:** for Prometheus on this Mac without the route, [Restart Prometheus] through the app's
  launcher (`--unregister` then `--register`, the contract's update path). It touches launchd; a later PR.

## 3. TLS pinning (trust on first use, confirmed by the 4-digit match)

### 3.1 What is pinned

**The SHA-256 of the certificate's SubjectPublicKeyInfo (SPKI DER), all 32 bytes** (Prometheus PR 700 §7.3: "Pin. SHA-256 of the SPKI DER,
all 32 bytes. TXT and hello carry the first 16 hex characters for display and change detection only"). Names, dates and the
issuer are ignored: the daemon's certificate is self-signed and re-issued over the same key, so the key is the identity.

The owner's brief said "pin the cert fingerprint from /api/hello". Hello's `fp` is those **first 16 hex characters** (64 bits):
enough to notice a change, not enough to trust, and the contract says never a trust anchor. So Beacon pins the full SPKI hash
it sees in the TLS handshake, and uses hello's `fp` as a check on it (§3.2).

### 3.2 Learning it, at first contact (O3 over TLS)

When the computer Beacon is joining says `tls: true` (hello, or TXT `tls=1`):

1. `GET /api/hello` over TLS **without** a pin (it carries no credential; it is display only). Beacon records the SPKI hash
   of the certificate it was shown.
2. `POST /api/pair/requests` over TLS, on a connection that must present **the same SPKI** as step 1.
3. Before anything is shown: **the first 16 hex characters of the SPKI hash must equal hello's `fp`**, and **the SPKI must be
   the key in the 201's `instance_public_key`** (Prometheus PR 700 §7.3: "records the SPKI it saw, and checks it equals
   instance_public_key in the response"). The 4-digit code is computed over that key (§4.4), so the code the owner compares
   is bound to the certificate this computer actually met. Any disagreement: the request is withdrawn and the card is
   "Something on your network isn't the Prometheus it says it is" (no code shown).
4. The polls and the collection run on the pinned connection. When the token is kept, **the pin is kept with it** (in the
   gateway profile: not a secret, but not editable from the page).

What this does not stop is the active attacker present at the very first request (Prometheus PR 700 §7.5): the 4-digit code can be ground
by someone relaying that one exchange. That is the SSH trust-on-first-use bargain, and the contract reserves a commit-reveal
fix for later.

### 3.3 Enforcing it, afterwards

- Every REST request and the WebSocket to a profile with a pin go over `https://` / `wss://` and **check the presented SPKI
  before a single byte of the request is sent** (so a token is never handed to the wrong key). In main: a fetch dispatcher
  and `ws` options that verify the peer certificate's SPKI in the TLS handshake and ignore names and dates.
- A pinned profile never falls back to plain HTTP.
- Unpinned profiles (this Mac's loopback; a Mac mini reached over Tailscale in `open` mode) keep working as today: plain
  HTTP, no TLS, no change.
- **No new plain connection to the home network** (the owner, 2026-10-11, for v0.4; `src/shared/plain-lan.ts`). A plain (http/ws)
  join, setup address, 6-digit setup code, Settings save or Test to a private LAN range (10/8, 172.16/12, 192.168/16, fc00::/7
  outside Tailscale's), link-local (169.254/16, fe80::/10) or a `.local` name is refused with: "Beacon only connects to computers
  on your home network over an encrypted connection. Update Prometheus on that computer and turn on home network, then connect
  to it again." This Mac (loopback) and Tailscale (100.64/10, fd7a:115c:a1e0::/48, `*.ts.net`) stay plain. It closes the three
  ways in that the reviews of beacon-desktop PR 244 and PR 246 found: a hidden `tls=1`, a plain-only record carrying a real computer's fp, and a
  typed address (now asked over TLS first, and never in plain on the home network). A plain home-network connection saved before
  keeps working, with one line in the connection popover and in Settings: "Not encrypted — update Prometheus and turn on home
  network."
- Everything Beacon sends to Prometheus already goes through main (the page never talks to it directly); the build checks
  that claim against every caller.

### 3.4 The card on a mismatch

Shown wherever the connection is refused (the app's "can't reach" banner place, and any onboarding screen):

- **Title:** This isn't the Prometheus you connected to
- **Body:** Something on your network answered as {name}, but it isn't the same computer, so Beacon sent it nothing. If
  Prometheus was reinstalled there, connect to it again.
- **Buttons:** [Connect again] (forgets this connection and goes to path B: a new approval, a new code, a new pin) · [Get help ↗]
- **No "continue anyway".** Copy details carries the pinned and presented SPKI hashes (technical words allowed there).

### 3.5 What pairing PR 5 (Prometheus PR 721) does, as checked

Prometheus PR 721 is merged (under Prometheus main 76134d6). What Beacon relies on, checked against its code and, where loopback allows, its
own certificate (`src/main/fixtures/tls_instance_721.json`, `scripts/record-tls-instance.mjs`):

- The certificate is self-signed and made over the instance key (P-256), named `localhost`, `<host>.local` and
  `prometheus-<fp8>.local`. Beacon ignores the names.
- TLS 1.2 or later, AEAD suites only. Node's client negotiated TLS 1.3 with AES-256-GCM against Prometheus PR 721's own server context.
- `home_network` serves TLS on the LAN bind on separate ports (REST 8006, WebSocket 8011; `web.tls_api_port`,
  `web.tls_ws_port`), and plain HTTP moves to 127.0.0.1. mDNS advertises the TLS REST port with `tls=1`.
- `GET /api/network`'s `tls.spki_sha256` is `instance_spki_sha256()`, and it equals Beacon's pin of the certificate. Hello's
  `fp` is its first 16 hex characters, and the pairing answer's `instance_public_key` is the same key (unpadded base64url SPKI).
- **Not checked live:** Prometheus PR 721's TLS listener only binds a home-network address (`lan_tls_plan` refuses loopback), so a live run
  listens on this Mac's LAN. Not done without the owner's OK.

## 4. Finding Prometheus on the home network (mDNS), and typing an address

**Mostly built (O2a, O2b, merged):** Beacon browses `_prometheus._tcp` with the system's `dns-sd -Z` as its own child (so the
macOS Local Network prompt names Beacon, and B1 explains it first), reads SRV and TXT, shows each sighting from its TXT record
(**not** confirmed with `GET /api/hello`: corrected 2026-10-11, the code never did), and offers "Connect by address" (B-adv) and the tailnet as fallbacks.

What changes for v0.4:
- **A `tls=1` advertisement** points at the TLS port. The computer does show (from its TXT), and joining it was "needs a
  newer Beacon"; with §3.2 the join goes over TLS. **Still to do:** confirm every Bonjour sighting with hello before showing it
  (Prometheus PR 700: a SIGKILLed daemon's record lingers until its TTL), over TLS when `tls=1`.
- **A typed address** is tried over TLS when plain HTTP is refused there and the answer says `tls: true`, with the same
  first-contact rules.
- **The wire check:** Prometheus PR 700's advertiser (zeroconf) has not been recorded by Beacon's `dns-sd -Z` reader. It cannot be
  advertised on loopback only (the contract excludes `lo`), so a recording **announces a test name on this Mac's real home
  network for a few seconds**. Approved once (§6).
- What Prometheus PR 700 already promises and Beacon already does: the host is `prometheus-<first 8 hex of fp>.local.`, IPv4 only, the
  six TXT keys, and "always confirm with hello" (a SIGKILLed daemon's record lingers until its TTL).
- Not advertised, by design: `this_mac` and `open` installs. A Mac mini on `0.0.0.0` reached over Tailscale is found by the
  tailnet source or a typed address, exactly as today.

## 5. Tests (red first, in draft PRs)

| PR | Smoke | What it pins |
|---|---|---|
| the switch | `smoke:network-setting` | reading all nine keys; every mode × applied row of §2.2; every warning and reason code (and an unknown code falls back to `message`); every `PUT` answer of §2.3; `can_change`/`bind_source`; the restart flow of §2.4 with fakes (route, 404 without it, the daemon back with the same `fp`, or not back in 60 s); a 403 shows nothing |
| TLS | `smoke:tls-pin` | against a **real** self-signed P-256 certificate on a local TLS server: the pin equals SHA-256(SPKI DER) computed independently (`openssl`); a right pin connects, a wrong one is refused **before the server sees a request** (no `Authorization` header ever reaches it), for fetch and for the WebSocket; names and dates are ignored; the first-contact checks of §3.2 (hello `fp` prefix, `instance_public_key`) each refuse on their own; a pinned profile never goes to `http://` |
| TLS | `smoke:discovery` additions | a `tls=1` sighting is confirmed over TLS; a typed address that answers `tls: true` too |
| (later) | `probe:onboarding-lan` | two Beacons and a real Prometheus with PR 5 on ephemeral ports: discover (`dns-sd -lo` where possible), join over TLS, approve, connect pinned; then a different key on the same address shows the mismatch card |

## 6. Decided (the owner, 2026-10-10)

1. **The Mac app will use the switch.** Prometheus is changing the app's launcher to read `web.bind` from the
   config instead of passing `--bind 127.0.0.1`, so an app install gets `can_change: true` and `PUT` works.
2. **The restart route is being built** in Prometheus to match §2.4 (`POST /api/restart`, operator only,
   `202 {"restarting": true}`). When its PR reports the shape, `RESTART_ROUTE` and the restart smoke are reconciled with it.
   (Reconciled 2026-10-11 against Prometheus PR 724 at 50b3a9e: the shape matched; its 503 `restart_unavailable`, and the 405 a
   Prometheus without the route gives, are §2.4's "restart it yourself".)
3. **The wire recording of Prometheus PR 700's mDNS is approved**, once: a test name announced on the home network for a few seconds.
4. **Pin the full SPKI SHA-256** (§3.1). Hello's `fp` is only a prefix check against it.
5. **The app's `Info.plist` gains `NSLocalNetworkUsageDescription` and `NSBonjourServices`** (`_prometheus._tcp`), on the
   Prometheus side, so the macOS prompts for an app-launched daemon name Prometheus.
