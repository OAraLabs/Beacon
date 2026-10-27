# One Beacon, several Prometheus

**Status (2026-10-26): spec, written before the code.** Nothing here is built yet. Each PR in §9 lands red-first: its first
commit is the test that fails on the main of the day, the PR body records that run, and nothing merges red.

Names in this spec ("Home mini", "Work box") are examples. On screen, a Prometheus is called by the name the person gives
it in Beacon.

## 1. What exists today

Beacon holds one Prometheus at a time.

- **The address** is a row in the `gateway_profiles` table of `beacon.db` in app-data (`src/main/cache/schema.ts`). The table
  could hold more rows, but every reader takes the single default one (`getDefaultGatewayProfile`, `src/main/cache/repo.ts`),
  and every way of connecting overwrites it.
- **The key** is one file, `api-credential.bin`, sealed with Electron `safeStorage` (`src/main/credentials.ts`). On macOS
  that is one Keychain item, Beacon's "Safe Storage" key, which encrypts the file.
- **The cache** is one `beacon.db`: conversations, messages, the outbox of unsent messages, and a key/value `settings` table
  that holds drafts, groups, projects, the last open conversation and more. None of it records which Prometheus it came from.
  (`sessions.gateway` is the daemon's channel name, not Beacon's profile.)

Three bugs follow from that, today, with one Prometheus at a time. They show whenever Beacon is pointed at a different
Prometheus (Settings → Connection on a plain profile, or Set up again and join another):

1. **Conversations mix.** `CacheService.listSessions` upserts the connected Prometheus's sessions and returns every cached
   row. Nothing prunes the old Prometheus's, so they stay in the sidebar beside the new one's.
2. **Queued messages go to the wrong Prometheus.** `CacheService.drainOutbox` sends every pending row to whatever the
   connection is now. A message written for A while A was down is sent to B.
3. **An approval notification acts on the current connection.** Its Approve/Deny buttons call `connection.resolveApproval`
   on whatever is connected when the button is pressed, not on the Prometheus that raised it.

And one hazard: the modules that talk to "the connected Prometheus" (network setting, pair pin, owner promotion, main model,
model setup) read the address and the key separately. With one key that is harmless. With two it is a window where B's
address is paired with A's key.

## 2. Rules

1. **A Prometheus is identified by its `instance_id`, and its node key is pinned.** `instance_id` is the UUID in its vault
   marker, which travels with the vault when it moves machines. The node key is its Ed25519 node keypair (`node_pub`), made
   on that machine and never copied. Beacon pins `node_pub` when it pairs, next to the TLS pin it already keeps for a
   home-network Prometheus.
   - **Until a Prometheus can prove its node key** (§8.1), and in PR 1, Beacon tells instances apart by hello's `fp`: the
     first 16 hex of the SHA-256 of the instance key behind its TLS certificate. A mix-up guard, not a trust anchor.
   - A new address with the same identity is the same Prometheus. A new identity at a known address is a different one.
2. **A key is only ever sent to the Prometheus that minted it.** One accessor returns `{endpoint, key, pin}` together;
   nothing reads an address and a key separately. The request helper refuses to send a key to any origin but its own,
   and never forwards `Authorization` across origins on a redirect.
3. **No key before proof.** On every connect, before its key goes out on REST or the socket, Beacon sends a fresh nonce and
   the Prometheus signs it with its node key (§8). A signature from another key means nothing is sent, and Beacon warns the
   way SSH warns about a changed host key. The same `instance_id` with a new node key (the Prometheus moved to new hardware)
   is held until the person confirms it. A Prometheus pinned with a node key that no longer answers the challenge is a
   mismatch, never a quiet downgrade.
4. **One folder per Prometheus, nothing shared.** Mixing then can't happen through a forgotten `WHERE`, because there is
   nothing to join across. (Rejected: one cache with a `daemon_id` column on every table. Every query would need the
   filter, and a missing filter is an absence no test reliably finds.)
5. **Beacon is a client, never a router.** It shows each Prometheus and controls each one, over that Prometheus's own link
   and key. It never carries a task, a message, a file or an approval from one Prometheus to another, and never acts as
   the go-between for work that spans them, not even when both are on screen at once. Work between instances goes daemon
   to daemon (a future agent-to-agent adapter in Prometheus), and Beacon at most shows it, read from each Prometheus. This
   keeps every key with its own Prometheus (rule 2), and keeps Beacon out of the path a task depends on: a laptop that
   closes its lid must not strand work between two always-on instances.

## 3. Storage

```
userData/
  app.db                       this Beacon's own: settings classified Beacon-wide (theme, window, panels, notification prefs,
                               close mode, ...), the saved connections, and daemon_folders, the list of folders
                               (id, fp, last address, last active). No conversation, message or outbox table.
  daemons/<id>/cache.db        one Prometheus's sessions, messages, outbox, per-conversation settings (drafts, groups,
                               projects, last session, panes) and its diagnostic tables
  daemons/<id>/credential.bin  that Prometheus's key, safeStorage-sealed (PR 2)
  backup-pre-daemons/          beacon.db as it was before the move, and a MANIFEST (size, SHA-256)
```

- **A folder's name is only an id.** A folder made once its Prometheus's `fp` is known is named by the `fp`. The cache that
  predates this is `legacy-1`. A plain connection opened before hello answers gets `new-<8 hex>`. Each folder's `fp` is
  bound once, in `daemon_folders`, and never changes; PR 3 adds the name in Beacon and the endpoints to that list.

- **Keys:** one sealed file per Prometheus, the way `integration-<id>.bin` already works. Each is separate, deleted with its
  folder, and never read for another Prometheus. All are sealed by Beacon's one safeStorage Keychain item, as today. (A
  native Keychain item per Prometheus was rejected for desktop: a new native dependency with different backends per OS.)
- **Every settings key is classified** Beacon-wide or per-Prometheus in one table in `src/shared/daemon-profiles.ts`. A smoke
  walks every exported `*_KEY` / `*_PREFIX` constant, so a key added later can't skip being classified.

### 3.1 Migration (once, crash-safe)

0. **Backup first.** Checkpoint the WAL, then copy `beacon.db` into `userData/backup-pre-daemons/` with a one-line `MANIFEST`
   (size and SHA-256). If the copy fails, nothing moves. The backup is never written again; a later release deletes it once
   that release has proven it reads the new layout.
1. Copy the Beacon-wide settings and the saved connection from `beacon.db` into `app.db`, and record the folder `legacy-1`
   at the saved address. A pinned connection's `fp` is known at once (it is the first 16 hex of the pin); an unpinned one's
   is bound when hello first answers.
2. Checkpoint the WAL and move `beacon.db` to `daemons/legacy-1/cache.db`.
3. (PR 2) Move `api-credential.bin` and the per-Prometheus credential facts (credential kind, remembered device role).
4. Write the `daemons:layout` setting in `app.db` last, as the marker. Every step is idempotent, and until the move
   `beacon.db` stays the truth, so a crash mid-way finishes on the next launch.

**Who answers.** A pinned connection's folder follows from its pin. A plain connection opens the folder last used at its
address, held: nothing it says is written there and nothing queued there is sent to it until hello (no key) has named the
Prometheus. The same one (or a folder no `fp` was bound to yet): released. Another one: its own folder opens and the app
remounts.

If the disk refuses, the old layout keeps working with one Prometheus and the failure is recorded. The key is never lost.

## 4. Switching

- **One active Prometheus per Beacon process**, as today: one `ConnectionManager`, one open `cache.db`.
- **A switch** stops the connection, closes the cache, opens the other folder, brings up its connection, and remounts the
  renderer (the existing `connGen` remount), Mission Control included.
- **Each outbox drains only to its own Prometheus**, because it lives in that Prometheus's folder.
- **Every IPC event and reply carries the instance generation**; the renderer drops a stale one. A REST reply that lands
  after a switch is written to its own folder or dropped, never to the new one.
- Drafts, groups, projects, the last open conversation and split panes come back when you switch back.
- Pop-out conversation windows belong to their Prometheus and close on a switch. The terminal and browser panes belong to
  this computer and stay.
- Settings split by owner. Per Prometheus: Connection, Other computers, Devices, Main model, Make this Beacon an owner,
  Notifications. Beacon-wide: Theme, Launch at login, Window, Updates.

## 5. The list in the sidebar

- **Hidden while there is one Prometheus.** A person with one sees nothing new. "Add a Prometheus…" lives in Settings →
  Your Prometheus.
- **With two or more**, a "Your Prometheus" section at the top of the sidebar has one row per Prometheus:
  - a **status dot**: green connected, amber connecting, grey can't be reached, red when its key is refused or something
    else answers. The state is also in the row's words, never in colour alone;
  - the **name in Beacon**;
  - **which AI it's on**: `provider` and `model` from `GET /api/status`, in the words `@shared/main-model` already uses
    ("Anthropic (Claude)", "your own hardware"). `GET /api/model` can't be used: it is operator-only, and an approved device
    may read `/api/status`;
  - clicking a row switches; a footer row says "Add a Prometheus…".
- With two or more, the name also appears in the window title ("Home mini — Beacon"), the composer placeholder, the
  unreachable banner ("Can't reach Home mini."), and every notification.
- Row states: Connected / Connecting… / Can't reach it since 3:12 pm / No longer accepts this Beacon / A different
  Prometheus answered / Not encrypted.

## 6. Adding, renaming, removing

**Add** reuses the onboarding flow in an add mode, through approve-to-pair, so each Prometheus mints its own device key.

- The current Prometheus stays connected while you add. Saving writes a new folder; it never overwrites the active one.
- Installing on this Mac is offered only when no saved Prometheus is this Mac's (the port is fixed, so there can be one).
- Learn `device_id` at join (the approve poll, or the owner code). `POST /api/pair/local` doesn't return one yet, so ask
  `GET /api/devices` for the row with `is_self: true`.
- **The same Prometheus twice** (its `fp` is already in the list): "You already have this Prometheus, as Home mini."
  [Switch to Home mini]. Nothing is requested.
- **An enrolment link or QR code always adds**, never replaces, and names the Prometheus before anything is saved.
- The default name is hello's `name`; if it is taken, " (2)" is added.

**Rename** is local: "Name in Beacon. Only this Beacon uses this name. It doesn't change anything on that computer."

**Remove** (Settings → Your Prometheus → Remove…):

1. Revoke this device's key on that Prometheus (`DELETE /api/devices/{own id}`; a device may revoke itself, and its sockets
   close at once).
2. Only then delete the folder. A 401 means it was already revoked: just forget it.
3. If Prometheus refuses because this is its only owner, offer only "Remove from this computer"; the key stays valid there
   and the copy says so. The refusal's status and code are read from the real route and recorded as a fixture, never assumed.
4. If it can't be reached, ask. Never delete silently.
5. Removing the active one switches to the most recently used other. Removing the last one opens Welcome.

**Edit address** asks who answers at the new address before anything is saved, moved or sent, with no key: the identity
challenge when that Prometheus has a pinned node key, and hello's `fp`.
- The same Prometheus (its pinned key signs, or the same `fp`), or the same one moved to new hardware: saved, its folder,
  key and record moved together.
- Another Prometheus: nothing is saved and no key is sent. "That's a different Prometheus. Add it as a new one?" [Add it]
  [Cancel]. Add it keeps it as a new one, in its own folder, with only a key typed for it; the one Beacon was on stays kept.
- One Beacon already keeps: "You already have this Prometheus, as Work box." [Switch to Work box].
- Nothing to tell them apart by (no pin, no `fp`, no answer): saved as before, and the connection's own hold sorts it out.

**Set up again** retires once Add and Remove exist.

## 7. Approvals and notifications from every Prometheus

- **Prometheus you're not on are checked every 60 seconds**, each with its own key: `GET /api/status` (state, name, AI),
  `GET /api/approvals`, and `GET /api/events/recent` for tasks finished or failed. An approved device may read all three.
  An unreachable one backs off to 5 minutes and is never announced as unreachable. No second live socket in v1.
- **One approvals inbox.** Main owns an `ApprovalInbox` keyed by `(instance, requestId)`. The active Prometheus feeds it from
  its socket and poll, the others from the 60-second check. "Approvals (n)" in the sidebar opens cards grouped under each
  Prometheus's name; the in-conversation approval card reads the same store.
- **Approve and Deny carry their instance.** Main resolves them through that Prometheus's own `{endpoint, key}`, never the
  active connection. If that Prometheus was removed, nothing is sent and the card says "Work box was removed from Beacon."
- **New-device requests** from a Prometheus you're not on show in the inbox, labelled, with only [Switch to Work box to
  answer]. The four digits are typed only while that Prometheus is the active one.
- **Notifications** are titled with the name ("Work box: approval needed", "Work box: task finished"). Clicking one switches
  to that Prometheus and opens the conversation. The dock badge is the sum across all of them; the tray lists each with its
  count.
- Running tasks keep running on their Prometheus regardless; switching back catches the conversation up through the rowid
  cursor, as after an offline spell today.

## 8. Security

- A key is sent only to its own origin (§2 rule 2), checked in the request helper, with a test built to send A's key to B on
  today's code so the check is seen to fail.
- **The identity challenge (PR 2).** Unauthenticated, like hello: `POST /api/identity/challenge` with a 32-byte nonce.
  - The answer carries `instance_id`, `node_pub`, the TLS SPKI digest the listener serves (empty on a plain one), a
    timestamp, and an Ed25519 signature over all of them under a domain-separation line.
  - Beacon checks the signature, the pinned `node_pub` and `instance_id`, the timestamp, and on TLS the SPKI against the
    certificate it saw. Only then does the key go out. It asks again before every redial, so a Prometheus that takes over the address while
    Beacon is connected gets nothing either. While no answer comes at all, Beacon keeps asking at the socket's pace and sends
    nothing meanwhile. Until Prometheus serves the route (PD-2), the first good answer is pinned (trust on first use); pairing
    hands the key over with the owner's confirmation once PD-3 lands.
  - What each outcome shows:

    | The challenge says | Beacon |
    |---|---|
    | the pinned key, the pinned `instance_id` | connects |
    | another key, another `instance_id` | sends nothing: "Something else is answering at {address}." The key is never sent. A node key another folder is pinned to is that Prometheus, at a new address: its own folder and key are used instead |
    | another key, the same `instance_id` | sends nothing until confirmed: "Work box's computer key has changed. If Work box moved to a new computer, confirm it; if not, don't connect." [It moved — trust the new key] [Change connection…]; while the card shows, nothing is sent |
    | nothing (404), for a Prometheus pinned with a node key | sends nothing; treated as the second row |
    | nothing (404), for one paired before the challenge existed | connects on the TLS pin and `fp` as in PR 1, and says it can't prove who it is |

  - **What it does not do on plain HTTP:** prove that nobody is in between. A relay could pass the challenge through. Plain
    connections are this Mac's loopback and Tailscale (already encrypted), and the home network is TLS-only, where the SPKI
    binding stops a relay. The challenge's job is that a different Prometheus, or an impostor without the real one behind it,
    never receives a key.
- **Signed records (later PR).** Prometheus signs approval outcomes and actions into a hash chain with its node key. Beacon
  keeps each instance's last-seen chain head and shows a "Record" view per Prometheus, flagging a signature that doesn't
  match or history that changed since Beacon last saw it. The key lives on the same machine as the log, so Beacon's saved
  heads, as a witness, are what make a rewrite evident.
- `Authorization` is never forwarded on a cross-origin redirect.
- TLS profiles keep their per-Prometheus pin. Plain profiles check `fp` on connect and on every status poll.
- **A lost device is revoked per Prometheus.** Each Prometheus minted its own key for this Beacon, so its owner revokes the
  device in Devices there, and that touches no other Prometheus. The device's name is the same on every Prometheus, so an
  owner can recognise it. Beacon's own Remove revokes its key on that Prometheus first (§6).
- Diagnostic tables live in each Prometheus's folder, so a support export from one holds nothing from another.

### 8.1 What Prometheus is asked for

None of these block Beacon; each has a fallback.

- **`device_id` from `POST /api/pair/local`**, as the other mint routes return it. Fallback: `GET /api/devices` `is_self`.
- **The last owner can't revoke itself; Prometheus refuses.** Fallback: any refusal reads "didn't confirm".
- **`name` and `fp` on `GET /api/status`**, as siblings of `instance_id` and `node_pub`, from the same functions hello
  uses. Then one authenticated read gives name, `fp`, AI and state, tied to the key that read it. Fallback: hello.
- **The identity challenge** (§8), with the node-key rules in Prometheus's FOUNDATION Part 3 amended to allow it: the node key
  then signs challenges and audit records. It still encrypts nothing, and never stands in for a device's own token.
  Fallback: the TLS pin and `fp`, said on screen.
- **`instance_id` and `node_pub` in every pairing answer**, with `node_pub` mixed into the 4-digit match code, so the pin
  Beacon keeps was confirmed on the owner's screen.
- **Signed approvals and action records** in a hash chain, readable at `GET /api/audit` (a device sees its own).

## 9. Out of v1

- Tasks that span or move between Prometheus instances. Not in v1, and never through Beacon (§2 rule 5): when it comes, it
  goes daemon to daemon.
- Shared state across instances.
- One merged conversation list, or search across instances.
- Moving or forking a conversation to another Prometheus.
- A live socket to every Prometheus (the others are polled; a quiet socket is a later option if 60 s is too slow).
- Sharing integrations or Loop projects between instances.
- Syncing the list between your devices. Other Beacon clients implement these rules from this spec, not from this code, so
  `src/shared/daemon-profiles.ts` stays pure and small.

## 10. PRs, in order

| # | PR | Red first |
|---|---|---|
| 1 | **Bug fix.** `app.db` + a folder per Prometheus, told apart by `fp`; backup and migration; the hold until hello names a plain connection's Prometheus; classify settings keys; the notification action carries its Prometheus. Cache only; the key stays where it is | `smoke:daemon-isolation`: A's conversations on B, A's outbox sent to B, A's notification action reaching B |
| 2 | One sealed key per folder; the single `{endpoint, key, pin}` accessor; the origin guard; no `Authorization` on a cross-origin redirect; **the identity challenge before any key goes out**: `node_pub` and `instance_id` pinned per Prometheus, the host-key-changed warning, the moved-to-new-hardware confirm, no downgrade; folders keyed by `instance_id` | `smoke:credential-origin` + `smoke:identity-challenge` (a fake Prometheus with a real Ed25519 key: the right key sends the token; a wrong key, a replayed nonce, a stale timestamp, a wrong SPKI or a 404 after pinning sends no `Authorization` at all; the same `instance_id` with a new key waits for the confirm) |
| 3 | The list in main: add without forgetting, switch, the status check, the `fp` check, Edit address, late replies dropped | `smoke:daemon-profiles` + a reply landing after a switch |
| 4 | The sidebar list and the name everywhere, with two or more | the row's states + an app probe |
| 5 | Add a Prometheus through approve-to-pair | A stays connected; A's key file is unchanged |
| 6 | The approvals inbox, named notifications routed by instance, badge sum, tray | a resolve for B never reaches A |
| 7 | Rename; Remove with self-revoke and its cases | Prometheus shows the key revoked |
| 8 | Two real Prometheus end to end, a mutation sweep, a check by hand; Set up again retires | — |
| 9 | The Record view: signed approvals and actions per Prometheus, verified against the chain heads Beacon has seen | a flipped byte, a dropped record or a rewritten chain is flagged |

PR 1 waits for nothing. PRs 2 onward land after the local-first onboarding work, which changes the same credential code.
