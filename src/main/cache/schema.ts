/**
 * Local SQLite cache schema (spec §3.3). READ-THROUGH CACHE + WRITE-BEHIND OUTBOX, never a
 * second source of truth — the daemon owns the truth and we reconcile to it.
 *
 * Step 4 re-key (on the daemon's durable-id contract):
 *   - The daemon's message_id is now a durable, monotonic, restart-stable rowid (INT). It is
 *     BOTH the identity and the incremental cursor. `messages.row_id` holds it; NULL means an
 *     optimistic row not yet confirmed.
 *   - The cache key `messages.id` is `str(row_id)` once confirmed, or `local-<uuid>` while
 *     optimistic. PK (session_id, id). On the WS echo we re-key local-<uuid> -> str(row_id)
 *     DETERMINISTICALLY by client_msg_id — no content matching (retired; it corrupted
 *     identical-content sends).
 *   - `ordinal` (daemon turn_index) is display-only and EXPLICITLY NON-UNIQUE. Never key/sort
 *     on it; order by row_id.
 *   - Reconcile is a rowid cursor: GET ...?since=<max cached row_id> (messages_after_id), not a
 *     full GET. sessions.watermark = max row_id.
 */
export const SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  gateway       TEXT,
  title         TEXT,
  last_active   INTEGER,
  message_count INTEGER DEFAULT 0,
  watermark     INTEGER DEFAULT 0,
  -- Daemon-owned (Prometheus#351). Cached so a pin survives an offline start, the same way a
  -- title does; the daemon remains the writer of record.
  pinned        INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  id            TEXT NOT NULL,        -- canonical key: str(row_id) (confirmed) or 'local-<uuid>' (optimistic)
  row_id        INTEGER,             -- durable daemon rowid; NULL until confirmed. Sort + cursor key.
  ordinal       INTEGER,             -- daemon turn_index — DISPLAY ONLY, non-unique. Never key/sort on it.
  role          TEXT NOT NULL,
  content       TEXT,
  content_json  TEXT,                -- daemon content_json (lossless structured blocks); NULL = legacy/optimistic
  provenance    TEXT,                -- WHO originated the turn (Prometheus P9.3): 'user' or machinery; NULL = legacy/optimistic
  is_trusted    INTEGER,             -- 0/1; NULL = legacy/optimistic, read as trusted (the daemon default)
  tool_calls    TEXT,
  created_at    INTEGER NOT NULL,    -- display timestamp (ms)
  client_msg_id TEXT,                -- links an optimistic row to its WS echo (deterministic re-key)
  PRIMARY KEY (session_id, id)
);
CREATE INDEX IF NOT EXISTS idx_messages_rowid ON messages(session_id, row_id);
CREATE INDEX IF NOT EXISTS idx_messages_client ON messages(session_id, client_msg_id);

CREATE TABLE IF NOT EXISTS outbox (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  payload     TEXT NOT NULL,
  status      TEXT NOT NULL,
  attempts    INTEGER DEFAULT 0,
  created_at  INTEGER NOT NULL,
  message_id  TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status);

CREATE TABLE IF NOT EXISTS gateway_profiles (
  name        TEXT PRIMARY KEY,
  api_base    TEXT NOT NULL,
  ws_url      TEXT NOT NULL,
  is_default  INTEGER DEFAULT 0,
  pin         TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Socket lifecycle (diagnostic, bounded). NOT part of the read-through cache:
-- this is Beacon's own record of what happened to its WS link, kept here rather
-- than in a log file because main-process stdout is discarded in a packaged
-- launch and a console that is gone is not evidence. Pruned to
-- SOCKET_LOG_MAX_ROWS on every insert — see shared/socket-log.ts.
CREATE TABLE IF NOT EXISTS socket_events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,   -- epoch ms; the reason the table is worth having
  kind    TEXT    NOT NULL,
  attempt INTEGER,
  detail  TEXT
);
CREATE INDEX IF NOT EXISTS idx_socket_events_at ON socket_events(at);

-- Resolve-path breadcrumbs (DEV-GATED, diagnostic, bounded). Instrumentation for
-- findings 2 and 5 — "the click and the daemon disagree" — not a product surface.
-- mono is monotonic WITHIN the process named by proc; the two processes have
-- separate origins, so only at aligns across the boundary. Dropped entirely in a
-- packaged build (see registerIpcHandlers).
CREATE TABLE IF NOT EXISTS ui_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         INTEGER NOT NULL,   -- wall clock, cross-process comparable
  mono       REAL    NOT NULL,   -- monotonic, per-process origin
  proc       TEXT    NOT NULL,
  point      TEXT    NOT NULL,
  request_id TEXT,
  scope      TEXT,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_ui_events_at ON ui_events(at);

-- What the reply watchdog DECIDED. ALWAYS-ON — deliberately NOT dev-gated like
-- ui_events: the message this records tells an operator to go check the daemon,
-- and it fires in packaged builds, which is exactly when nobody can read a
-- console. Bounded to WATCHDOG_LOG_MAX_ROWS on every insert.
--
-- THIS IS NOT A FRAME LOG AND MUST NOT BECOME ONE. Do not add a row per frame
-- "while we are here": the watchdog asks one question, rarely, and a per-frame
-- table costs hundreds of rows a minute to answer it. What earns its place is
-- the decision plus the RAW INPUTS behind it, so a reader can recompute the
-- verdict rather than trust it. Re-arms are coalesced into a count for the same
-- reason — a 5-minute turn re-arms ~100 times and writing those turns a
-- diagnostic into a disk-fill.
CREATE TABLE IF NOT EXISTS watchdog_events (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  at                  INTEGER NOT NULL,   -- epoch ms; places the row in a window
  kind                TEXT    NOT NULL,   -- armed | stood-down | fired
  session_id          TEXT    NOT NULL,
  reason              TEXT,               -- stood-down: done | command_done | unmount
  rearms              INTEGER,            -- coalesced re-arms in this window
  armed_for_ms        INTEGER,
  cause               TEXT,               -- fired: the branch the message took
  socket_dropped_at   INTEGER,            -- fired: RAW INPUT
  daemon_last_seen_at INTEGER,            -- fired: RAW INPUT (the useRef that was unrecordable)
  turn_in_flight      INTEGER             -- fired: RAW INPUT (0/1)
);
CREATE INDEX IF NOT EXISTS idx_watchdog_events_at ON watchdog_events(at);
`

/**
 * app.db (docs/MULTI-PROMETHEUS.md §3): what belongs to this Beacon whichever Prometheus is open. Settings classified 'beacon'
 * by @shared/daemon-profiles, the saved connection, and the list of Prometheus folders. NO conversation, message or outbox
 * table: those live in each Prometheus's own daemons/<id>/cache.db (SCHEMA above), so there is nothing here to mix.
 */
export const APP_SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS gateway_profiles (
  name        TEXT PRIMARY KEY,
  api_base    TEXT NOT NULL,
  ws_url      TEXT NOT NULL,
  is_default  INTEGER DEFAULT 0,
  pin         TEXT
);

-- One row per Prometheus folder under daemons/. The folder's name is only an id: a cache that predates fp is 'legacy-1', and
-- a plain connection opened before hello answers gets a fresh id. fp is bound once it is known and never changes after.
CREATE TABLE IF NOT EXISTS daemon_folders (
  id           TEXT PRIMARY KEY,
  fp           TEXT UNIQUE,
  api_base     TEXT,
  last_active  INTEGER NOT NULL
);
`
