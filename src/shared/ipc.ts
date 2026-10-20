// Single source of truth for the allowlisted IPC surface (spec §3.5), shared by the
// main process, the preload bridge, and the renderer. No Node/Electron imports here so
// the renderer can consume the types without pulling in the main-process world.

import type { GatewayEvent, EventRow } from './gateway-events'
import type { ExportFormat } from './session-export'
import type { ProjectHint } from './session-projects'
import type { LoopProject, LoopFileRead, LoopFileWrite, LoopPickedFile } from './loop'

import type { ArtifactPreview } from './artifacts'
import type { BrowserBridge } from './browser-pane'

export const IPC = {
  // renderer -> main (invoke / handle)
  CONNECTION_STATUS: 'connection:status',
  CHAT_SEND: 'chat:send',
  CHAT_UPLOAD: 'chat:upload', // renderer -> main: upload one file as a daemon chat_upload WS frame
  CHAT_INTERRUPT: 'chat:interrupt', // renderer -> main: stop the running turn (daemon POST /api/chat/interrupt)
  COMPUTER_TASK_STOP: 'computer:task-stop', // renderer -> main: stop ONE desktop task (WS computer_task_stop; REST when the socket is down)
  // The desktop door (v1.1 PR 7): start a task and pick an app. All five are person-only on the
  // daemon and answer a structured refusal, so each returns a DoorOutcome rather than throwing.
  COMPUTER_APPS: 'computer:apps',
  COMPUTER_BINDING_GET: 'computer:binding-get',
  COMPUTER_BINDING_SET: 'computer:binding-set',
  COMPUTER_BINDING_CLEAR: 'computer:binding-clear',
  COMPUTER_TASK_START: 'computer:task-start',
  SESSIONS_LIST: 'sessions:list',
  SESSIONS_PROJECT_HINTS: 'sessions:project-hints', // renderer -> main: sessionId -> the project its tool calls point at
  HISTORY_FETCH: 'history:fetch',
  HISTORY_BACKFILL: 'history:backfill', // renderer -> main: re-pull a session from rowid 0 (jump-to-search-hit)
  OUTBOX_STATUS: 'outbox:status',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  GATEWAY_PROFILES: 'gateway:profiles',
  SETUP_STATUS: 'setup:status', // renderer -> main: is this first-run? + current address
  SETUP_SAVE: 'setup:save', // renderer -> main: save gateway address + token, then connect
  SETUP_PAIR: 'setup:pair', // renderer -> main: exchange a 6-digit code for the API token (Phase 1)
  SETUP_PAIR_POLL: 'setup:pairPoll', // renderer -> main: after pairing, is the REAL daemon up yet?
  SETUP_PROBE: 'setup:probe', // renderer -> main: GET /api/setup/status on a TYPED address (no save) — wizard Connect diagnosis (Phase 2)
  DISCOVERY_START: 'discovery:start', // renderer -> main: start a search for Prometheus ({quiet}); updates stream back on DISCOVERY_UPDATE
  DISCOVERY_STOP: 'discovery:stop', // renderer -> main: end the search (and the lookup process it owns)
  DISCOVERY_PROBE: 'discovery:probe', // renderer -> main: ask ONE typed host:port who it is (GET /api/hello, no credential)
  DISCOVERY_UPDATE: 'discovery:update', // main -> renderer: the search's current results
  PATHA_CHECK: 'patha:check', // renderer -> main: can Prometheus be set up on THIS Mac? (facts + verdict; downloads nothing)
  JOIN_BEGIN: 'join:begin', // renderer -> main: ask the chosen computer to let this Mac join (names go in; the key, the poll secret and the token never come out)
  JOIN_POLL: 'join:poll', // renderer -> main: one look at the wait for approval (a token that arrived is kept by main and never returned)
  PAIRING_REQUESTS: 'pairing:requests', // main -> renderer: who is waiting for this Prometheus's owner to say yes (an owner's Beacon only)
  PAIRING_LIST: 'pairing:list', // renderer -> main: the same, once
  PAIRING_APPROVE: 'pairing:approve', // renderer -> main: approve one, with the four digits the owner typed from the new device
  PAIRING_DENY: 'pairing:deny', // renderer -> main: say no
  JOIN_CANCEL: 'join:cancel', // renderer -> main: withdraw the request
  PATHA_OPEN_STORAGE: 'patha:open-storage', // renderer -> main: open System Settings at Storage (macOS only; main owns the URL)
  PATHA_INSTALL_START: 'patha:install-start', // renderer -> main: set Prometheus up on this Mac (A-inst), or the run already under way; updates on PATHA_INSTALL_UPDATE
  PATHA_INSTALL_CANCEL: 'patha:install-cancel', // renderer -> main: stop (before the app is in Applications: and delete what was downloaded)
  PATHA_INSTALL_UPDATE: 'patha:install-update', // main -> renderer: where setting Prometheus up stands (no secret and no token, ever)
  PATHA_OPEN_LOGIN_ITEMS: 'patha:open-login-items', // renderer -> main: open System Settings at Login Items (macOS only; main owns the URL)
  DISCOVERY_OPEN_SETTINGS: 'discovery:open-settings', // renderer -> main: open macOS's Local Network privacy pane (macOS only; main owns the URL)
  SETUP_FORGET: 'setup:forget', // renderer -> main: forget the saved address + stored credential, drop the connection (Start over / Set up again)
  SESSION_ACTIVE: 'session:active', // renderer -> main: which session is open (for notify routing)
  SESSION_VISIBLE: 'session:visible', // renderer -> main: every session on screen in the main window (split panes)
  APPROVALS_LIST: 'approvals:list', // renderer -> main: poll the daemon's GLOBAL pending-approval queue
  APPROVAL_RESOLVE: 'approval:resolve', // renderer -> main: approve/deny one pending action (binary)
  SESSION_EXPORT: 'session:export', // renderer -> main: write a conversation to ~/Downloads (md|json)
  SESSION_FORGET: 'session:forget', // renderer -> main: forget a session (daemon remove + local cache purge)
  APPROVALS_COUNT: 'approvals:count', // renderer -> main (send): pending-approval count → tray badge/menu
  // renderer -> main (send): repaint the OS-drawn window buttons (Window Controls Overlay) to match
  // the active skin. Linux/Windows only — main ignores it elsewhere, see window-chrome.ts.
  TITLEBAR_OVERLAY: 'window:titlebar-overlay',
  // renderer -> main (send): reload the SENDER's own page (the error boundary's "Reload Beacon").
  // Not `location.reload()`: in a built app that raises will-navigate to the shell's file:// URL,
  // which the shell's navigation guard refuses, so the reload never happens.
  WINDOW_RELOAD: 'window:reload',
  APPROVALS_NEW: 'approvals:new', // renderer -> main (send): NEW pending requests (from poll) → main decides notification. Main is the ONE notification authority (push frames feed the same path) — one dedupe set, one request gets one notification.
  CAPTURE_OPEN_MAIN: 'capture:open-main', // renderer -> main (send): quick-capture → open main on a session
  EVENTS_RECENT: 'events:recent', // renderer -> main: GET /api/events/recent (activity-feed backfill)
  ARTIFACTS_LIST: 'artifacts:list', // renderer -> main: GET /api/artifacts (outbox manifest — chip matching)
  ARTIFACT_DOWNLOAD: 'artifacts:download', // renderer -> main: fetch by content id, save to ~/Downloads, reveal
  ARTIFACT_READ: 'artifacts:read', // renderer -> main: fetch by content id and classify for the preview pane
  DAEMON_GET: 'daemon:get', // renderer -> main: scoped generic GET of a read-only /api/ path (panels)
  DAEMON_WRITE: 'daemon:write', // renderer -> main: scoped generic POST/PUT/DELETE of an /api/ path (writes)
  // Loop Manager (feat/loop-manager): registry + CONFINED local project files. Distinct from DAEMON_*
  // (those hit the sandboxed daemon REST) — these are main-owned local-fs, not the daemon.
  LOOP_PROJECTS_GET: 'loop:projects:get', // renderer -> main: list the registered local projects
  LOOP_PROJECTS_SET: 'loop:projects:set', // renderer -> main: persist the registry (returns sanitized)
  LOOP_FILE_READ: 'loop:file:read', // renderer -> main: read TASKS.md/LOOP.md/PROGRESS.md under a root
  LOOP_FILE_WRITE: 'loop:file:write', // renderer -> main: write a confined project file
  LOOP_FILE_PICK: 'loop:file:pick', // renderer -> main: user-consented Markdown picker (drop-in contract)
  // Integrations (contract v0.1): generic control-surface family. Distinct from DAEMON_*
  // (single daemon base) — main resolves each integration's base_url from the registry file;
  // the renderer only ever names { integrationId, relPath }.
  INTEGRATIONS_STATUS: 'integrations:status', // renderer -> main: registry + manifest + health per entry
  INTEGRATIONS_SET: 'integrations:set', // renderer -> main: persist registry (returns sanitized)
  INTEGRATIONS_GET: 'integrations:get', // renderer -> main: GET a manifest-declared view endpoint
  INTEGRATIONS_INVOKE: 'integrations:invoke', // renderer -> main: execute a declared control
  INTEGRATIONS_SET_TOKEN: 'integrations:setToken', // renderer -> main: store bearer for an entry (value never read back)
  INTEGRATIONS_REVEAL: 'integrations:reveal', // renderer -> main: show the registry file in Finder (written empty first if missing)
  VOICE_CONFIGURED: 'voice:configured', // renderer -> main: is the oara integration configured? Decides whether the voice controls exist at all (@shared/voice-gate)
  VOICE_PREFLIGHT: 'voice:preflight', // renderer -> main: GET the bridge's /integration/manifest BEFORE the mic is asked for; rejects with the named reason
  VOICE_DICTATE: 'voice:dictate', // renderer -> main: STT ONLY — pcm16 base64 → POST /bridge/transcribe (oara-voice#3). No session, no turn: dictation fills a draft.
  VOICE_TURN: 'voice:turn', // renderer -> main: one spoken turn — pcm16 base64 → POST /bridge/voice via the oara integration entry (main owns base URL + bearer)
  VOICE_TURN_STREAM: 'voice:turn-stream', // renderer -> main: one spoken turn over POST /bridge/voice/stream (NDJSON) — main forwards each line as VOICE_STREAM_EVENT and resolves with the `done` envelope; falls back to /bridge/voice on 404 (older middleware)
  VOICE_STREAM_EVENT: 'voice:stream-event', // main -> renderer: one VoiceStreamEvent (transcript | segment | done | fallback) as it arrives
  VAD_START: 'vad:start', // renderer -> main: open the VAD WebSocket (ws://<oara-host>:8011/vad/stream?token=…) — main holds the token
  VAD_STOP: 'vad:stop', // renderer -> main: close it
  VAD_RESET: 'vad:reset', // renderer -> main: {"type":"reset"} — drop the service's half-heard utterance (e.g. after a barge-in)
  VAD_AUDIO: 'vad:audio', // renderer -> main (send, not invoke): one 512-sample float32 chunk at 16 kHz
  VAD_EVENT: 'vad:event', // main -> renderer: open | event{speech_start|speech_end} | closed{code, reason}
  // Screenshot capture (PARITY-PLAN A3). Distinct from CAPTURE_OPEN_MAIN (the quick-capture
  // WINDOW) — these drive desktopCapturer in main; pixels never come from the renderer.
  SCREENSHOT_SOURCES: 'screenshot:sources', // renderer -> main: screens+windows w/ thumbnails + TCC access state
  SCREENSHOT_GRAB: 'screenshot:grab', // renderer -> main: full-res PNG of one source id
  SCREENSHOT_OPEN_SETTINGS: 'screenshot:open-settings', // renderer -> main (send): open the OS Screen Recording pane
  // Terminal pane (claude/BEACON-TERMINAL-SCOPE.md) — a HUMAN surface: local ptys in main, driven by
  // the pane's xterm keyboard and NOTHING else. No chat/agent path may reach TERMINAL_WRITE
  // (terminal-smoke asserts the absence on the source). Beacon stores no secrets for this.
  TERMINAL_OPEN: 'terminal:open', // renderer -> main: spawn the user's login shell (or a command) in a pty
  TERMINAL_LIST: 'terminal:list', // renderer -> main: live + exited sessions (ptys outlive windows)
  TERMINAL_ATTACH: 'terminal:attach', // renderer -> main: subscribe this window to a session; replies with the replay
  TERMINAL_DETACH: 'terminal:detach', // renderer -> main (send): unsubscribe (pane unmount / pop-out)
  TERMINAL_WRITE: 'terminal:write', // renderer -> main (send): keystrokes/paste from the pane — THE only pty input
  TERMINAL_RESIZE: 'terminal:resize', // renderer -> main (send): cols/rows → SIGWINCH
  TERMINAL_RENAME: 'terminal:rename', // renderer -> main: tab label
  TERMINAL_CLOSE: 'terminal:close', // renderer -> main: kill + forget
  TERMINAL_POP_OUT: 'terminal:pop-out', // renderer -> main: detach the pane into its own BrowserWindow (#terminal); the pty does not move
  TERMINAL_POP_IN: 'terminal:pop-in', // renderer -> main (send): close the detached window; the main window's pane re-attaches
  TERMINAL_PLACEMENT_GET: 'terminal:placement', // renderer -> main: is the pane popped out right now?
  TERMINAL_PLACEMENT: 'terminal:placement:changed', // main -> the two Beacon windows: pop-out / pop-in / window closed
  TERMINAL_PEERS: 'terminal:peers', // renderer -> main: tailnet peers from `tailscale status` + ssh-agent identity COUNT — derived, never stored
  TERMINAL_DATA: 'terminal:data', // main -> ATTACHED renderer only (never broadcast): pty output chunk
  TERMINAL_EXIT: 'terminal:exit', // main -> attached renderer: the process ended — shown in the pane, never a silent close
  CONNECTION_GET_SETTINGS: 'connection:getSettings', // renderer -> main: current gateway URLs + hasToken
  CONNECTION_SAVE_SETTINGS: 'connection:saveSettings', // renderer -> main: persist URLs+token, rebuild, re-test
  CONNECTION_RECONNECT: 'connection:reconnect', // renderer -> main: drop + redial the WS now (manual retry)
  CONNECTION_TEST: 'connection:test', // renderer -> main: GET /api/status with form values, WITHOUT saving
  // main -> renderer (webContents.send / on)
  CHAT_STREAM: 'chat:stream',
  GATEWAY_EVENT: 'gateway:event', // main -> renderer: every non-chat daemon frame → the panels' store
  CONNECTION_STATUS_CHANGED: 'connection:status:changed',
  SESSION_SWITCH: 'session:switch', // main -> renderer: focus + switch (notification click)
  // Session windows (@shared/session-windows): a conversation popped out into its own OS window.
  SESSION_WINDOW_OPEN: 'session-window:open', // renderer -> main: open (or bring forward) a session's window
  SESSION_WINDOW_REQUEST_CLOSE: 'session-window:request-close', // renderer -> main: close it (it saves first)
  SESSION_WINDOW_CLOSE_READY: 'session-window:close-ready', // session window -> main: saved, close me
  SESSION_WINDOW_LIST: 'session-window:list', // renderer -> main: which sessions are popped out
  SESSION_WINDOWS_CHANGED: 'session-window:changed', // main -> renderers: the popped-out set changed
  SESSION_WINDOW_CLOSING: 'session-window:closing', // main -> one session window: save, then say ready
  OPEN_SETTINGS: 'app:open-settings', // main -> renderer: app menu Preferences (⌘,) → open Connection Settings
  // Auto-update (electron-updater): status surface + manual controls.
  UPDATER_STATUS: 'updater:status', // renderer -> main: current updater state
  UPDATER_CHECK: 'updater:check', // renderer -> main: check the release feed now
  UPDATER_INSTALL: 'updater:install', // renderer -> main: quit + install the downloaded update
  UPDATER_STATUS_CHANGED: 'updater:status:changed', // main -> renderer: every state transition
  // Notification preferences + close-to-tray choice (@shared/notification-prefs, @shared/tray-hint).
  // Dedicated GET/SET rather than the generic settings:* channel because main keeps a settled copy it
  // gates notifications against — a SET must refresh that copy and return the canonical stored value.
  // Generic settings.set would leave main stale.
  NOTIFY_PREFS_GET: 'notify:prefs:get', // renderer -> main: current per-kind switches
  NOTIFY_PREFS_SET: 'notify:prefs:set', // renderer -> main: persist + refresh main's gate, return stored
  CLOSE_MODE_GET: 'close-mode:get', // renderer -> main: does ✕ hide to tray or quit?
  CLOSE_MODE_SET: 'close-mode:set', // renderer -> main: persist + refresh, return stored
  // Launch at login (@shared/login-item). GET always reads LIVE from the OS (the user can flip it in
  // System Settings / Task Manager, so a cached copy drifts); SET writes then returns the OS readback
  // — what it kept, not what we asked for, same contract as notify:prefs:set.
  LOGIN_ITEM_GET: 'login-item:get', // renderer -> main: current OS login-item state
  LOGIN_ITEM_SET: 'login-item:set', // renderer -> main: register/unregister, return the OS readback
  // Settings → Other computers (@shared/network-setting): the connected Prometheus's home-network switch (its GET/PUT
  // /api/network) and its restart. Main holds the credential and the address; the page only says on, off, or restart.
  NETWORK_GET: 'network:get', // renderer -> main: the setting as Prometheus reports it, or why there is no section
  NETWORK_SET: 'network:set', // renderer -> main: save on/off, return the setting read back (or the refusal)
  NETWORK_RESTART: 'network:restart', // renderer -> main: restart Prometheus and wait for it to come back as the same computer
  // Settings → Make this Beacon an owner (@shared/owner-promotion, Prometheus #748): the page sends the one-time code; main trades it
  // for an owner token, keeps it in place of the API token and reconnects. The token never comes back.
  // Devices → Enrol (0.4.3, @shared/devices): the pairing code's TLS pin, decided before the one-shot token is minted.
  PAIR_PIN: 'devices:pair-pin', // renderer -> main: plain, pinned (with the pin) or refused (why), for the code's host
  OWNER_PROMOTE: 'owner:promote', // renderer -> main: redeem a one-time owner code at the connected Prometheus
  // Config → Models → Main model (@shared/main-model): which AI the connected Prometheus thinks with (its GET/PUT /api/model,
  // POST /api/model/check-key). A checked key is held in main for Save; a signed-in one never reaches the page. Restart: NETWORK_RESTART.
  MAIN_MODEL_GET: 'main-model:get', // renderer -> main: the setting as Prometheus reports it, or why there is no section
  MAIN_MODEL_CHECK: 'main-model:check', // renderer -> main: check a typed key for a company (held in main if it may be saved)
  MAIN_MODEL_SIGNIN: 'main-model:signin', // renderer -> main: sign in with OpenRouter, check the key it gives (held in main)
  MAIN_MODEL_SIGNIN_CANCEL: 'main-model:signin-cancel', // renderer -> main: stop a sign-in that is waiting for the browser
  MAIN_MODEL_SAVE: 'main-model:save', // renderer -> main: save a company, a version and the held key (or none); returns it read back
  // O9, how the assistant thinks (@shared/model-setup, @shared/openrouter). The key (from the sign-in or pasted) is checked and kept
  // in main; the page sends a pasted one once and never gets one back, nor the setup credential.
  MODEL_SIGNIN: 'model:signin', // renderer -> main: sign in with OpenRouter in the browser, then check the key; the step's outcome
  MODEL_SIGNIN_CANCEL: 'model:signin:cancel', // renderer -> main: Back from the sign-in: stop waiting, close the listener
  MODEL_CHECK_KEY: 'model:check-key', // renderer -> main: a pasted Anthropic or OpenAI key, checked; the step's outcome
  MODEL_FINISH: 'model:finish', // renderer -> main: save, start, and connect this Mac as the owner; the view when it ends
  MODEL_UPDATE: 'model:update', // main -> renderer: the finish's progress (no key, no credential)
  // Settings → About (@shared/legal-docs): open Beacon's license, the third-party notices or Chromium's
  // licenses in the OS viewer. The renderer names the document; main picks the shipped file.
  LEGAL_DOC_OPEN: 'legal-doc:open', // renderer -> main: open one of LEGAL_DOCS, return opened or why not
  // OS light/dark appearance (audit #6). The renderer is sandboxed and cannot read nativeTheme, so
  // main owns it: GET is the current appearance, CHANGED pushes every OS flip so a window wearing
  // the "match system" skin re-skins live instead of waiting for a relaunch.
  //
  // WHY A PUSH CHANNEL AND NOT renderer `matchMedia('(prefers-color-scheme: dark)')`. Measured on
  // Electron 44/Linux: matchMedia DOES track nativeTheme on read (flipping themeSource to light/dark
  // is reflected in .matches), BUT its `change` event NEVER FIRES. So a renderer-only listener would
  // resolve correctly at boot and then never re-skin on a live OS flip — a window stuck on the wrong
  // tone until relaunch. main's nativeTheme.on('updated') is the event that does fire; this channel
  // forwards it. Not a guess — the alternative was tested and does not deliver live changes.
  SYSTEM_THEME_GET: 'system-theme:get', // renderer -> main: is the OS currently dark?
  SYSTEM_THEME_CHANGED: 'system-theme:changed', // main -> renderer: the OS appearance flipped
  // Dev-gated resolve-path breadcrumbs (findings 2/5). Fire-and-forget `send`, never
  // `invoke`: instrumentation must not add a round-trip to the path it measures.
  UI_TRACE: 'ui:trace',
  // What the reply watchdog decided. ALWAYS-ON (unlike UI_TRACE): the line this
  // records tells an operator to check the daemon, and it fires in packaged
  // builds. Fire-and-forget `send` — recording must not add a round-trip.
  WATCHDOG_EVENT: 'watchdog:event'
} as const

/** Auto-update lifecycle (src/main/updater.ts). 'disabled' = unpackaged/dev build. */
export interface UpdaterStatus {
  state: 'idle' | 'disabled' | 'checking' | 'available' | 'up-to-date' | 'downloading' | 'ready' | 'error'
  version?: string // target (or confirmed current) version, when known
  percent?: number // download progress, 0-100 ('downloading' only)
  detail?: string // error text — the provider's own words, not a paraphrase
}

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed'

export interface ConnectionStatus {
  state: ConnectionState
  /** The gateway this status refers to (host:port), or null before a profile is chosen. */
  gateway: string | null
  attempt?: number
  /** epoch ms of the last transition */
  since?: number
  /** REST bearer health, tracked from live call outcomes (Slice 1): 'unauthorized' after any 401,
   * 'ok' after any non-401 HTTP response, absent until a REST call has resolved. The WS can be
   * 'connected' (it's unauthenticated) while REST is rejected — this field is what makes a bad
   * token visible everywhere instead of silently empty panels. */
  restAuth?: 'ok' | 'unauthorized'
  /** WS bearer health (Phase B): 'unauthorized' after the daemon closes the socket 4401 for a
   * missing/bad first-frame auth token, 'ok' once an authenticated socket reaches 'connected'.
   * Parallel to restAuth — either being 'unauthorized' means the token is rejected. */
  wsAuth?: 'ok' | 'unauthorized'
  /** A pinned (home-network, TLS) Prometheus answered with another key, so Beacon sent it nothing (docs/MULTI-COMPUTER-v0.4.md
   *  §3.4). The hashes are for Copy details; `name` is what the profile calls the computer. Absent otherwise. */
  wrongKey?: { pinned: string; presented: string | null; name: string }
  /** This connection goes plain to the home network (saved before Beacon refused that): src/shared/plain-lan.ts. */
  notEncrypted?: boolean
  /** Owner of this Prometheus, or an approved device that may only chat (src/shared/device-role.ts), from GET /api/devices after each
   *  connect, and remembered for this address and key from the last answer. Absent until known; Beacon then shows everything. */
  role?: import('./device-role').DeviceRole
  /** Beacon will not use this address at all: plain to the internet (src/main/plain-public.ts). The words, for the banner. */
  refused?: string
}

export interface ChatSendRequest {
  sessionId: string
  message: string
  idempotencyKey?: string
  /** Client-generated correlation id (the renderer mints it). Echoed on the WS user frame
   * alongside the durable rowid so the optimistic row is re-keyed deterministically. */
  clientMsgId?: string
  /** Per-message turn mode (Composer-controls): 'chat' runs a no-tools turn; omitted / 'agent' is
   * today's byte-identical default. Carried to POST /api/chat/send `mode` (Prometheus #72). */
  mode?: 'agent' | 'chat'
  /** Force-search (one-shot): true → the send carries `tool_choice: {tool:"web_search"}`
   * (Prometheus #76/#77 — forced first round, then the turn relaxes to auto). Omitted/false →
   * no field (byte-identical default). Only meaningful in Agent mode; the composer disables the
   * toggle in Chat. */
  forceSearch?: boolean
  /** @-references (Prometheus PR 382): `[{type: file|diff|url, target}]`, resolved by the DAEMON
   * against the session's workspace before the turn is queued. Omitted/empty → no field. A refusal
   * (400/403/404/502/503, {error, kind}) surfaces as the send's error — the turn was not queued. */
  references?: ChatReference[]
}

export interface ChatReference {
  type: 'file' | 'diff' | 'url'
  target: string
}

export interface ChatSendResult {
  runId: string
  status: string
  /** Present when a send failed WHILE CONNECTED (it was outboxed for the next reconnect, but the
   * user must be told now — a connected-send failure that only queues silently looks like the
   * daemon ignoring them; live-walk finding 2026-07-12). Absent on clean sends and offline queuing. */
  error?: string
}

/** Outcome of the Stop button (daemon POST /api/chat/interrupt). `stopped: false` is NOT an error —
 * the daemon's contract is idempotent: stopping a quiet session reports false rather than failing.
 * `error` carries the daemon's own words on 400/503 or a transport failure. */
export interface ChatInterruptResult {
  stopped: boolean
  error?: string
}

/**
 * Result of stopping one desktop task (Prometheus#663). Over the WS the daemon's answer arrives
 * later, as a `computer_task_stop_ack` frame in the gateway store, so `stopped` is absent; over
 * REST (the socket was not open) it is here. `sent:false` + `error` = the stop never left Beacon.
 */
export interface ComputerTaskStopResult {
  sent: boolean
  via?: 'ws' | 'rest'
  stopped?: boolean
  error?: string
}

/**
 * The desktop door's answers (v1.1 PR 7). Each door route returns a DoorOutcome rather than
 * throwing, because the daemon's refusals are STRUCTURED: `{error, detail, options, describes,
 * app}`, where `detail` is the sentence written for a person (shown verbatim) and `needs_app`
 * carries the picker's rows. An Error message would flatten exactly that. The renderer imports
 * DoorOutcome / DoorRefusal from @shared/computer-door; these aliases keep the bridge surface
 * typed without restating the shape.
 */
import type { BindingWire, DoorOutcome, DoorRefusal } from './computer-door'

export type { BindingWire, DoorOutcome, DoorRefusal }

/**
 * One file upload → the daemon's `chat_upload` WS frame (built in @shared/attachments). A batch sends
 * one frame per file; the composer text (if any) rides as `caption` on the LAST file, which the daemon
 * appends to the vision/extracted text. Daemon converts uploads to a text block — no media persistence.
 */
export interface ChatUploadRequest {
  sessionId: string
  filename: string
  /** raw base64 (NO "data:<mime>;base64," prefix). */
  contentBase64: string
  mimeType: string
  caption?: string
}

/**
 * Normalized chat frame pushed main -> renderer. The main process derives these from the
 * raw Prometheus `:8010` deltas (chat_delta / chat_done / chat_message / tool_call_*).
 *
 * - delta/done carry the transient streaming handle (`asst-<ms>`) as messageId.
 * - message (the user echo) carries the DURABLE rowid as messageId plus clientMsgId, so the
 *   renderer re-keys its optimistic row deterministically (no content matching).
 * - tool_* carry the stable call_id correlating start↔end.
 */
export type ChatStreamFrame =
  | { kind: 'delta'; sessionId: string; messageId: string; content: string }
  | {
      kind: 'message'
      sessionId: string
      messageId: number | string
      ordinal?: number
      clientMsgId?: string
      role: string
      content: string
      createdAt?: number
      /**
       * Who wrote the turn, when it was not the operator (`task_supervisor` = a worker's report,
       * Prometheus #713). Absent from an older daemon — never defaulted here.
       */
      provenance?: string | null
      isTrusted?: boolean
    }
  | {
      kind: 'done'
      sessionId: string
      messageId: string
      /**
       * The daemon set this when the turn was INTERRUPTED (Stop button, or another client's stop —
       * the broadcast reaches every window). P9.1: an interrupted turn must not render identically
       * to a finished one, so this rides through to the row. Absent/false on a normal finish.
       */
      interrupted?: boolean
      /**
       * The assistant turn's DURABLE rowid, when the daemon's persist surfaced one
       * (GRAFT-MOBILE-BRIDGE 3b; P9.8). The renderer re-keys its streamed bubble to this
       * immediately, closing the window where the row's rowId is null and anything keyed on a
       * real rowid (an edit-into-branch fired right after the reply lands) operates on the
       * fractional placeholder from message-order. Absent — NOT null — when persistence
       * surfaced none or on an older daemon, matching the wire's omit-don't-null contract;
       * the reconcile re-read stays the fallback that fills the rowid in those cases.
       */
      rowId?: number
    }
  /**
   * A slash command's reply is complete (daemon #256). DISTINCT FROM `done` on
   * purpose: a command reply is not a turn, it carries a synthetic transient
   * `cmd-asst-<ms>` id, and a /steer issued during a live turn emits one while
   * that turn is still streaming — routed through `done` it would blank a
   * running turn's activity and stand its watchdog down permanently.
   */
  | { kind: 'command_done'; sessionId: string; messageId: string; commandName?: string; transient?: boolean }
  | { kind: 'tool_start'; sessionId?: string; callId: string; toolName: string; inputs: unknown }
  | { kind: 'tool_end'; sessionId?: string; callId: string; success?: boolean; result?: string; error?: string }
  /**
   * A context-compaction pass for one session (#283): the daemon's session-scoped
   * `context_compaction` frame. `start` and `progress` show the inline "Tidying up…" line,
   * `done`/`noop` hide it, `failed` leaves a plain note (@shared/compaction-status). Every count is
   * absent, never 0, when the daemon did not send it.
   */
  | {
      kind: 'compaction'
      sessionId: string
      stage: import('./compaction-status').CompactionStage
      progress?: number
      chunksDone?: number
      chunksTotal?: number
      tokensBefore?: number
      tokensAfter?: number
      threshold?: number
      reason?: string
    }
  /** Daemon liveness pulse while a turn runs (~3s). Carries what the turn is
   * actually doing, so the UI can show real activity instead of guessing. */
  | {
      kind: 'progress'
      sessionId: string
      phase: string
      toolName?: string | null
      round?: number
      chars?: number
      toolCalls?: number
      elapsedS?: number
    }
  /** A turn died. `message` is the provider's own words; `hint` is the actionable
   * next step; `errKind` is a stable token (billing/auth/rate_limit/…). */
  | {
      kind: 'error'
      sessionId: string
      message: string
      errKind?: string
      provider?: string
      status?: number | null
      hint?: string
    }

export interface SessionSummary {
  id: string
  title?: string
  /** Gateway label derived from the id prefix (telegram/desktop/slack/…). */
  gateway?: string
  messageCount?: number
  /** epoch ms — real now (the daemon returns real created_at). */
  lastActive?: number
  /** Durable max rowid (cache cursor) — drives the unread dot vs the last-viewed watermark. */
  watermark?: number
  /** Daemon-owned pin (Prometheus#351). Every client agrees because none of them owns it. */
  pinned?: boolean
}

/**
 * A cache row as the renderer sees it. `id` is the canonical cache key — the durable rowid
 * (as a string) once confirmed, or `local-<uuid>` while optimistic. Order strictly by `rowId`
 * (durable, monotonic); `ordinal` is display-only and explicitly NON-UNIQUE. `createdAt` is a
 * display timestamp only.
 */
export interface HistoryMessage {
  id: string
  rowId: number | null
  ordinal: number | null
  sessionId: string
  role: string
  content: string
  /** Raw daemon content_json (JSON string of structured blocks), or null (legacy/optimistic). The
   * renderer adapts it to ContentPart[] via @shared/parts; null → fall back to flat `content`. */
  contentJson?: string | null
  /**
   * WHO originated the turn (Prometheus P9.3), carried verbatim from the daemon: 'user' or a
   * machinery source. null/undefined = legacy or optimistic row → reads as 'user'. The renderer
   * badges on it via @shared/provenance; `role` cannot answer this question.
   */
  provenance?: string | null
  /** Whether the content is trusted (Prometheus P9.3). undefined/null = legacy → trusted. */
  isTrusted?: boolean
  pending: boolean
  createdAt?: number
  clientMsgId?: string
}

export interface OutboxStatus {
  pending: number
  failed: number
}

/** One deliverable from GET /api/artifacts (Prometheus feat/artifacts-api) — the agent's outbox
 * (~/.prometheus/files), served by CONTENT ID: `id` is a sha256 prefix of the bytes (rename-safe,
 * dedup), `name` the basename chat chips match against, `path` outbox-relative (display only —
 * the wire contract is the id; no client-supplied path ever reaches the daemon's filesystem). */
export interface ArtifactEntry {
  id: string
  name: string
  path: string
  size: number
  mtime: number
  mime: string
}

/** artifacts.download outcome. The fetch runs IN MAIN (token never in the renderer); the file is
 * saved to ~/Downloads under a sanitized, uniquified name and revealed — never opened/executed. */
/** Where an export landed, or why it did not. `messages: 0` is a SUCCESS with nothing in it —
 * distinct from a failure, and reported as such so an empty file is never rendered as a win. */
export interface SessionExportResult {
  ok: boolean
  savedPath?: string
  messages?: number
  error?: string
  /** Set when the export succeeded but may be INCOMPLETE — e.g. the daemon was unreachable, so it
   * was built from the cache alone. A partial transcript that does not admit it is worse than a
   * failure, because it looks finished. */
  warning?: string
}

export interface ArtifactDownloadResult {
  ok: boolean
  savedPath?: string
  error?: string
}

export interface GatewayProfile {
  name: string
  apiBase: string
  wsUrl: string
  isDefault: boolean
}

export interface SetupStatus {
  /** True on first run, or when the saved Prometheus is still in setup mode — the renderer shows
   * the setup wizard. */
  needsSetup: boolean
  /** The currently-configured address (host), if any — for re-config prefill. */
  currentAddress?: string
  /** Present when a connection is saved but its Prometheus answered /api/setup/status in setup
   * mode: a setup that stopped part-way. The wizard reopens past Connect instead of the app opening
   * on a daemon that refuses everything (the 0.3.0 strand). */
  resume?: SetupResume
  /** The v0.4.0 first run may be shown (@shared/onboarding-gate): never true in a release build. The
   * renderer falls back to the existing wizard when this is absent or false. */
  onboarding?: boolean
  /** This platform asks for Local Network permission before Beacon can look at the home network (macOS). */
  localNetworkPrompt?: boolean
  /** Dev and probe builds only: how long the first message waits for an answer (a release build never sends it). */
  helloTimeoutMs?: number
}

/** What a part-way setup has done so far, as the setup-mode daemon and the credential store say. */
export interface SetupResume {
  /** /api/setup/configure already ran (the daemon's `configured: true`) — only the flip is left. */
  configured: boolean
  /** A credential is stored. Without one this Mac never paired (e.g. Quick connect saved only the
   * address), so the wizard reopens at Connect, to pair. A stored one can still be stale; the
   * wizard finds that out on its first authed call. */
  paired: boolean
  /** The saved Prometheus is on this Mac (127.0.0.1): the new flow set it up, and resumes at A2 (O9). */
  here?: boolean
  /** Prometheus on this Mac is configured, and the credential Beacon holds is still its master token: A5 reopens to finish the
   *  owner trade (@shared/model-setup resumeAtTrade). */
  trade?: boolean
}

/** What the check of this Mac found: the decision, and the facts later screens use (memory, for how the assistant
 *  should think) and the port a Prometheus answers on here. */
export interface MacCheckResult {
  verdict: import('./mac-check').MacVerdict
  freeBytes: number | null
  memoryBytes: number | null
  port: number
}

export interface SetupForgetResult {
  ok: boolean
  error?: string
}

export interface SetupRequest {
  /** Gateway host/IP (e.g. the mini's Tailscale address). Stored in app-data, never in source. */
  address: string
  /** Optional Prometheus API bearer token (blank = no-auth). Stored in the OS keychain. */
  token?: string
  /** The ports the computer answers on, when they are not the standard 8005/8010 (a computer found by
   *  discovery, or an address someone typed with its port). Both or neither: a half is refused. */
  apiPort?: number
  wsPort?: number
}

export interface SetupResult {
  ok: boolean
  error?: string
}

/** First-run "I have a pairing code" submission (Onboarding Phase 1). The main process POSTs
 * /api/setup/pair and, on success, stores the address (gateway profile) + returned token
 * (keychain) exactly like the token path — the renderer never sees the token. */
export interface PairRequest {
  /** Gateway host/IP — same field as SetupRequest.address. */
  address: string
  /** The 6-digit code from the daemon's setup-mode banner. */
  code: string
}

export interface PairResult {
  ok: boolean
  /** Honest inline error (wrong code / locked / expired / unreachable), per daemon-api conventions. */
  error?: string
  /** Present on a wrong code when the daemon reported how many tries are left. */
  attemptsRemaining?: number
  /** True when pairing is locked/expired/used — retrying the same code is pointless; restart the daemon. */
  locked?: boolean
}

/** One post-pair poll answer: is the REAL daemon answering /api/status yet? 'setup' = still in
 * setup mode; 'waiting' = unreachable (likely restarting); 'ready' = proceed into the app. */
export interface PairPollResult {
  state: 'setup' | 'waiting' | 'ready'
}

/** Wizard Connect-step probe (Phase 2): GET /api/setup/status on the TYPED address, saving
 * nothing. Distinguishes a setup-mode daemon (pair with a code) from everything else. */
export interface SetupProbeRequest {
  /** Gateway host/IP — same field as SetupRequest.address. */
  address: string
}

export interface SetupProbeResult {
  /** Anything answered HTTP at all. */
  reachable: boolean
  /** True = a Prometheus setup-mode daemon answered /api/setup/status. */
  setupMode: boolean
  /** Phase 2 resume: the setup daemon says /api/setup/configure already ran. */
  configured: boolean
  /** Pairing window state ('available' | 'locked'), when in setup mode. */
  pairing?: string
}

/**
 * A pending LEVEL-1 action awaiting the user's approve/deny. Mirrors the daemon's PendingAction
 * (src/prometheus/permissions/approval_queue.py), camelCased. Approvals are GLOBAL — there is no
 * session id on the daemon side — so the renderer surfaces them in one app-level overlay, not per
 * session.
 */
export interface ApprovalRequest {
  requestId: string
  toolName: string
  description: string
  /** epoch ms (the daemon's created_at is epoch seconds; the REST client ×1000s it). */
  createdAt: number
  /**
   * What each scope verb WOULD grant, keyed BY the verb, described by the daemon.
   *
   * SPRINT-CONSENT: this is an OBJECT, not an array — `prospective_extents()` returns
   * `dict[str, str]`, so `{}` (not `[]`) is the empty case and emptiness is
   * `Object.keys(...).length === 0`. Empty is MEANINGFUL: the request carries no describable
   * target, so no remembered grant is on offer and the UI must not invent one.
   *
   * `once` is deliberately ABSENT here — it creates no grant, so the daemon does not describe
   * it. Beacon supplies once/deny itself and renders these four alongside.
   *
   * The values are the daemon's prose VERBATIM. Beacon never re-derives or re-words them: two
   * surfaces computing the same extent is the exact defect this sprint removed.
   */
  extents: Record<string, string>
  /**
   * Epoch ms when the daemon withdraws this request. Rendered when present, nothing when
   * absent — Beacon NEVER computes it from createdAt + a timeout it holds locally. That
   * arithmetic is the same two-surfaces defect as re-deriving extents.
   */
  expiresAt?: number
  /**
   * THE ARGUMENTS BEING APPROVED — already redacted, truncated and ordered by the daemon.
   *
   * `description` carries the reason, and for a file write the reason carries the path, so the
   * card survived without this. A desktop action has no such luck: "computer_type_text requires
   * confirmation" names neither the text nor the target, and approving a keystroke without
   * seeing it is not consent.
   *
   * Undefined means NOTHING TO SHOW — no arguments, or none the daemon considered worth a line
   * (it drops opaque plumbing: element_token, snapshot_id, session). Beacon renders the values
   * VERBATIM and re-derives nothing; see @shared/approval-arguments for what that forbids.
   */
  arguments?: import('./approval-arguments').ApprovalArguments
  /**
   * A WORKER'S REQUEST (Prometheus #720): the background worker that asked. Undefined on an
   * ordinary request. @shared/workers names it on the card.
   */
  workerTaskId?: string
  /** The conversation the request belongs to — sent on a worker's and a desktop task's request. */
  sessionId?: string
  /**
   * The daemon accepts only "once" for this request (409 once_only on any other scope) — true on
   * every worker and desktop-task request. The card offers no lasting scope when it is set.
   */
  onceOnly?: boolean
}

/**
 * The operator's decision. A discriminated union so "deny with a scope" cannot be constructed:
 * deny carries no scope because denial creates no grant.
 *
 * `scope` is the extent KEY passed through untouched from the payload. Beacon holds no verb
 * list of its own — the daemon's `normalise_scope` is the sole authority, so if the two
 * vocabularies ever drift the daemon 400s and the operator SEES it (surfaced on the card),
 * rather than Beacon silently filtering to a stale local list.
 */
export type ApprovalDecision = { kind: 'approve'; scope: string } | { kind: 'deny' }

/** HTTP verb for the generic daemon write bridge (the write counterpart to daemon.get). */
export type DaemonWriteMethod = 'POST' | 'PUT' | 'DELETE' | 'PATCH'

export type Unsubscribe = () => void

/** Current connection settings for the post-setup Settings screen. The token VALUE is deliberately
 * NEVER sent to the renderer (it stays in the OS keychain); only whether one is set is exposed. */
export interface ConnectionSettings {
  apiBase: string
  wsUrl: string
  hasToken: boolean
  /** The saved connection goes plain to the home network (saved before Beacon refused that): the one-line notice shows. */
  notEncrypted?: boolean
}

/** A Connection-Settings submission. A non-empty `token` replaces; a blank field keeps the current
 * token; `clearToken` removes it (connect with no auth). */
export interface SaveConnectionSettingsRequest {
  apiBase: string
  wsUrl: string
  token?: string
  clearToken?: boolean
}

/** Outcome of a connection test. `ok`/`code`/`label` are the REST probe (GET /api/status). `ws`,
 * when present, is the separate WebSocket first-frame-auth probe so Settings can show each
 * transport's result distinctly — a token can pass REST yet a wrong WS URL still fail, or vice
 * versa. */
export interface ConnectionTestResult {
  ok: boolean
  code?: number
  label: string
  ws?: WsTestResult
}

/** The WebSocket half of a connection test: did a first-frame-auth connect reach the daemon's
 * `connected` welcome (ok), get closed 4401 (unauthorized), or fail to connect (unreachable)? */
export interface WsTestResult {
  ok: boolean
  state: 'ok' | 'unauthorized' | 'unreachable'
  label: string
}

/** A no-save connection test (Settings "Test" button): probe GET /api/status with the form's
 * values without persisting anything. Omitted apiBase → test the currently-saved gateway. */
export interface ConnectionTestRequest {
  apiBase?: string
  /** WS URL to probe with first-frame auth (Phase B). Omitted → the saved gateway's WS URL. */
  wsUrl?: string
  /** Bearer to test with. Blank/omitted → the saved token (unless useSavedToken is false). */
  token?: string
  /** false → probe with NO token even if one is saved (previews the "Clear token" outcome). */
  useSavedToken?: boolean
}

export interface SaveConnectionSettingsResult {
  saved: boolean
  error?: string
  test?: ConnectionTestResult
}

/**
 * The exact API the preload exposes on `window.beacon`. Both the preload (which must
 * satisfy it) and the renderer (which consumes it via the Window augmentation) reference
 * this interface, keeping the bridge contract honest on both sides.
 */
export interface BeaconBridge {
  /** process.platform, for words that name the computer Beacon runs on (@shared/this-computer). */
  platform: string
  connection: {
    status(): Promise<ConnectionStatus>
    onStatus(cb: (s: ConnectionStatus) => void): Unsubscribe
    /** Current gateway URLs + whether a token is saved (the value stays in the keychain). */
    getSettings(): Promise<ConnectionSettings>
    /** Persist URLs + token to the SAME store first-run uses, rebuild the connection, and re-test
     * GET /api/status — returns the test outcome so the UI can show real feedback. */
    saveSettings(req: SaveConnectionSettingsRequest): Promise<SaveConnectionSettingsResult>
    /** App menu Preferences (⌘,) → main asks the renderer to open Connection Settings. */
    onOpenSettings(cb: () => void): Unsubscribe
    /** Manual retry: drop + redial the WS now (resets the backoff clock). No-op before setup. */
    reconnect(): Promise<void>
    /** Probe GET /api/status with form values WITHOUT saving — the Settings "Test" button. */
    test(req?: ConnectionTestRequest): Promise<ConnectionTestResult>
  }
  chat: {
    send(req: ChatSendRequest): Promise<ChatSendResult>
    /** Upload one file over the live WS (:8010) as a `chat_upload` frame. Resolves true if dispatched
     * (socket open), false if not connected. The daemon converts it to text server-side. */
    upload(req: ChatUploadRequest): Promise<boolean>
    /** Stop the running turn (P9.1): daemon POST /api/chat/interrupt. Idempotent — `stopped:false`
     * when no turn is running is not an error. The terminal state arrives on the broadcast
     * `chat_done{interrupted:true}`, which every client (including this one) renders distinctly. */
    interrupt(sessionId: string): Promise<ChatInterruptResult>
    onStream(cb: (f: ChatStreamFrame) => void): Unsubscribe
  }
  computer: {
    /** Stop ONE desktop task. No new action starts after it; one already in flight may land. */
    stopTask(taskId: string): Promise<ComputerTaskStopResult>
    /** The desktop door (v1.1 PR 7). Each returns a DoorOutcome, never throws — the daemon's
     *  refusals are structured and the UI branches on them (`needs_app` opens the picker). */
    listApps(): Promise<DoorOutcome<{ apps?: string[] }>>
    getBinding(sessionId: string): Promise<DoorOutcome<BindingWire>>
    /** Pick the app for this conversation; the pick IS the consent (W2). */
    setBinding(sessionId: string, app: string): Promise<DoorOutcome<BindingWire>>
    /** Clear the pick and stop any task in this session. */
    clearBinding(sessionId: string): Promise<DoorOutcome<BindingWire>>
    /** Start a task. Returns the task id at once (202); steps then arrive as `computer_*` frames. */
    startTask(body: Record<string, string>): Promise<DoorOutcome<{ task_id?: string }>>
  }
  sessions: {
    list(): Promise<SessionSummary[]>
    /** sessionId → the project folder its cached tool calls point at (@shared/session-projects).
     *  Only sessions with a clear majority appear; a suggestion, never a filing. */
    projectHints(): Promise<Record<string, ProjectHint>>
  }
  history: {
    fetch(sessionId: string, limit?: number): Promise<HistoryMessage[]>
    /**
     * Re-pull the WHOLE session from rowid 0 and return it. `fetch` reconciles FORWARD from the
     * highest cached rowid, so a session Beacon only ever saw live can be missing everything
     * older than its first frame — and a search hit is exactly the case that lands there. Only
     * called when a jump target is absent, never on the ordinary open path.
     */
    backfill(sessionId: string): Promise<HistoryMessage[]>
  }
  outbox: {
    status(): Promise<OutboxStatus>
  }
  settings: {
    get(key: string): Promise<string | null>
    set(key: string, value: string): Promise<void>
  }
  /** Notification preferences + the ✕-button behavior (@shared/notification-prefs, @shared/tray-hint).
   *  SET returns the STORED value after main parses/sanitizes it, so the UI renders what was kept,
   *  not what it asked for — same rule as loginItem.set. */
  notifications: {
    prefs(): Promise<import('./notification-prefs').NotifyPrefs>
    setPrefs(prefs: import('./notification-prefs').NotifyPrefs): Promise<import('./notification-prefs').NotifyPrefs>
    closeMode(): Promise<import('./tray-hint').CloseMode>
    setCloseMode(mode: import('./tray-hint').CloseMode): Promise<import('./tray-hint').CloseMode>
  }
  gateway: {
    profiles(): Promise<GatewayProfile[]>
  }
  /** Dev-gated diagnostic breadcrumb. No-op in a packaged build (dropped in main). */
  trace(e: import('./ui-trace').UiTraceEvent): void
  /** Durable watchdog decision record. Always-on — see watchdog-log.ts. */
  watchdog(e: import('./watchdog-log').WatchdogEvent): void
  /** Repaint the OS window buttons (Linux/Windows) with the active skin's chrome colours.
   *  Fire-and-forget; main ignores it on macOS, where the traffic lights are the system's own. */
  setTitlebarOverlay(colors: { color: string; symbolColor: string }): void
  /** Reload the window that calls it, from main. The renderer cannot do this itself in a built app:
   *  `location.reload()` raises will-navigate to the shell's file:// URL and the navigation guard
   *  refuses it. Fire-and-forget; main ignores a sender that is not a Beacon window's main frame. */
  reloadWindow(): void
  approvals: {
    /** Poll the daemon's GLOBAL pending-approval queue. */
    list(): Promise<ApprovalRequest[]>
    /** Approve or deny one pending action (binary; the daemon expects no body). */
    resolve(requestId: string, decision: ApprovalDecision): Promise<void>
    /** Tell main how many approvals are pending (tray badge/menu line; Slice 9). Fire-and-forget. */
    notifyCount(n: number): void
    /** NEW pending requests seen by the poll → main decides notification (one authority, one dedupe). */
    notifyNew(requests: ApprovalRequest[]): void
  }
  voice: {
    /** One spoken turn: pcm16 base64 → main POSTs /bridge/voice (oara integration). Returns the raw
     * bridge response; the renderer maps it to ONE visible state via parseVoiceOutcome. */
    turn(audioBase64: string): Promise<import('@shared/voice').BridgeVoiceResponse>
    /** STREAMING turn (oara-voice #12): main POSTs /bridge/voice/stream and forwards every NDJSON line
     * via onStreamEvent as it arrives — segment 0 plays while the model is still writing. Resolves
     * with the `done` envelope (or, on a 404 fallback, the joined /bridge/voice response). */
    turnStream(audioBase64: string): Promise<import('@shared/voice').BridgeVoiceResponse>
    /** Subscribe to stream events for turns started with turnStream. Returns the unsubscribe. */
    onStreamEvent(cb: (ev: import('@shared/voice-stream').VoiceStreamEvent) => void): () => void
    /** DICTATION (B6): pcm16 base64 → main POSTs /bridge/transcribe. STT only — no session, no
     * turn, nothing sent. The renderer maps it via parseDictationOutcome and appends to the draft. */
    dictate(audioBase64: string): Promise<import('@shared/dictation').BridgeTranscribeResponse>
    /** True when the oara integration is configured (present and enabled). No network: without it
     *  the voice controls are not rendered at all. */
    configured(): Promise<boolean>
    /** Checks the bridge answers; rejects with the named reason. Called before the mic, never after. */
    preflight(): Promise<boolean>
  }
  /** Hands-free mode (item 8): main owns the VAD WebSocket (token in the URL); the renderer streams
   * 16 kHz float32 chunks and receives speech_start / speech_end{audio} events. */
  vad: {
    /** Resolves once the socket is OPEN; rejects with the named reason if it never opens. */
    start(): Promise<boolean>
    stop(): Promise<boolean>
    reset(): Promise<boolean>
    /** Fire-and-forget — ~31 chunks/s. */
    audio(chunk: Float32Array): void
    onEvent(cb: (ev: import('@shared/hands-free').VadClientEvent) => void): () => void
  }
  screenshot: {
    /** Screens + windows with picker thumbnails, plus the TCC access state (see @shared/capture). */
    sources(): Promise<import('./capture').CaptureSourcesResult>
    /** Full-resolution PNG of one source. An empty capture is an ERROR (the un-granted-TCC shape). */
    grab(sourceId: string): Promise<import('./capture').CaptureGrabResult>
    /** Open the OS Screen Recording privacy pane (macOS; no-op elsewhere). Fire-and-forget. */
    openSettings(): void
  }
  events: {
    /** Subscribe to every non-chat daemon frame (the panels' gateway store). */
    onGateway(cb: (ev: GatewayEvent) => void): Unsubscribe
    /** GET /api/events/recent — durable signal_events tail (activity-feed backfill). */
    recent(limit?: number): Promise<EventRow[]>
  }
  artifacts: {
    /** GET /api/artifacts — the daemon outbox manifest. Empty array on older daemons (the chips
     * feature-detect off this): a 404/absent route must degrade to "no chips", never an error. */
    list(): Promise<ArtifactEntry[]>
    /** Fetch by content id in MAIN, save to ~/Downloads (sanitized + uniquified), reveal in the
     * file manager. Never auto-opens the file. */
    download(id: string, name: string): Promise<ArtifactDownloadResult>
    /**
     * Fetch by content id and classify for the preview pane. Reading + classification happen in
     * MAIN so the renderer never holds the raw buffer and the size cap is enforced where the bytes
     * actually arrive. Refusals are OUTCOMES ('unsupported' / 'too-large'), never thrown.
     */
    read(id: string, name: string, mime?: string, size?: number): Promise<ArtifactPreview>
  }
  daemon: {
    /** Scoped generic GET of a read-only same-origin /api/ path (the 5b panels' data source). */
    get(path: string): Promise<unknown>
    /** Scoped generic write (POST/PUT/DELETE) of a same-origin /api/ path — the write counterpart to
     * get. Attaches the bearer + an optional JSON body; same path-allowlist. Resolves the parsed JSON
     * response (or null on an empty body). */
    write(path: string, body?: unknown, method?: DaemonWriteMethod): Promise<unknown>
  }
  session: {
    /** Tell main which session is open (so notifications skip the visible one). */
    setActive(sessionId: string): void
    /** Tell main every session on screen in this window (split panes): a reply in any of them is one
     *  you can see, so it does not notify while the window has focus. */
    setVisible(sessionIds: string[]): void
    /**
     * Write this conversation to ~/Downloads and reveal it. Built in MAIN from the cache, using
     * the SAME content parser the renderer draws from — so an export cannot quietly disagree with
     * what was on screen.
     */
    export(sessionId: string, format: ExportFormat, meta?: { title?: string; gateway?: string }): Promise<SessionExportResult>
    /** Forget a session for good: the daemon drops its in-memory entry (so GET /api/sessions
     * stops listing it) and the local cache purges its rows. Durable daemon history is kept. */
    forget(sessionId: string): Promise<void>
    /** Notification click → main asks the renderer to focus + switch to a session. */
    onSwitch(cb: (sessionId: string) => void): Unsubscribe
  }
  /** A conversation in its own OS window (@shared/session-windows). One place at a time. */
  sessionWindows: {
    /** Open the session's window, or bring it forward if it is already open. */
    open(sessionId: string): Promise<boolean>
    /** Close the session's window; it saves its draft first. The session goes back to the main window. */
    requestClose(sessionId: string): Promise<boolean>
    /** From a session window: the draft is saved, close me (and show the session in the main window
     *  when `returnToMain`). */
    closeReady(returnToMain: boolean): Promise<boolean>
    /** The sessions that are popped out right now. */
    list(): Promise<string[]>
    onChanged(cb: (sessionIds: string[]) => void): Unsubscribe
    /** In a session window: main is closing it; save, then call closeReady. */
    onClosing(cb: () => void): Unsubscribe
  }
  setup: {
    /** First-run check: does the app need the gateway address + token entered? */
    status(): Promise<SetupStatus>
    /** Save the address (app-data) + token (keychain), then connect. */
    save(req: SetupRequest): Promise<SetupResult>
    /** Exchange a setup-mode pairing code for the real token (stored like save()'s). */
    pair(req: PairRequest): Promise<PairResult>
    /** Post-pair poll: has the real daemon replaced the setup-mode server yet? */
    pairPoll(): Promise<PairPollResult>
    /** Probe /api/setup/status on a typed address WITHOUT saving — wizard Connect diagnosis. */
    probe(req: SetupProbeRequest): Promise<SetupProbeResult>
    /** Forget the saved address and the stored credential, and drop the connection. Nothing changes
     * on Prometheus itself. The next status() says needsSetup. */
    forget(): Promise<SetupForgetResult>
  }
  /** Finding a Prometheus on this Mac, the home network and the private network (@shared/discovery). It asks
   *  each computer one credential-free question and never connects to any of them. */
  discovery: {
    /** Begin a search. `quiet` (the default) looks only at this Mac, which cannot raise a macOS prompt. */
    start(req?: { quiet?: boolean }): Promise<{ session: number }>
    stop(): Promise<void>
    /** Ask one typed address (Advanced). The port typed is the port asked. */
    probeAddress(req: { host: string; port: number }): Promise<import('./discovery').ProbeAddressResult>
    /** Open System Settings at Local Network, for someone who said no. Resolves whether it was opened. */
    openLocalNetworkSettings(): Promise<boolean>
    onUpdate(cb: (u: import('./discovery').DiscoveryUpdate) => void): Unsubscribe
  }
  /** Joining a Prometheus that already has an owner (path B of the v0.4.0 onboarding): ask, wait for approval, be connected. */
  join: {
    begin(req: import('./join').JoinBeginRequest): Promise<import('./join').BeginResult>
    poll(): Promise<import('./join').PollOutcome>
    cancel(): Promise<void>
  }
  /** The OWNER's side of joining: a new device is asking this Prometheus to let it connect. A Beacon that is not an owner never sees anyone. */
  pairing: {
    requests(): Promise<import('./join-owner').WaitingRequest[]>
    approve(req: import('./join-owner').ApproveRequest): Promise<import('./join-owner').DecideOutcome>
    deny(requestId: string): Promise<import('./join-owner').DecideOutcome>
    onRequests(cb: (r: import('./join-owner').WaitingRequest[]) => void): Unsubscribe
  }
  /** Setting Prometheus up on this Mac (path A of the v0.4.0 onboarding). */
  pathA: {
    /** Read the facts of this Mac and decide whether Prometheus can be set up here. Downloads nothing. */
    check(): Promise<MacCheckResult>
    /** Open System Settings at Storage, for someone short of room. Resolves whether it was opened. */
    openStorageSettings(): Promise<boolean>
    /** Set Prometheus up on this Mac: get it, check it, put it in Applications, start it, connect. Returns where it stands; a run
     *  already under way (or finished) is returned, not started again. */
    installStart(): Promise<import('./prometheus-app').InstallView>
    /** Stop. Before the app is in Applications, what was downloaded is deleted; after, Prometheus stays installed. */
    installCancel(): Promise<import('./prometheus-app').InstallView>
    onInstallUpdate(cb: (view: import('./prometheus-app').InstallView) => void): Unsubscribe
    /** Open System Settings at Login Items, where Prometheus is switched on. Resolves whether it was opened. */
    openLoginItems(): Promise<boolean>
  }
  capture: {
    /** Quick-capture (Slice 10): hide the mini window and open the main window on a session. */
    openMain(sessionId: string): void
  }
  loop: {
    /** The registered local projects (the board's sidebar). */
    listProjects(): Promise<LoopProject[]>
    /** Persist the registry; resolves the SANITIZED list actually written. */
    saveProjects(projects: LoopProject[]): Promise<LoopProject[]>
    /** Read a CONFINED project file (TASKS.md / LOOP.md / PROGRESS.md under a registered root). */
    readFile(path: string): Promise<LoopFileRead>
    /** Write a CONFINED project file. */
    writeFile(path: string, content: string): Promise<LoopFileWrite>
    /** Open a Markdown picker to drop in a contract from elsewhere (user-consented read). */
    pickFile(): Promise<LoopPickedFile | null>
  }
  integrations: {
    /** Registry + manifest + health per entry (concurrent probes, renderer-safe). */
    status(): Promise<import('./integrations').IntegrationStatus[]>
    /** Persist registry edits; resolves the SANITIZED list actually written. */
    save(entries: import('./integrations').IntegrationEntry[]): Promise<import('./integrations').IntegrationEntry[]>
    /** GET a manifest-declared view endpoint (main resolves base_url + auth). */
    get(integrationId: string, relPath: string): Promise<unknown>
    /** Execute a declared control (method per the manifest). */
    invoke(integrationId: string, relPath: string, method: string): Promise<unknown>
    /** Store (or clear with '') the bearer token for an entry — keychain-encrypted, never echoed back. */
    setToken(integrationId: string, token: string): Promise<void>
    /** Show the integrations file in Finder (an empty one is written first when there is none): the empty state's next step. */
    reveal(): Promise<void>
  }
  /** The browser pane (a HUMAN viewer — see @shared/browser-pane for the invariant). Every method
   * is a control in the pane's chrome; none is reachable from a chat frame. */
  browser: BrowserBridge
  /** Terminal pane — local ptys in main. A HUMAN surface; see @shared/terminal for the invariant. */
  terminal: {
    /** Spawn a session (login shell, or `command` for Phase 4 ssh). null = refused (not a Beacon window
     *  frame); `{ error }` = could not spawn (program missing) — shown in the pane, never thrown. */
    open(req: import('./terminal').TerminalOpenRequest): Promise<import('./terminal').TerminalSession | import('./terminal').TerminalOpenError | null>
    /** Every session main still holds, live or exited. */
    list(): Promise<import('./terminal').TerminalSession[]>
    /** Subscribe this window to a session's output; the reply carries the scrollback replay. */
    attach(id: string, cols: number, rows: number): Promise<import('./terminal').TerminalAttachResult | null>
    detach(id: string): void
    /** THE only pty input: what the pane's xterm emitted (keys, paste). */
    write(id: string, data: string): void
    resize(id: string, cols: number, rows: number): void
    rename(id: string, title: string): Promise<boolean>
    close(id: string): Promise<boolean>
    onData(cb: (m: { id: string; data: string }) => void): Unsubscribe
    onExit(cb: (m: { id: string; exit: import('./terminal').TerminalExit }) => void): Unsubscribe
    /** Detach into a separate window (bounds remembered). Resolves false if refused. */
    popOut(): Promise<boolean>
    /** Close the detached window and bring the pane back into the main window. */
    popIn(): void
    placement(): Promise<import('./terminal').TerminalPlacement>
    /** Reachable tailnet boxes (from the tailscale CLI) + whether ssh can open without a credential prompt. */
    peers(): Promise<import('./tailscale').TailnetStatus>
    onPlacement(cb: (p: import('./terminal').TerminalPlacement) => void): Unsubscribe
  }
  updater: {
    /** Current auto-update state ('disabled' on dev/unpackaged builds). */
    status(): Promise<UpdaterStatus>
    /** Ask the release feed for a new version now. */
    check(): Promise<void>
    /** Quit + install a downloaded update. Resolves false unless one is ready. */
    install(): Promise<boolean>
    /** Every state transition (main → renderer). */
    onStatus(cb: (s: UpdaterStatus) => void): Unsubscribe
  }
  /** Launch at login (@shared/login-item). GET reads live from the OS; SET returns the OS readback.
   *  `supported:false` (Linux, or an unpackaged build) means the switch cannot be honoured and
   *  `reason` says why — the UI renders it disabled rather than as a control that silently no-ops. */
  loginItem: {
    get(): Promise<import('./login-item').LoginItemState>
    set(openAtLogin: boolean): Promise<import('./login-item').LoginItemState>
  }
  /** Settings → Other computers (@shared/network-setting): "Let other computers on my home network connect". get() is the
   *  connected Prometheus's own answer; set() saves and returns the setting read back; restart() waits until Prometheus answers
   *  again as the same computer (up to a minute). */
  network: {
    get(): Promise<import('./network-setting').NetworkRead>
    set(on: boolean): Promise<import('./network-setting').SetOutcome>
    restart(): Promise<import('./network-setting').RestartOutcome>
  }
  /** Settings → Make this Beacon an owner (@shared/owner-promotion): trade `oara pair --owner`'s one-time code for an owner token,
   *  kept in place of the API token. The answer never carries the token. */
  /** Devices → Enrol (0.4.3): whether the pairing code for `host` carries the daemon's TLS pin, asked BEFORE minting. */
  pairPin: {
    decide(host: string): Promise<{ kind: 'plain' } | { kind: 'pinned'; pin: string } | { kind: 'refused'; message: string }>
  }
  ownerPromotion: {
    redeem(code: string): Promise<import('./owner-promotion').OwnerOutcome>
  }
  /** Config → Models → Main model (@shared/main-model). check() and signIn() hold an accepted key in main; save(useNewKey) sends
   *  that key, or none (Prometheus checks the key it holds). Keys go in once (a typed one) and never come back. */
  mainModel: {
    get(): Promise<import('./main-model').MainModelRead>
    check(provider: string, key: string, checkable: boolean): Promise<import('./main-model').CheckOutcome>
    signIn(): Promise<import('./main-model').CheckOutcome>
    cancelSignIn(): Promise<void>
    save(provider: string, version: string, useNewKey: boolean): Promise<import('./main-model').MainModelSave>
  }
  /** O9 (@shared/model-setup): the key steps and the finish. Keys go in once (a pasted one) and never come back. */
  model: {
    signIn(): Promise<import('./model-setup').KeyStep>
    cancelSignIn(): Promise<void>
    checkKey(company: 'anthropic' | 'openai', key: string): Promise<import('./model-setup').KeyStep>
    finish(): Promise<import('./model-setup').ModelSetupView>
    onUpdate(cb: (v: import('./model-setup').ModelSetupView) => void): () => void
  }
  /** Settings → About (@shared/legal-docs). open() names a document, never a path; main opens the file
   *  electron-builder shipped for it in the OS's viewer. */
  legal: {
    open(doc: import('./legal-docs').LegalDoc): Promise<import('./legal-docs').LegalDocResult>
  }
  /** OS light/dark appearance (audit #6). The renderer is sandboxed and cannot read nativeTheme, so
   *  main owns it: get() is the current appearance, onChange pushes every OS flip so a window
   *  wearing the "match system" skin re-skins live. */
  systemTheme: {
    /** Is the OS currently in dark mode? */
    isDark(): Promise<boolean>
    /** Subscribe to OS appearance flips. Fires on every transition while subscribed. */
    onChange(cb: (isDark: boolean) => void): Unsubscribe
  }
}
