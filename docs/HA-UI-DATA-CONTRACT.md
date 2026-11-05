# Home Assistant in Beacon: data contract (phase 1)

Status: **draft for the owner's review, 2026-11-05.** Nothing in this file is built yet. It says what each phase 1
screen needs from Prometheus, and whether that exists today.

Phase 1 screens: the Home Assistant approval card, the "What it can touch" screen, the activity timeline.
Phases 2 and 3 (house-state card, alerts, automation proposals) are not covered; they wait for the server.

## 0. Ground rules

1. **Beacon talks to Prometheus only.** No Home Assistant URL is called, no Home Assistant token lives in Beacon.
   The Home Assistant MCP server is run by Prometheus, and Beacon cannot call MCP tools.
2. **Home is its own screen.** It is fed by new, operator-only `/api/home/*` routes on the daemon, read through the
   existing daemon bridge (`daemon.get` / `daemon.write`, which already allows any `/api/…` path:
   `isAllowedDaemonPath`). It is **not** a manifest integration. The generic control-surface contract (v1) has Beacon
   fetch an integration's own `baseUrl` with its own token, and its four view types (vitals, browser, controls, events)
   cannot draw tier chips, rooms or a revoke list. Home sits under Integrations next to Voice in the navigation only.
3. **The daemon decides, Beacon renders.** Tier, state wording, extents, results and reasons arrive as daemon-computed
   values and are shown verbatim. Beacon does not parse `arguments` to work out a tier, does not re-word an extent,
   and does not compute a result. This is the rule the existing approval card already follows (SPRINT-CONSENT).
4. **Unknown fails toward caution.** A missing, empty or unrecognised `tier` is rendered as **Sensitive**. A missing
   state is rendered as "state unknown", never as a guess.
5. **Owner only.** Every new route is operator-only (`web/route_access.py`'s `OPERATOR_ONLY`; a test there fails for a
   route in no class). The `home` field on an approval is left off for non-owner callers, so a scoped phone gets the
   generic card. Beacon also hides Home from a `limited` role (`@shared/device-role`).
6. **Read only, except two writes.** Beacon writes exactly two things: approve/deny (existing) and revoke a grant
   (existing), plus one new write, "Ask once" on or off for one device (§3.4). Beacon never turns an automation on,
   never lowers a Critical device's tier, never controls a device.
7. **Times are epoch seconds** on the wire, as everywhere else in the daemon API. Beacon converts.
8. **Loud failure.** A route that answers 404 means "this Prometheus has no Home support", 403 `operator_only` means
   "this device is not an owner", and each is said in words on the screen. Never a blank list.

## 1. What the server is (read from its scope)

Five MCP tools, reached by the daemon as `mcp__{server}__{tool}` (`{server}` is whatever name the owner registered it
under, so Beacon matches the **last segment** only):

| Tool | Kind | Used for |
|---|---|---|
| `ha_list(area?, domain?)` | read | devices with name, area, state, tier → the devices list |
| `ha_state(entity_id)` | read | current state → "current" on the approval card |
| `ha_control_ordinary(entity_id, action, params)` | gated control | Ordinary-tier approvals |
| `ha_control_sensitive(entity_ids, action, params)` | gated control | Sensitive-tier approvals, bulk |
| `ha_history(entity_id, hours≤24)` | read | not used by phase 1 screens |

Facts from the server scope that shape the UI, and that the UI scope did not say:

- **Tier is per call, not only per device.** A thermostat is Ordinary inside the safe range and Sensitive outside it;
  more than 3 devices, or a whole area, is Sensitive whatever the devices are; scripts, buttons and scenes are
  Sensitive. So an approval carries the tier **of that call**, and a device row carries the tier of the device's
  **usual classification**. Beacon computes neither.
- **Critical has no control tool.** A Critical device is read only. A control call on it is refused by the server with a
  sentence, so it appears in the timeline as refused, and no approval is ever raised for it.
- **Unclassified devices are Sensitive**, never Ordinary. Overrides come from a per-entity file the owner controls.
- **Unattended runs (cron, background, scheduled prompts) never call a sensitive tool**, and the server rate-limits
  control calls (20 a minute). Both show up as refused calls with a reason.
- **"Always" grants map onto the tool**, and so onto a tier. See open question Q1: this may make "Always allow" on one
  light cover every Ordinary device.
- **Every control call is logged** by the server (device, tier, action, requested state, real resulting state) to a log
  the agent cannot edit. That log is the source of the timeline. It does not record who asked or the approval outcome;
  Prometheus holds those.

## 2. What exists today (Prometheus, read-only survey)

No Home Assistant code exists in Prometheus (and none is wanted there). The generic parts that exist and that the
phase 1 screens reuse:

| Route | Methods | Caller | Used for |
|---|---|---|---|
| `/api/approvals` | GET | owner; a scoped device sees its own sessions' | the pending approval list (`ApprovalRequest`: `requestId`, `toolName`, `description`, `createdAt`, `extents`, `expiresAt?`, `arguments?`, `sessionId?`, `onceOnly?`) |
| `/api/approvals/{request_id}/approve` | POST | owner / scoped (own sessions) | approve, with a scope verb taken from `extents` (`once` always) |
| `/api/approvals/{request_id}/deny` | POST | same | deny |
| `/api/approvals/grants` | GET | **owner only** | remembered grants (`GrantDTO`: `id`, `tool`, `kind`, `value`, `scope`, `created_at`, `request_id`, `describes`) |
| `/api/approvals/grants/{grant_id}` | DELETE | **owner only** | revoke |
| `/api/devices` | GET | any | the caller's role (`owner` or `limited`) |
| WS `approval_pending` | frame | owner | the same serializer as `GET /api/approvals` |

`/api/tools/recent` (owner only) and `/api/activity/recent` exist but cannot feed the timeline: the first has tool name,
success and latency per call, the second is the signal bus; neither has a tier, a requested-versus-actual state, an
initiator or an approval outcome.

## 3. Screen by screen

Status key: **EXISTS** (route named) or **NEEDED** (does not exist; the screen is built against a fixture and the item is
on the list in §6).

### 3.1 Approval card (`ha_control_*`)

**When the Home card renders.** The approval carries a `home` object (below). The tool name is a hint only: the last
`__` segment is `ha_control_ordinary` or `ha_control_sensitive`. No `home` → the existing generic card, unchanged.
That is also what a scoped phone gets.

| Need | Status | Route / field |
|---|---|---|
| Pending approval, tool name, description, expiry, extents | EXISTS | `GET /api/approvals`, WS `approval_pending` |
| Approve once / deny | EXISTS | `POST /api/approvals/{id}/approve` (`{scope:"once"}`), `…/deny` |
| Structured devices for the call | **NEEDED** | new optional `home` on the approval payload (same serializer for REST, WS and push) |
| Result of the action, from the server's re-read | **NEEDED** | `GET /api/home/actions/{request_id}` |

`home` (all strings are the daemon's wording, shown verbatim):

```jsonc
"home": {
  "tier": "ordinary" | "sensitive" | "critical",   // tier of THIS call
  "tier_reason": "More than 3 devices" | null,      // daemon sentence; shown when present
  "devices": [{
    "id": "d_01",                      // opaque; the same id /api/home/devices uses
    "name": "Hall light",
    "room": "Hall" | null,
    "tier": "ordinary" | "sensitive" | "critical",  // this device's own tier
    "relaxed": false,                  // "Ask once" is on for this device
    "current": "off" | null,           // null = could not be read → "current state unknown"
    "requested": "on, 60%",            // what the call asks for
    "open_url": "https://…" | null
  }]
}
```

Rules the card follows:

- Header: device name and room, a tier badge (**word + glyph + colour**, never colour alone), then `current → requested`
  ("Hall light: off → on, 60%"). `current: null` reads "current state unknown".
- A bulk call (`devices.length > 1`) lists every device, collapsed past 5 with "and N more" (a button that expands).
- **Lasting options** (the "Always allow" family) are shown only when **all** of: `extents` is non-empty, tier is not
  `critical`, and (tier is `ordinary`, or tier is `sensitive` and every device is `relaxed`). The option text is the
  daemon's `extents` prose, verbatim, so what is granted is what the card says (see Q1). Otherwise Approve once / Deny
  only. `onceOnly` removes them as it does today.
- **Critical** (not expected in phase 1): Deny only, plus the sentence "Critical devices can't be controlled from
  Prometheus. This request should not have been made." The Approve control is not rendered.
- Keyboard: `A` approves once and `D` denies, as today (`@shared/approval-keys`). Every control is reachable by Tab.

`GET /api/home/actions/{request_id}` (owner only; 404 until the action has run; Beacon polls about once a second for up
to 20 s after Approve, then says the result is not yet known):

```jsonc
{
  "request_id": "r_01",
  "state": "pending" | "done",
  "results": [{
    "device_id": "d_01", "name": "Hall light",
    "result": "confirmed" | "unconfirmed" | "failed",
    "observed": "on, 60%" | null,       // the re-read state; null if it could not be read
    "message": "Hall light is on"       // the server's sentence, e.g. "…accepted it, but the light still reports off"
  }]
}
```

`confirmed` shows ✓ and the message. `unconfirmed` shows ⚠ and the message, in the warning style, visibly different from
success (different glyph, different word "Not confirmed", different colour). `failed` shows ✕ and the message.
A denied or expired approval shows its own line and never calls this route.

### 3.2 "What it can touch" (Integrations → Home)

| Need | Status | Route / field |
|---|---|---|
| Connection line | **NEEDED** | `GET /api/home/status` |
| Devices with room, state, tier | **NEEDED** | `GET /api/home/devices` (the daemon composes it from `ha_list`) |
| "Ask once" on/off for one device | **NEEDED** | `PUT /api/home/devices/{id}/ask-once` |
| "Always allowed" list | EXISTS (partly) | `GET /api/approvals/grants`, filtered by tool; **NEEDED** optional `home` on each grant row |
| Revoke | EXISTS | `DELETE /api/approvals/grants/{grant_id}` |
| Open in Home Assistant | **NEEDED** | `open_url` on status and on each device |

`GET /api/home/status`:

```jsonc
{
  "state": "connected" | "degraded" | "unreachable" | "auth_failed" | "not_configured",
  "device_count": 42 | null,
  "detail": "Connected to Home Assistant" | "Home Assistant did not answer (timed out after 8 s)" | …,
  "checked_at": 1790000000,
  "open_url": "https://…" | null
}
```

The line shown is `detail` verbatim, with the count appended when connected ("Connected to Home Assistant · 42 devices").
A 404 on this route reads "This Prometheus has no Home Assistant support." A 403 reads "Only an owner device can see this."

`GET /api/home/devices`:

```jsonc
{
  "updated_at": 1790000000,
  "devices": [{
    "id": "d_01", "name": "Hall light", "room": "Hall" | null, "kind": "Light",
    "state": "off" | null,
    "tier": "ordinary" | "sensitive" | "critical",
    "tier_source": "rule" | "override" | "unclassified",
    "relaxed": false,
    "open_url": "https://…" | null
  }]
}
```

Rules the screen follows:

- Grouped by room (null room → "No room"), a search box (name and room), a tier filter (All / Ordinary / Sensitive /
  Critical). Each row: name, state, tier chip (word + glyph), "Open in Home Assistant".
- **Critical:** a lock glyph, the words "Read only", no control of any kind. The tier cannot be changed here.
- **Unclassified** (`tier_source: "unclassified"`, or a tier Beacon does not recognise): shown Sensitive, with the note
  "Not classified yet, so treated as Sensitive."
- **Sensitive → "Ask once":** a per-device control, behind a confirmation dialog that names the device. It does
  **not** create a grant. It means: *the next approval for this device offers "Always allow"* (§3.1). A relaxed row says
  so ("Ask once on") and offers "Ask every time" to undo, with the same confirmation. Not offered on Critical. Dialog
  focus follows the repo's dialog rules (p4.2): focus moves in, is trapped, Escape cancels, focus returns.
- **Always allowed:** a section at the top of the screen (not a collapsed footer), because it is the main trust
  control. It lists every grant whose tool's last `__` segment is `ha_control_ordinary` or `ha_control_sensitive`. Each
  row shows `describes` verbatim, and the device name and room when the row carries `home`. Each row has **Revoke**
  (one click and a confirmation naming what is revoked). An empty list says "Nothing is always allowed."

`GET /api/approvals/grants` row, extended (NEEDED, optional, only on Home grants):

```jsonc
"home": { "tier": "ordinary", "devices": [{ "id": "d_01", "name": "Hall light", "room": "Hall" }] | "all_in_tier" }
```

`"all_in_tier"` means the grant covers every device of that tier (see Q1) and the row says so in words.

`PUT /api/home/devices/{id}/ask-once` body `{ "enabled": true | false }` → the updated device row. `409 {"error":
"critical_device"}` for a Critical device; the server must also refuse it, so Beacon's missing button is not the only
guard.

### 3.3 Activity timeline

| Need | Status | Route / field |
|---|---|---|
| Home actions, newest first, filterable | **NEEDED** | `GET /api/home/activity` |

`GET /api/home/activity?limit=50&before=<cursor>&device=<id>&room=<name>&tier=<tier>` (all filters optional, combined
with AND):

```jsonc
{
  "entries": [{
    "id": "a_01",
    "at": 1790000000,
    "device": { "id": "d_01", "name": "Hall light", "room": "Hall" | null },
    "tier": "ordinary" | "sensitive" | "critical",
    "tool": "ha_control_ordinary",
    "action": "turn_on",
    "initiator": { "kind": "chat" | "schedule" | "background_task" | "unknown", "label": "…" | null },
    "requested": "on, 60%",
    "resulting": "on, 60%" | null,          // the real re-read state; null if it could not be read
    "result": "confirmed" | "unconfirmed" | "failed" | "refused",
    "approval": "approved_once" | "approved_always" | "auto_allowed" | "denied" | "expired" | "not_asked",
    "refusal_reason": "…" | null,           // the server's sentence; present when result is "refused"
    "batch_id": "b_01" | null               // entries of one bulk call share it
  }],
  "next_before": "<cursor>" | null
}
```

Source: the server's control log, joined by Prometheus with who asked and the approval outcome (neither is in the
server log).

Rules: newest first; time, device, tier chip, "asked by" (your chat / a schedule / a background task / unknown),
requested, actual, approval outcome. A refused call is shown with the word "Refused" and `refusal_reason` verbatim.
`unconfirmed` is shown in the same warning style as the approval card. Filters: device, room, tier (device and room
options come from `/api/home/devices`). The screen has **no write controls at all**: no delete, no clear, no export.
Bulk entries sharing a `batch_id` are grouped under one line, collapsed past 5.

## 4. Display vocabulary (so the three screens agree)

| Tier | Word | Glyph | Meaning on screen |
|---|---|---|---|
| ordinary | Ordinary | ● (circle) | may be offered "Always allow" |
| sensitive | Sensitive | ▲ (triangle) | asks every time unless "Ask once" is on |
| critical | Critical | lock | read only |

Colours come from the existing tokens only (no new colours, no new fonts); the mapping is chosen in the first screen's PR
and reused. Contrast is checked by `npm run lint:contrast`.

## 5. Fixtures

Every screen is built against fixtures in one shared module (`src/shared/home-fixtures.ts`, imported by smokes and
probes, not by production renderer code). A fixture is exactly the JSON in §3. Made-up homes only: rooms like Living
room, Hall, Kitchen, Garage, Bedroom; devices like "Hall light", "Living room lamp", "Kitchen plug", "Movie scene",
"Garage door", "Front door lock". No real device names, addresses, hostnames, tokens or personal names, and the smoke
`lint:names` plus a read of `docs/` runs before any push.

Scenarios the fixtures cover: ordinary single device; sensitive single; relaxed sensitive; sensitive bulk of 8; critical
(Deny only); `current: null`; every `result` including `unconfirmed`; unclassified device; empty grants; a tier-wide grant;
every status `state`; the 404 and 403 shapes; a refused timeline entry with a reason.

## 6. NEEDED, for the daemon side (Prometheus and the server; not built by this work)

1. `home` object on the approval payload, REST, WS and push alike; omitted for non-owner callers. (§3.1)
2. `GET /api/home/actions/{request_id}`. (§3.1)
3. `GET /api/home/status`. (§3.2)
4. `GET /api/home/devices`; the server's `ha_list` must also supply `tier_source`, `relaxed` and `open_url`. (§3.2)
5. `PUT /api/home/devices/{id}/ask-once`, refused for Critical on the server. (§3.2)
6. Optional `home` on grant rows. (§3.2)
7. `GET /api/home/activity`, with the initiator and approval outcome joined onto the server's control log. (§3.3)
8. All of the above in `OPERATOR_ONLY`, with route-access tests.

## 7. Open questions for the owner

- **Q1. Grant extent.** The server scope says "Always" grants map onto tools, and there is one control tool per tier.
  If a grant is on the tool, "Always allow" for the Hall light would allow **every** Ordinary device. The UI scope
  assumes per-device grants. The card shows the daemon's `extents` text verbatim, so it will say whichever is true, but the
  "Always allowed" list and "Revoke" read very differently in the two cases. Which does the daemon do?
- **Q2. Who writes "Ask once".** The per-device override lives in a file the owner controls on the server side. Does
  `PUT …/ask-once` write that file (so Beacon changes tier policy), or does Prometheus keep its own relax list in front of
  it? Either way the server must enforce it.
- **Q3. Where the Home Assistant address comes from.** `open_url` is a link Beacon opens in the browser, never a call. It
  must come from the daemon. Is it acceptable that it is plain http on the home network?
- **Q4. Resolved approvals.** `GET /api/approvals` drops a request once it is answered. Beacon keeps the resolved card
  locally to show the result. If the approval is answered from another surface (a chat app) Beacon will not see the
  result card; acceptable?

## 8. Out of scope

Any change to Prometheus or the server; direct device control from Beacon; phases 2 and 3; iOS (later, separate).
