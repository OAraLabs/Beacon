import { app, BrowserWindow, Menu, Notification, Tray, globalShortcut, nativeImage, nativeTheme, powerMonitor, screen, session, shell } from 'electron'
import { createHash } from 'crypto'
import { existsSync, mkdirSync } from 'fs'
import { dirname, isAbsolute, join, resolve } from 'path'
import { refusedSwitches } from '@shared/release-gate'
import { buildFlavor, debuggingAllowedHere } from './build-flavor'
import { IPC } from '@shared/ipc'
import { approvalActionTarget, notificationPlan, rawToApproval, type RawApprovalPush } from '@shared/approval-push'
import { coerceArguments, type ApprovalArguments } from '@shared/approval-arguments'
import { describeLoginItem, type LoginItemPlatform } from '@shared/login-item'
import { isLegalDoc, legalDocPath, type LegalDocResult } from '@shared/legal-docs'
import { builtinSpellcheck } from '@shared/spellcheck'
import { quietSpellchecker } from './quiet-spellchecker'
import type {
  ApprovalDecision,
  ApprovalRequest,
  ChatStreamFrame,
  ConnectionSettings,
  ConnectionStatus,
  ConnectionTestRequest,
  ConnectionTestResult,
  PairPollResult,
  PairRequest,
  PairResult,
  SaveConnectionSettingsRequest,
  SaveConnectionSettingsResult,
  SetupProbeRequest,
  SetupForgetResult,
  SetupProbeResult,
  SetupRequest,
  SetupResult,
  SetupStatus,
  UpdaterStatus
} from '@shared/ipc'
import { connectionTestLabel, httpStatusFromError, nextToken, resolveTestToken } from '@shared/daemon-api'
import {
  isValidPairingCode,
  pairPollState,
  pairedGatewayUrls,
  parsePairResponse,
  parseSetupStatusResponse
} from '@shared/pairing'
import { decideStartupRoute } from '@shared/setup-wizard'
import { onboardingV4Visible } from '@shared/onboarding-gate'
import { ONBOARDING_BROWSING_KEY, ONBOARDING_KNOWN_KEY, parseKnown } from '@shared/onboarding'
import { helloTimeoutMs } from '@shared/hello'
import { registerIpcHandlers } from './ipc'
import { registerArtifactRenderProtocol, registerArtifactRenderScheme } from './artifact-protocol'
import { firstDeepLinkInArgv, parseDeepLink } from '@shared/deeplink'
// The web-URL allowlist the browser pane already used. The shell window's
// openExternal derives from the SAME predicate rather than restating a regex,
// so the two surfaces cannot drift into different opinions of what a page is.
import { safeExternalUrl } from '@shared/browser-pane'
import { isPlausibleSessionId } from '@shared/session-windows'
import { MAX_PANES } from '@shared/split-panes'
import { createSessionWindows } from './session-windows'
import { registerSessionWindowHandlers } from './session-window-ipc'
// Every preload-bridged window is adopted: known to the sender check, and
// unable to navigate its top frame away from the shell page.
import { adoptShellWindow, handleFromShell, loadShellPage, onFromShell, shellPreload } from './shell-windows'
import { registerLoopHandlers } from './loop-ipc'
import { registerDiscoveryHandlers } from './discovery-ipc'
import { registerPathAHandlers } from './path-a-ipc'
import { defaultDeviceName } from './pairing/device-name'
import { ModelSetup } from './model-setup'
import { registerModelSetupHandlers } from './model-setup-ipc'
import { CREDENTIAL_KIND_KEY } from '@shared/model-setup'
import { OpenRouterSignIn } from './openrouter'
import { SIGN_IN_WAIT_MS, openrouterEnv } from '@shared/openrouter'
import { registerJoinHandlers } from './join-ipc'
import { NetworkSetting } from './network-setting'
import { registerNetworkSettingHandlers } from './network-setting-ipc'
import { MainModelSetting } from './main-model'
import { registerMainModelHandlers } from './main-model-ipc'
import { OwnerPromotion } from './owner-promotion'
import { registerOwnerPromotionHandlers } from './owner-promotion-ipc'
import { PairPin } from './pair-pin'
import { registerPairPinHandlers } from './pair-pin-ipc'
import { pairTlsPorts } from '@shared/devices'
import { requestSmall, requestWith } from './pairing/http'
import { JoinSession, type SavedConnection } from './pairing/session'
import { PrometheusInstaller, execFileTool, type SavedLocal } from './prometheus-install'
import { installEnv } from '@shared/prometheus-app'
import { discoveryEnv, type Endpoint } from '@shared/discovery'
import { fpFromPin, validFp } from '@shared/daemon-profiles'
import { askHello } from './discovery'
import { macMajor } from '@shared/mac-check'
import { homedir, tmpdir } from 'os'
import { pairingPollMs } from '@shared/join-owner'
import { PairingWatcher } from './pairing/watcher'
import { registerIntegrationsHandlers } from './integrations-ipc'
import { registerVoiceHandlers } from './voice'
import { registerHandsFreeHandlers } from './vad-client'
import { registerScreenshotHandlers } from './screenshot-ipc'
import { registerBrowserPane } from './browser-pane'
import { openPopout } from './popout-window'
import { killAllTerminals, registerTerminalHandlers } from './terminal-ipc'
import { checkForUpdates, getUpdaterStatus, initUpdater, installUpdate } from './updater'
import { proveSqlite } from './sqlite'
import { ConnectionManager, type RoleMemory } from './connection'
import { RestClient } from './connection/rest'
import { probeWsAuth } from './connection/ws-probe'
import { gatewayFromAddress, gatewayFromEndpoint, hasEnvGateway, resolveGateway, type GatewayConfig } from './connection/config'
import { overlayOptionsFrom, TITLEBAR_OVERLAY_HEIGHT, usesWindowControlsOverlay, windowChromeOptions } from '@shared/window-chrome'
import { createRendererRecovery, dialogNotifyStopped } from './renderer-recovery'
import { DaemonFolders, type BeaconStore } from './cache/daemon-folders'
import { CacheService } from './cache/service'
import { CredentialStore, decideStartup, electronSafeStorageCipher, type Cipher } from './credentials'
import { sameOrigin } from '@shared/key-origin'
import {
  INITIAL_PRESENCE,
  applyPresenceEvent,
  deriveTrayStatus,
  gatewayOf,
  shouldNotify,
  TRAY_TOOLTIP,
  type PresenceState
} from './presence'
import { TRAY_TEMPLATE_16, TRAY_TEMPLATE_32, TRAY_SANG_16, TRAY_SANG_32 } from './tray-icon'
import {
  CLOSE_MODE_KEY,
  TRAY_HINT_SHOWN_KEY,
  planClose,
  trayHintNotification,
  type CloseMode
} from '@shared/tray-hint'
import {
  NOTIFY_PREFS_KEY,
  DEFAULT_NOTIFY_PREFS,
  notifyAllowed,
  parseNotifyPrefs,
  serializeNotifyPrefs,
  type NotifyPrefs
} from '@shared/notification-prefs'
import { loadWindowState, MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH, trackWindowState } from './window-state'
import { installContextMenu } from './context-menu'
import { badgeCount, displayedBadgeCount } from '@shared/badge'
import { applyPins, askHelloOverTls, installPinning, isConnectionMismatch, onPinMismatch, pinnedFetch } from './tls-pin'
import { pinnedEdit } from '@shared/pinned-edit'
import { notEncrypted, refusePlain, treatAsHomeNetwork, treatAsPublic } from '@shared/plain-lan'
import { plainPublicRefusal } from './plain-public'

// ── a release build refuses remote debugging (src/shared/release-gate.ts) ────
// First statement of the module body, before the single-instance lock: Chromium opens the
// DevTools socket only after this top-level code has run (measured on Electron 44: ~50 ms after
// it finishes), so exiting here means the port never listens. The flag is read from the asar's
// package.json (build-flavor.ts), written at package time; no environment variable changes it.
{
  const refused = refusedSwitches(buildFlavor(), app.isPackaged, (name) => app.commandLine.hasSwitch(name))
  if (refused.length > 0) {
    console.error(`[release-gate] refused: --${refused.join(', --')} is not available in a release build of Beacon`)
    process.exit(1)
  }
}

// Every fetch in main reaches Prometheus through Node's global dispatcher; from here on that dispatcher holds a home-network
// Prometheus to the key Beacon pinned when it joined (docs/MULTI-COMPUTER-v0.4.md §3.3, src/main/tls-pin.ts). Before any request.
installPinning()
// A probe's loopback stand-in for a home-network address (never in a release build): src/shared/plain-lan.ts.
if (debuggingAllowedHere()) treatAsHomeNetwork((process.env.BEACON_HOME_NETWORK_HOSTS ?? '').split(','))
if (debuggingAllowedHere()) treatAsPublic((process.env.BEACON_PUBLIC_HOSTS ?? '').split(','))

// No main-process exception reaches a native dialog (owner decision, 2026-10-17: a socket timeout put "A JavaScript error occurred in the main
// process" on screen). With a listener present Electron shows none; each is logged with what it was, and the app carries on. The
// causes are still fixed where they happen (src/main/connection/ws-probe.ts); this is the floor under them.
// Named, so a probe can tell them from anyone else's listener (scripts/plain-public-app-probe.mjs).
process.on('uncaughtException', function beaconNoDialogException(err) {
  console.error('[main] uncaught exception (no dialog):', err)
})
process.on('unhandledRejection', function beaconNoDialogRejection(reason) {
  console.error('[main] unhandled rejection (no dialog):', reason)
})
// A pinned Prometheus that answers with another key is told to the page at once (§3.4), named as Beacon knows it.
onPinMismatch((m) => {
  if (!isConnectionMismatch(m)) return // a join's own pinned request to another computer: the join says it, not this card
  let name = m.host
  try {
    const known = parseKnown(repo?.getSetting(ONBOARDING_KNOWN_KEY) ?? null)
    name = Object.keys(known).find((k) => known[k] === m.pinned.slice(0, 16)) ?? m.host
  } catch {
    /* the host will do */
  }
  connection?.setWrongKey({ pinned: m.pinned, presented: m.presented, name })
})

/** Global summon hotkey (Slice 5) — toggle the window from anywhere. */
const SUMMON_ACCELERATOR = 'CommandOrControl+Shift+B'
/** Quick-capture hotkey (Slice 10) — spotlight-style mini composer from anywhere. */
const CAPTURE_ACCELERATOR = 'CommandOrControl+Shift+Space'

const isDev = !app.isPackaged

// The built-in spellchecker is macOS only (@shared/spellcheck): elsewhere it downloads dictionaries from
// Google's CDN unasked. Every window and view passes webPreferences.spellcheck; this also switches the
// spellchecker off on the session of every page created anywhere, so a window that forgets cannot turn it
// back on. smoke:spellcheck pins both.
// That was too late on Linux: a session starts downloading its locale's dictionary from Google's CDN when it is CREATED, before any page
// (a capture of 0.4.4 saw redirector.gvt1.com and rr4---…gvt1.com). So every session is made quiet as it is created: no language, a
// download address on this computer, the checker off (src/main/quiet-spellchecker.ts). Registered here, before ready, so the default
// session is one of them.
if (!builtinSpellcheck(process.platform)) {
  app.on('session-created', quietSpellchecker)
}
if (!builtinSpellcheck(process.platform)) {
  app.on('web-contents-created', (_e, wc) => wc.session.setSpellCheckerEnabled(false))
}

// beacon-artifact:// (rendered artifacts) — privileged-scheme registration is only honoured
// BEFORE app ready, so this runs at module load; the handler itself registers in whenReady.
registerArtifactRenderScheme()

// ── beacon:// deep links + single instance ────────────────────────────────────
// The desktop MINTS beacon://pair for phones (devices.ts); receiving is this. One instance holds
// the lock; a second launch forwards its argv (the Windows/Linux deep-link path) and dies. macOS
// delivers links via 'open-url' instead — registered before ready, since a cold-start link can
// arrive before the window exists; it parks in pendingDeepLink until whenReady flushes it.
let pendingDeepLink: string | null = null
let appReady = false

function handleDeepLink(url: string): void {
  const action = parseDeepLink(url)
  if (!action) return
  if (!appReady || !mainWindow || mainWindow.isDestroyed()) {
    pendingDeepLink = url
    return
  }
  // The log line is load-bearing for verification: refusals must be provable, not just visible.
  console.log(`[deeplink] ${action.kind}${action.kind === 'refused' ? `: ${action.reason}` : ` session=${action.sessionId}`}`)
  if (action.kind === 'open') showSession(action.sessionId)
  else {
    showWindow()
    notify('Link not opened', `${action.reason} (${url.slice(0, 80)})`, '')
  }
}

const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    showWindow()
    const url = firstDeepLinkInArgv(argv)
    if (url) handleDeepLink(url)
  })
}
app.on('open-url', (e, url) => {
  e.preventDefault()
  handleDeepLink(url)
})

// The connection + cache live in the main process and outlive any window (spec §3.2/§3.3). The
// connection is (re)built by bringUpConnection — at startup if configured, or on first-run save.
let connection: ConnectionManager | null = null
/**
 * The live link: the gateway `connection` was brought up with and the key it uses there, set TOGETHER and only once the address may be
 * used (null until then, and while there is none). Every module that talks to "the connected Prometheus" with a key (the network and
 * main-model settings, the pin, the owner promotion, model setup) reads both from this one value, so its address and its key can never
 * come from two different moments, or two different Prometheus (docs/MULTI-PROMETHEUS.md §2 rule 2).
 */
let connectedLink: { gateway: GatewayConfig; token: string | null } | null = null
let cache: CacheService | null = null
let folders: DaemonFolders | null = null
/** Settings (routed by key), the saved connection and the diagnostic tables: `folders` itself, as BeaconStore. */
let repo: BeaconStore | null = null
/** The keychain-backed cipher every key file is sealed with (one Keychain item for all of them, as before). */
let keyCipher: Cipher | null = null

/** The key file of the Prometheus whose folder is `id`: only ever read for that Prometheus (docs/MULTI-PROMETHEUS.md §3). */
function keyFile(id: string): CredentialStore {
  const path = folders!.keyPath(id)
  mkdirSync(dirname(path), { recursive: true })
  return new CredentialStore(path, keyCipher!)
}

/** Where a save keeps the key for the Prometheus at this gateway: the folder bringUpConnection will open for it. */
function keyFor(gw: { apiBase: string; pin?: string | null }): CredentialStore {
  return keyFile(folders!.folderFor({ apiBase: gw.apiBase, fp: fpFromPin(gw.pin) }))
}

/** The open folder's key, or null with no Prometheus open. */
function currentKey(): CredentialStore | null {
  const id = folders?.currentId()
  return id ? keyFile(id) : null
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
// Session windows (@shared/session-windows): conversations popped out into their own OS windows.
const sessionWindows = createSessionWindows({
  isQuitting: () => isQuitting,
  onChange: (ids) => broadcast(IPC.SESSION_WINDOWS_CHANGED, ids)
})
/** Show a session: in its own window when it has one (one place at a time), else in the main window. */
function showSession(sessionId: string): void {
  if (sessionWindows.focus(sessionId)) return
  showWindow()
  broadcast(IPC.SESSION_SWITCH, sessionId)
}
let presence: PresenceState = INITIAL_PRESENCE
let activeSessionId: string | null = null
/** Every session on screen in the main window (split panes). */
let visibleSessionIds: string[] = []
let prevConnState: ConnectionStatus['state'] = 'idle'
let pendingApprovals = 0 // renderer-reported (Slice 9) — tray badge/menu line
const streamBuf = new Map<string, string>()

// ── notification preferences (@shared/notification-prefs) ────────────────────
// The durable copy of the user's per-kind switches, loaded once at startup and refreshed by the
// settings IPC. Main is the one notification authority, so the gate has to live here — a renderer-only
// toggle would not reach the approval notification that fires from the WS frame path. Defaulted to
// "everything on" so a missing or unreadable row restores today's behavior, never a silent mute.
let notifyPrefs: NotifyPrefs = { ...DEFAULT_NOTIFY_PREFS }

function loadNotifyPrefs(): void {
  notifyPrefs = parseNotifyPrefs(repo?.getSetting(NOTIFY_PREFS_KEY) ?? null)
}

// ── close-to-tray choice (@shared/tray-hint) ─────────────────────────────────
// What the ✕ button means for the MAIN window, and whether we've taught the first-time hint. Loaded
// once at startup, written by the settings IPC and by the hint itself. The capture/popout windows
// keep their own unconditional hide — they are transient boxes with no session and no connection to
// preserve, so a per-window setting there would be ceremony, not choice.
let closeToTray = true // default: today's behavior — ✕ hides, the connection survives

function loadCloseMode(): void {
  const raw = repo?.getSetting(CLOSE_MODE_KEY)
  closeToTray = raw !== 'quit' // anything other than an explicit 'quit' means hide
}


function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    // Skip windows whose render frame is gone (closing / mid-HMR-reload) — otherwise webContents.send
    // throws "Render frame was disposed before WebFrameMain could be accessed". The gateway-event
    // stream (Phase 5a) makes this fire often during reconnects.
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function windowFocused(): boolean {
  return !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function toggleWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide()
  else showWindow()
}

// ── connection lifecycle ──────────────────────────────────────────────────────
/** The last role (owner or approved device, ConnectionStatus.role) for this address and key, in one setting: an approved device then
 *  opens on the note and not on a refusal it would read before GET /api/devices answers. The key is never kept: only a hash of the two,
 *  which a new key or a new address no longer matches (a promotion asks again). */
const DEVICE_ROLE_KEY = 'connection.deviceRole'
function roleMemory(gw: GatewayConfig, token: string | null): RoleMemory {
  const id = createHash('sha256').update(`${gw.apiBase}\n${token ?? ''}`).digest('hex').slice(0, 32)
  return {
    recall: () => {
      const [k, role] = (repo?.getSetting(DEVICE_ROLE_KEY) ?? '').split(' ')
      return k === id && (role === 'owner' || role === 'limited') ? role : null
    },
    remember: (role) => {
      try {
        repo?.setSetting(DEVICE_ROLE_KEY, `${id} ${role}`)
      } catch {
        /* a role not remembered is asked again next time */
      }
    }
  }
}

/** (Re)build the connection + cache for a gateway + optional token. Idempotent — tears down any
 * existing connection first, so it's safe at startup AND on first-run / re-config.
 *
 * The cache is that Prometheus's own folder (docs/MULTI-PROMETHEUS.md §3). `knownFp` is its instance fingerprint when already
 * known (hello's, on a rebind); a pinned profile's comes from its pin. Without either, the folder last used at this address is
 * opened HELD until hello says who answers there (confirmIdentity). */
function bringUpConnection(gw: GatewayConfig, knownFp: string | null = null): void {
  if (connection) {
    connection.removeAllListeners()
    connection.stop()
  }
  presence = applyPresenceEvent(INITIAL_PRESENCE, { type: 'conn', state: 'idle' })
  // The token now authenticates the WS too (daemon >= dbcce28 requires first-frame auth); the
  // ConnectionManager always sends it when a token exists, so there's no capability flag to read.
  // Socket lifecycle → beacon.db. The console lines this supplements are discarded
  // in a packaged launch, which is how a 2026-08-16 approval produced six findings
  // that all reduce to one unanswered question — was the socket terminated, or did
  // it stay connected and never receive — with no record on either end.
  // `repo` is captured, not `repo!`: a lifecycle event that arrives before the
  // cache is ready is dropped rather than crashing the connection it describes.
  applyPins(gw) // this profile's pin, or none: the REST and WebSocket traffic below goes through it
  // Plain to the internet is refused outright, a saved connection included (src/main/plain-public.ts): until that is answered nothing is
  // sent, and the address is not published to the modules that talk to it with the key (the network and main-model settings, the pin,
  // the owner promotion), so they see "not connected" rather than send in plain.
  const gate = plainPublicRefusal(gw.apiBase, gw.wsUrl)
  // That Prometheus's folder first, then ITS key: a key is read only from the folder of the Prometheus it was saved for.
  const fp = knownFp ?? fpFromPin(gw.pin)
  const before = folders!.currentId()
  const folder = folders!.open({ apiBase: gw.apiBase, fp })
  const token = keyFile(folder.id).getToken()
  const conn = new ConnectionManager(gw, token, false, (e) => repo?.recordSocketEvent(e), roleMemory(gw, token), gate)
  connection = conn
  connectedLink = null
  void gate.then((refused) => {
    if (refused || connection !== conn) return
    connectedLink = { gateway: gw, token }
  })
  connection.on('status', onStatus)
  connection.on('stream', onStreamFrame)
  connection.on('gatewayEvent', (ev) => {
    // A pairing frame names a device and an address. The watcher takes it, and it goes nowhere else: not the activity feed, not a notification.
    if (pairingWatcher.takesFrame(ev.type, ev.payload, typeof ev.ts === 'number' ? ev.ts / 1000 : undefined)) return
    broadcast(IPC.GATEWAY_EVENT, ev)
    maybeNotifyTask(ev as { type?: string; payload?: Record<string, unknown> })
    handleApprovalFrame(conn, ev as { type?: string; payload?: Record<string, unknown> })
  })
  cache = new CacheService(folder.repo, connection, { held: fp === null })
  cache.attach()
  if (fp === null) confirmIdentity(conn, cache, gw, folder.id)
  if (before !== null && before !== folder.id) broadcast(IPC.CACHE_FOLDER_CHANGED, null)
  connection.start()
  pairingWatcher.reset() // a new connection may be a different computer, or a different kind of device
  pairingWatcher.start()
  updateTray()
}

/** How often a held cache asks hello again while its connection stays up and hello has not answered. */
const IDENTITY_RETRY_MS = 30_000

/**
 * A plain connection's Prometheus says who it is (docs/MULTI-PROMETHEUS.md §2): hello, with no key, once the connection is up.
 * The same Prometheus the folder belongs to (or a folder no fp was bound to yet): the cache is released and catches up. Another
 * one: its own folder is opened instead, and the app remounts. Until then the cache stays held: nothing from this connection is
 * written into the folder and nothing queued in it is sent. Only an unreachable hello keeps it held, asked again on each reconnect
 * and every 30 s while connected; an answer with no fp releases it, as before folders existed.
 */
function confirmIdentity(conn: ConnectionManager, held: CacheService, gw: GatewayConfig, folderId: string): void {
  let asking = false
  let retry: NodeJS.Timeout | null = null
  const ask = async (): Promise<void> => {
    if (asking || connection !== conn || !held.isHeld()) return
    asking = true
    try {
      const ep = endpointOf(gw.apiBase)
      const hello = ep ? await askHello(ep) : 'unreachable'
      if (connection !== conn || !held.isHeld()) return
      if (hello === 'not-prometheus' || (typeof hello !== 'string' && !validFp(hello.fp))) {
        // Something answers there, but not with an fp (a Prometheus too old to say it, or a hello it does not serve): nothing to tell
        // it apart by, so the folder at its address is taken as its own, as before folders existed.
        console.warn('[cache] this Prometheus does not say its instance fingerprint; using the folder at its address')
        held.release()
        return
      }
      if (typeof hello === 'string') {
        if (retry === null && conn.getStatus().state === 'connected') {
          retry = setTimeout(() => {
            retry = null
            void ask()
          }, IDENTITY_RETRY_MS)
        }
        return
      }
      const home = folders!.bind(folderId, hello.fp)
      if (home === folderId) held.release()
      else {
        console.info(`[cache] a different Prometheus answers at ${hostOf(gw.apiBase)}; opening its own folder`)
        bringUpConnection(gw, hello.fp)
      }
    } finally {
      asking = false
    }
  }
  conn.on('status', (s: ConnectionStatus) => {
    if (s.state === 'connected') void ask()
  })
}

/** host:port out of a REST base, for hello. */
function endpointOf(apiBase: string): Endpoint | null {
  try {
    const u = new URL(apiBase)
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80))
    return { host: u.hostname.replace(/^\[|\]$/g, ''), port }
  } catch {
    return null
  }
}

/**
 * Sleep/wake recovery. Suspending the machine kills the WS without a `close`
 * event, so the socket comes back half-open. The socket's own liveness probe
 * eventually catches that, but waiting out the staleness window on every lid
 * open is a visible stall — redialing immediately on resume makes the app
 * usable the moment the screen is on. Safe to call when already healthy:
 * `reconnect()` just drops and redials, resetting backoff.
 */
function watchPowerEvents(): void {
  powerMonitor.on('resume', () => {
    console.info('[power] resume — redialing the gateway socket')
    connection?.reconnect()
  })
}

/** Setup or app (@shared/setup-wizard decideStartupRoute). With a connection saved, ask its
 * Prometheus once whether it is still in setup mode — the only fact that says a setup stopped
 * part-way. Bounded at 2 s: an unreachable Prometheus opens the app (which says so), it never
 * holds the window on "Loading…". */
async function setupStatus(): Promise<SetupStatus> {
  const profile = repo?.getDefaultGatewayProfile() ?? null
  const currentAddress = profile ? hostOf(profile.apiBase) : undefined
  const probe = connection ? await probeSetupAt((profile ?? resolveGateway()).apiBase, 2_000) : null
  const here = currentAddress === '127.0.0.1' || currentAddress === 'localhost'
  const credential = repo?.getSetting(CREDENTIAL_KIND_KEY) ?? null
  const route = decideStartupRoute({ hasConnection: connection !== null, probe, hasCredential: currentKey()?.hasToken() ?? false, credential, thisMac: here })
  // The v0.4.0 first run is closed in a release build whatever the environment says (@shared/onboarding-gate).
  const onboarding = onboardingV4Visible({ flavor: buildFlavor(), isPackaged: app.isPackaged, env: process.env.BEACON_ONBOARDING })
  const localNetworkPrompt = process.platform === 'darwin'
  const hello = helloTimeoutMs(process.env, debuggingAllowedHere())
  if (route.kind === 'app') return { needsSetup: false, currentAddress, onboarding, localNetworkPrompt, helloTimeoutMs: hello }
  // The master token is still what Beacon holds for a configured Prometheus on this Mac: A5 reopens to finish the owner trade.
  if (route.kind === 'trade') return { needsSetup: true, currentAddress, onboarding, localNetworkPrompt, helloTimeoutMs: hello, resume: { configured: true, paired: true, here: true, trade: true } }
  if (route.kind === 'resume') return { needsSetup: true, currentAddress, onboarding, localNetworkPrompt, helloTimeoutMs: hello, resume: { configured: route.configured, paired: route.paired, here } }
  return { needsSetup: true, currentAddress, onboarding, localNetworkPrompt, helloTimeoutMs: hello }
}

/** Start over / Set up again: drop the connection and forget the saved address and the stored
 * credential, so the next status() is a fresh first run. Nothing is sent to Prometheus. */
function forgetConnection(): SetupForgetResult {
  try {
    if (connection) {
      connection.removeAllListeners()
      connection.stop()
      connection = null
    }
    applyPins(null)
    connectedLink = null
    cache = null
    currentKey()?.clear() // that Prometheus's key, before its folder is let go
    folders?.closeCurrent() // the conversations stay in their folder; nothing of theirs shows while no Prometheus is saved
    pairingWatcher.reset()
    repo?.deleteGatewayProfiles()
    repo?.setSetting(CREDENTIAL_KIND_KEY, '') // no credential, so nothing to trade
    // A new first run: a "Not now" from the last one must not decide where it opens (@shared/onboarding).
    repo?.setSetting(ONBOARDING_BROWSING_KEY, '0')
    onStatus({ state: 'idle', gateway: null }) // the chips, the tray and presence stop showing the old link
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

async function saveSetup(req: SetupRequest): Promise<SetupResult> {
  try {
    const address = (req.address ?? '').trim()
    if (!address) return { ok: false, error: 'Gateway address is required.' }
    // The ports it was found on are kept; with none given this is gatewayFromAddress's fixed 8005/8010.
    const gw = gatewayFromEndpoint(address, { apiPort: req.apiPort, wsPort: req.wsPort })
    if (!gw) return { ok: false, error: 'That address or port is not valid.' }
    const plainRefused = refusePlain(gw.apiBase, gw.wsUrl, repo?.getDefaultGatewayProfile() ?? null) // no new plain to the home network
    if (plainRefused) return { ok: false, error: plainRefused }
    const publicRefused = await plainPublicRefusal(gw.apiBase, gw.wsUrl) // and none to the internet, ever
    if (publicRefused) return { ok: false, error: publicRefused }
    repo!.upsertGatewayProfile(gw.name, gw.apiBase, gw.wsUrl, true) // address → app-data (never source)
    keyFor(gw).setToken(req.token ?? '') // token → this Prometheus's key file, sealed by the OS keychain (or cleared if blank)
    repo!.setSetting(CREDENTIAL_KIND_KEY, '') // typed in, not the master token A-inst kept
    bringUpConnection(gw)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

// ── joining a Prometheus that already has an owner (onboarding path B) ───────────────────────────
let joinedGateway: GatewayConfig | null = null

/** Keep a connection that arrived by approval: the token in the OS keychain (the same entry every other way of connecting
 *  writes), the address in the gateway profile, the computer in the "known" list so a later change of identity is noticed.
 *  Throws when the connection could not be kept, and then leaves nothing half done (the old token is put back). */
function saveJoinedConnection(c: SavedConnection): void {
  const key = keyFor(c.gateway)
  const before = key.getToken()
  try {
    key.setToken(c.token)
    repo!.upsertGatewayProfile(c.gateway.name, c.gateway.apiBase, c.gateway.wsUrl, true, c.gateway.pin ?? null)
    repo!.setSetting(CREDENTIAL_KIND_KEY, '') // an approved device's credential: no trade owed
  } catch (err) {
    try {
      key.setToken(before ?? '')
    } catch {
      /* the original error is the one to report */
    }
    throw err
  }
  joinedGateway = c.gateway
  try {
    if (c.fp) {
      const known = parseKnown(repo!.getSetting(ONBOARDING_KNOWN_KEY))
      known[c.computerName] = c.fp
      repo!.setSetting(ONBOARDING_KNOWN_KEY, JSON.stringify(known))
    }
  } catch {
    // The connection is kept; only the memory of this computer's identity is not.
  }
}

const joinSession = new JoinSession({
  request: requestSmall,
  // A home-network Prometheus over TLS: hello with no pin to learn its key, then every request of the join pinned to it.
  helloOverTls: (host, port) => askHelloOverTls(host, port),
  pinnedRequest: (pin) => requestWith(pinnedFetch(pin)),
  now: () => Date.now(),
  save: saveJoinedConnection,
  activate: () => {
    if (joinedGateway) bringUpConnection(joinedGateway)
  }
})

// ── setting Prometheus up on this Mac (onboarding path A) ─────────────────────────────────────────────────────────────────────
let localGateway: GatewayConfig | null = null

/** Keep the connection to the Prometheus Beacon has just set up on this Mac: the token in the OS keychain (the entry every way of
 *  connecting writes), the address in the gateway profile. Throws when it could not be kept, and then puts the old token back. */
function saveLocalConnection(c: SavedLocal): void {
  const key = keyFor(c.gateway)
  const before = key.getToken()
  const kindBefore = repo!.getSetting(CREDENTIAL_KIND_KEY) ?? ''
  try {
    // The master token is marked BEFORE it is kept, an owner credential AFTER: a stop between the two is then a trade owed (which
    // asks the daemon again), never the master token marked as an owner credential, which would open the app with it.
    if (c.credential === 'master') repo!.setSetting(CREDENTIAL_KIND_KEY, 'master')
    key.setToken(c.token)
    repo!.upsertGatewayProfile(c.gateway.name, c.gateway.apiBase, c.gateway.wsUrl, true, c.gateway.pin ?? null)
    if (c.credential === 'owner') repo!.setSetting(CREDENTIAL_KIND_KEY, 'owner')
  } catch (err) {
    try {
      key.setToken(before ?? '')
      repo!.setSetting(CREDENTIAL_KIND_KEY, kindBefore)
    } catch {
      /* the original error is the one to report */
    }
    throw err
  }
  localGateway = c.gateway
}

// A dev or probe build may point the release, the home folder, the launcher and the port elsewhere; a release build never (@shared/prometheus-app).
const prometheusInstaller = new PrometheusInstaller({
  env: installEnv(process.env, debuggingAllowedHere()),
  port: discoveryEnv(process.env, debuggingAllowedHere()).port,
  home: homedir(),
  tmp: tmpdir(),
  macosMajor: process.platform === 'darwin' ? macMajor(process.getSystemVersion?.() ?? null) : null,
  macosVersion: process.platform === 'darwin' ? (process.getSystemVersion?.() ?? null) : null,
  fetch: (url, init) => fetch(url, init),
  exec: execFileTool,
  request: requestSmall,
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  save: saveLocalConnection,
  activate: () => {
    if (localGateway) bringUpConnection(localGateway)
  },
  publish: (view) => broadcast(IPC.PATHA_INSTALL_UPDATE, view)
})

// Settings → Other computers: the home-network switch on whichever Prometheus Beacon is connected to, with the credential it holds.
const networkSetting = new NetworkSetting({
  base: () => connectedLink?.gateway.apiBase ?? null,
  token: () => connectedLink?.token ?? null,
  request: requestSmall,
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms))
})
// O9, how the assistant thinks: the key check, configure and complete with the setup credential A-inst kept, then the owner trade
// (the same pairing A-inst ends with). The launcher, the secret's path and the port are A-inst's, so a probe's stand-ins apply here too.
const modelSetup = new ModelSetup({
  port: discoveryEnv(process.env, debuggingAllowedHere()).port,
  // The live link's key, with its address (connectedLink): the one Prometheus being set up on this Mac, which save() and activate() just
  // brought up. Shared with local-first's ModelSetup work: see docs/MULTI-PROMETHEUS.md §10.
  masterToken: () => connectedLink?.token ?? null,
  request: requestSmall,
  exec: execFileTool,
  launcher: prometheusInstaller.launcher,
  launcherEnv: prometheusInstaller.launcherEnv(),
  secretPath: prometheusInstaller.secretPath,
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  save: saveLocalConnection,
  activate: () => {
    if (localGateway) bringUpConnection(localGateway)
  },
  publish: (view) => broadcast(IPC.MODEL_UPDATE, view)
})
const newOpenRouterSignIn = async (): Promise<OpenRouterSignIn> =>
  new OpenRouterSignIn({
    // A dev or probe build may sign in at a stub on this Mac; a release build always at openrouter.ai (@shared/openrouter).
    base: openrouterEnv(process.env, debuggingAllowedHere()).base,
    openExternal: (url) => shell.openExternal(url),
    fetch: (url, init) => fetch(url, init),
    waitMs: SIGN_IN_WAIT_MS,
    label: `Prometheus on ${await defaultDeviceName()}`
  })
// Devices → Enrol (0.4.3): the pairing code carries the daemon's TLS pin when it serves TLS, from the pinned profile or GET /api/network,
// checked against what the code's host presents on the ports Beacon for iOS dials.
const pairPin = new PairPin({
  profilePin: () => connectedLink?.gateway.pin ?? null,
  base: () => connectedLink?.gateway.apiBase ?? null,
  token: () => connectedLink?.token ?? null,
  request: requestSmall,
  ports: pairTlsPorts(process.env, debuggingAllowedHere())
})
// Settings → Make this Beacon an owner (Prometheus #748): the owner token from a one-time code replaces the credential Beacon held (the
// API token, on a Beacon on another computer), in the one keychain entry; then the connection comes up again with it.
const ownerPromotion = new OwnerPromotion({
  base: () => connectedLink?.gateway.apiBase ?? null,
  request: requestSmall,
  deviceName: () => defaultDeviceName(),
  platform: process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux',
  keep: (token) => {
    const gw = connectedLink?.gateway
    if (!gw) throw new Error('not connected')
    const key = keyFor(gw)
    const before = key.getToken()
    const kindBefore = repo!.getSetting(CREDENTIAL_KIND_KEY) ?? ''
    try {
      key.setToken(token)
      repo!.setSetting(CREDENTIAL_KIND_KEY, 'owner')
    } catch (err) {
      try {
        key.setToken(before ?? '')
        repo!.setSetting(CREDENTIAL_KIND_KEY, kindBefore)
      } catch {
        /* the original error is the one to report */
      }
      throw err
    }
    bringUpConnection(gw)
  }
})
// Config → Models → Main model: the connected Prometheus's AI choice, with the same OpenRouter sign-in as setup.
const mainModelSetting = new MainModelSetting({
  base: () => connectedLink?.gateway.apiBase ?? null,
  token: () => connectedLink?.token ?? null,
  request: requestSmall,
  newSignIn: newOpenRouterSignIn
})

// The owner's side of joining: who is waiting for this Prometheus's owner to say yes. It runs whenever a connection is up; a Beacon that is
// not an owner is told 403 and the watcher stops asking. Its answers go to the page; a pairing frame goes ONLY here (see the gatewayEvent
// handler in bringUpConnection).
const pairingWatcher = new PairingWatcher({
  list: async () => {
    try {
      return connection ? await connection.listPairRequests() : 'unreachable'
    } catch {
      return 'unreachable'
    }
  },
  decide: async (requestId, verb, body) => {
    try {
      return connection ? await connection.decidePairRequest(requestId, verb, body) : 'unreachable'
    } catch {
      return 'unreachable'
    }
  },
  now: () => Date.now(),
  schedule: (fn, ms) => {
    const t = setTimeout(fn, ms)
    return () => clearTimeout(t)
  },
  publish: (requests) => broadcast(IPC.PAIRING_REQUESTS, requests),
  // A probe may turn asking off, so that only the daemon's frames can show a request; a release build always asks (@shared/join-owner).
  pollMs: pairingPollMs(process.env, debuggingAllowedHere())
})

function hostOf(apiBase: string): string {
  return apiBase.replace(/^[a-z]+:\/\//i, '').replace(/:\d+.*$/, '')
}

// ── first-run pairing (Onboarding Phase 1) ────────────────────────────────────
/** Exchange a setup-mode 6-digit code for the real API token (POST /api/setup/pair), then store the
 * address via the SAME gateway-profile save and the token via the SAME keychain path as saveSetup —
 * one credential store, and the token never reaches the renderer. */
async function pairWithCode(req: PairRequest): Promise<PairResult> {
  const address = (req.address ?? '').trim()
  const code = (req.code ?? '').trim()
  if (!address) return { ok: false, error: 'Gateway address is required.' }
  if (!isValidPairingCode(code)) return { ok: false, error: 'The pairing code is exactly 6 digits.' }
  const gw = gatewayFromAddress(address)
  // The code would go in plain: not to the home network (src/shared/plain-lan.ts).
  const plainRefused = refusePlain(gw.apiBase, gw.wsUrl, repo?.getDefaultGatewayProfile() ?? null)
  if (plainRefused) return { ok: false, error: plainRefused }
  const publicRefused = await plainPublicRefusal(gw.apiBase, gw.wsUrl) // the answer is the key, in plain: never across the internet
  if (publicRefused) return { ok: false, error: publicRefused }
  let outcome: ReturnType<typeof parsePairResponse>
  try {
    const res = await fetch(`${gw.apiBase}/api/setup/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(8_000)
    })
    outcome = parsePairResponse(res.status, await res.json().catch(() => null))
  } catch {
    outcome = parsePairResponse(0, null) // 'Could not reach the gateway'
  }
  if (outcome.kind !== 'paired') {
    return {
      ok: false,
      error: outcome.label,
      ...(outcome.kind === 'invalid-code' && outcome.attemptsRemaining !== null
        ? { attemptsRemaining: outcome.attemptsRemaining }
        : {}),
      ...(outcome.kind === 'locked' || (outcome.kind === 'invalid-code' && outcome.attemptsRemaining === 0)
        ? { locked: true }
        : {})
    }
  }
  try {
    // Honor the ports the daemon reported (defaults 8005/8010 when absent).
    const urls = pairedGatewayUrls(address, outcome)
    repo!.upsertGatewayProfile(gw.name, urls.apiBase, urls.wsUrl, true) // address → app-data (never source)
    keyFor({ apiBase: urls.apiBase }).setToken(outcome.token) // token → this Prometheus's key file, as saveSetup keeps it
    repo!.setSetting(CREDENTIAL_KIND_KEY, '') // the old wizard's pairing: not a trade the new flow owes
    bringUpConnection({ name: gw.name, apiBase: urls.apiBase, wsUrl: urls.wsUrl })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** One post-pair poll tick: GET /api/setup/status (no auth) to see if the daemon is still in setup
 * mode, falling back to an authed GET /api/status — 200 there is the ONLY 'ready' signal. The
 * renderer calls this every ~PAIR_POLL_INTERVAL_MS until 'ready', then proceeds like a normal connect. */
async function pairPoll(): Promise<PairPollResult> {
  const profile = repo?.getDefaultGatewayProfile()
  if (!profile) return { state: 'waiting' }
  // Plain to the internet is never asked, the key least of all (src/main/plain-public.ts).
  if (await plainPublicRefusal(profile.apiBase, profile.wsUrl)) return { state: 'waiting' }
  let setupMode: boolean | null = null
  try {
    const res = await fetch(`${profile.apiBase}/api/setup/status`, { signal: AbortSignal.timeout(2_500) })
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as { setup_mode?: unknown } | null
      setupMode = body?.setup_mode === true
    } else {
      setupMode = false // reachable, but no setup surface → likely the real daemon already
    }
  } catch {
    setupMode = null // unreachable — probably the restart gap; keep waiting
  }
  let apiStatusOk = false
  try {
    const token = keyFor(profile).getToken()
    const res = await fetch(`${profile.apiBase}/api/status`, {
      redirect: 'error', // the key goes to this address, and nowhere it points at
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(2_500)
    })
    apiStatusOk = res.status === 200
  } catch {
    apiStatusOk = false
  }
  if (pairPollState({ setupMode, apiStatusOk }) === 'ready') return { state: 'ready' }
  return { state: setupMode === true ? 'setup' : 'waiting' }
}

/** Wizard Connect diagnosis (Phase 2): GET /api/setup/status on the TYPED address — nothing is
 * saved. Lets the wizard tell "daemon in setup mode → pair with a code" apart from unreachable /
 * auth-rejected / already-configured (those come from connection.test). */
async function probeSetup(req: SetupProbeRequest): Promise<SetupProbeResult> {
  const address = (req.address ?? '').trim()
  if (!address) return { reachable: false, setupMode: false, configured: false }
  return probeSetupAt(gatewayFromAddress(address).apiBase, 3_000)
}

/** GET /api/setup/status (no auth) at one REST base. Shared by the wizard's Connect probe and the
 * launch-time setup-or-app decision. */
async function probeSetupAt(apiBase: string, timeoutMs: number): Promise<SetupProbeResult> {
  // Not asked in plain across the internet either (src/main/plain-public.ts): to the launch decision that is a computer that is not
  // there, and the connection's own refusal says why.
  if (await plainPublicRefusal(apiBase, apiBase.replace(/^http/, 'ws'))) return { reachable: false, setupMode: false, configured: false }
  try {
    const res = await fetch(`${apiBase}/api/setup/status`, { signal: AbortSignal.timeout(timeoutMs) })
    const probe = parseSetupStatusResponse(res.status, await res.json().catch(() => null))
    if (probe === null) return { reachable: true, setupMode: false, configured: false }
    return {
      reachable: true,
      setupMode: probe.setupMode,
      configured: probe.configured,
      ...(probe.pairing !== null ? { pairing: probe.pairing } : {})
    }
  } catch {
    return { reachable: false, setupMode: false, configured: false }
  }
}

// ── post-setup connection settings (⌘,) ────────────────────────────────────────
/** Current gateway URLs + whether a token is saved. The token VALUE never leaves the keychain. */
function getConnectionSettings(): ConnectionSettings {
  const profile = repo?.getDefaultGatewayProfile() ?? null
  const gw = profile ?? resolveGateway()
  return { apiBase: gw.apiBase, wsUrl: gw.wsUrl, hasToken: currentKey()?.hasToken() ?? false, notEncrypted: notEncrypted(gw.apiBase, gw.wsUrl) }
}

/** Persist the URLs + token to the SAME store first-run uses (one credential store), rebuild the
 * connection, then re-test GET /api/status with the new token for real inline feedback. */
async function saveConnectionSettings(req: SaveConnectionSettingsRequest): Promise<SaveConnectionSettingsResult> {
  try {
    const apiBase = (req.apiBase ?? '').trim()
    const wsUrl = (req.wsUrl ?? '').trim()
    if (!apiBase || !wsUrl) return { saved: false, error: 'Both the REST URL and WS URL are required.' }
    const current = repo?.getDefaultGatewayProfile() ?? null
    // A pinned connection keeps its pin and stays https/wss: saving the form is never a way around the card (§3.3, §3.4).
    const edit = pinnedEdit(current?.pin, apiBase, wsUrl)
    if (!edit.ok) return { saved: false, error: edit.error }
    const plainRefused = refusePlain(apiBase, wsUrl, current) // the saved one may be re-saved; a new plain one to the home network not
    if (plainRefused) return { saved: false, error: plainRefused }
    const publicRefused = await plainPublicRefusal(apiBase, wsUrl) // plain to the internet: not even the saved one
    if (publicRefused) return { saved: false, error: publicRefused }
    const name = current?.name ?? 'mini'
    repo!.upsertGatewayProfile(name, apiBase, wsUrl, true, edit.pin)
    // A new address for the same Prometheus: its folder, key and all, moves with it (hello there still has the last word).
    const open = folders!.currentId()
    if (open && current && apiBase !== current.apiBase) folders!.moveAddress(open, apiBase)
    const key = open ? keyFile(open) : keyFor({ apiBase, pin: edit.pin })
    const token = nextToken(key.getToken(), { token: req.token, clearToken: req.clearToken })
    if (token !== key.getToken()) repo!.setSetting(CREDENTIAL_KIND_KEY, '') // a credential typed in Settings: not the master token A-inst kept
    key.setToken(token ?? '') // that Prometheus's own key file — never a second store
    bringUpConnection({ name, apiBase, wsUrl, pin: edit.pin })
    const ws = await probeWsAuth(wsUrl, token)
    try {
      await connection!.getDaemon('/api/status')
      return { saved: true, test: { ok: true, label: connectionTestLabel(true, null), ws } }
    } catch (e) {
      const code = httpStatusFromError(e)
      return { saved: true, test: { ok: false, code: code ?? undefined, label: connectionTestLabel(false, code), ws } }
    }
  } catch (err) {
    return { saved: false, error: (err as Error).message }
  }
}

/** No-save connection test (the Settings "Test" button): probe GET /api/status with the FORM's
 * values — typed token wins, useSavedToken=false previews Clear-token — without persisting or
 * touching the live connection. An ad-hoc RestClient, not `connection`, so a bad form can't
 * disturb a good link. */
async function testConnection(req: ConnectionTestRequest): Promise<ConnectionTestResult> {
  const fallback = repo?.getDefaultGatewayProfile() ?? resolveGateway()
  const apiBase = (req.apiBase ?? '').trim() || fallback.apiBase
  const wsUrl = (req.wsUrl ?? '').trim() || fallback.wsUrl
  // The saved key is that Prometheus's: it goes with a test of the saved address only. A test of another address sends a key only if
  // one is typed for it (docs/MULTI-PROMETHEUS.md §8).
  const saved = repo?.getDefaultGatewayProfile() ?? null
  const token = resolveTestToken(saved && sameOrigin(apiBase, saved.apiBase) ? (currentKey()?.getToken() ?? null) : null, req)
  // A test sends the token: not in plain to a new home-network address (src/shared/plain-lan.ts).
  const plainRefused = refusePlain(apiBase, wsUrl, repo?.getDefaultGatewayProfile() ?? null)
  if (plainRefused) return { ok: false, label: plainRefused }
  const publicRefused = await plainPublicRefusal(apiBase, wsUrl) // nor in plain to the internet
  if (publicRefused) return { ok: false, label: publicRefused }
  // Probe BOTH transports with the same token, concurrently: REST GET /api/status (bearer header)
  // and the WS first-frame-auth handshake (Phase A). Reported as distinct sub-results so a gateway
  // that passes one and fails the other (e.g. a wrong WS URL) is legible, not a single muddy verdict.
  const [rest, ws] = await Promise.all([
    new RestClient(apiBase, token)
      .getDaemon('/api/status')
      .then(() => ({ ok: true, label: connectionTestLabel(true, null) }) as ConnectionTestResult)
      .catch((e) => {
        const code = httpStatusFromError(e)
        return { ok: false, code: code ?? undefined, label: connectionTestLabel(false, code) } as ConnectionTestResult
      }),
    probeWsAuth(wsUrl, token)
  ])
  return { ...rest, ws }
}

/**
 * Apply the skin's chrome colours to the OS-drawn window buttons.
 *
 * Linux/Windows only. On macOS the buttons are the traffic lights, which the system colours for
 * legibility against the bar; `setTitleBarOverlay` is not implemented there and throws.
 *
 * A rejected payload is ignored rather than defaulted: the window was created with overlay colours
 * that match the default skin, so doing nothing leaves correct buttons, while guessing from a
 * malformed value could leave invisible ones.
 */
function applyTitlebarOverlay(payload: unknown): void {
  if (!usesWindowControlsOverlay(process.platform)) return
  const opts = overlayOptionsFrom(payload)
  if (!opts) {
    console.warn('[chrome] titlebar overlay payload rejected — keeping the current colours')
    return
  }
  try {
    mainWindow?.setTitleBarOverlay({ ...opts, height: TITLEBAR_OVERLAY_HEIGHT })
    // Positive record of what landed, symmetric with the rejection warning below. Without it the
    // only observable evidence of a repaint is the ABSENCE of a warning, which cannot distinguish
    // "applied correctly" from "never fired" — and the failure this guards (the renderer forwarding
    // the computed `color(srgb …)` form that Electron rejects, or not calling at all) leaves the
    // default plate's colours on screen, so it is invisible on NOX and wrong on the other eight.
    console.log(`[chrome] titlebar overlay applied: ${opts.color} / ${opts.symbolColor}`)
  } catch (err) {
    // Not fatal and not worth a dialog: the buttons still work, they may just be poorly contrasted
    // against this skin. Say so where the log can be read.
    console.warn('[chrome] setTitleBarOverlay failed:', (err as Error).message)
  }
}

/** Application menu — the macOS-conventional home for Preferences (⌘,), which opens Connection
 * Settings in the renderer. A File→Settings entry covers Windows/Linux (Ctrl+,). */
function buildAppMenu(): void {
  const openSettings = (): void => {
    mainWindow?.webContents.send(IPC.OPEN_SETTINGS)
  }
  const settingsItem: Electron.MenuItemConstructorOptions = {
    label: 'Settings…',
    accelerator: 'CmdOrCtrl+,',
    click: openSettings
  }
  const isMac = process.platform === 'darwin'
  // The About panel (role 'about') shows the name, version and Info.plist's copyright line. The credits
  // say where the license and the open-source notices are: the panel cannot link to a file.
  if (isMac) app.setAboutPanelOptions({ credits: 'Free · open source (MIT) · beta.\nLicense and third-party notices: Settings → About.' })
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              settingsItem,
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          }
        ] as Electron.MenuItemConstructorOptions[])
      : ([{ label: 'File', submenu: [settingsItem, { type: 'separator' }, { role: 'quit' }] }] as Electron.MenuItemConstructorOptions[])),
    { role: 'editMenu' },
    // Electron's own viewMenu role, spelled out so Toggle Developer Tools (⌥⌘I) exists only where
    // debugging is allowed: a release has no such item, and its windows refuse DevTools anyway
    // (webPreferences.devTools). probe:hardening presses ⌥⌘I on both builds.
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        ...(debuggingAllowedHere() ? ([{ role: 'toggleDevTools' }] as Electron.MenuItemConstructorOptions[]) : []),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ── window ────────────────────────────────────────────────────────────────────
const windowStateFile = (): string => join(app.getPath('userData'), 'window-state.json')

function createWindow(): void {
  // Restore persisted bounds (Slice 5); position is display-validated, size falls back to default.
  const st = loadWindowState(windowStateFile(), screen.getAllDisplays().map((d) => d.workArea))
  const win = new BrowserWindow({
    width: st.width,
    height: st.height,
    // The SAME floor the sanitizer applies to a RESTORED size. Before this the floor existed in one
    // place only: a window-state.json read at launch was clamped to 480x360, but the live window a
    // person drags had no minimum at all, so it could be resized into a sliver that the layout was
    // never built for. One invariant, two consumers — importing the constant rather than repeating
    // the numbers is what keeps them from disagreeing.
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    ...(st.x !== undefined && st.y !== undefined ? { x: st.x, y: st.y } : {}),
    show: false,
    title: 'Beacon',
    // The platform title bar is a light strip above a dark app — the one piece of the window that
    // isn't the product. Every platform therefore hides the native bar and lets the renderer draw
    // AppChrome, but the two families keep their buttons differently:
    //   darwin       `hiddenInset` — keeps the traffic lights, hands the strip to the renderer.
    //   linux/win32  `hidden` + `titleBarOverlay` — keeps the OS window buttons, drawn over our bar.
    //
    // Linux and Windows used `frame: false` here, which REMOVES those buttons outright, and Beacon
    // drew no replacements: on the AppImage/deb the window could not be closed, minimized or
    // maximized with a mouse at all. The only exits were Alt+F4 and the tray menu, neither
    // discoverable from the window you are looking at.
    //
    // `frame: false` + `titleBarOverlay` is NOT equivalent and does not work — measured on Electron
    // 44.4.1/Linux (scripts/wco-probe.cjs): WCO reports unavailable and no titlebar area is
    // reserved, because there are no standard controls left to overlay. `titleBarStyle: 'hidden'`
    // is what yields real buttons. The branch lives in @shared/window-chrome's windowChromeOptions
    // rather than inline here so a smoke can assert it and a probe can build a window FROM it; the
    // overlay colour is then repainted per skin from the renderer (IPC.TITLEBAR_OVERLAY →
    // applyTitlebarOverlay).
    ...windowChromeOptions(process.platform),
    backgroundColor: '#0b0d12',
    autoHideMenuBar: true,
    webPreferences: {
      devTools: debuggingAllowedHere(),
      preload: shellPreload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: builtinSpellcheck(process.platform)
    }
  })
  mainWindow = win
  adoptShellWindow(win) // the navigation guard: see the comment after the window-open handler
  trackWindowState(win, windowStateFile())
  // Right-click: copy/paste, spelling suggestions, link actions. One call per window so no window
  // ends up without it (Electron supplies no default menu).
  installContextMenu(win)
  if (st.maximized) win.maximize()

  win.on('ready-to-show', () => win.show())
  // Close-to-tray (@shared/tray-hint): ✕ hides by default so the connection survives (spec §3.2/§6),
  // but the user can make ✕ mean quit, and the FIRST time we hide we teach where it went — silently
  // vanishing the window is read as a crash. planClose folds those three conditions into one decision;
  // this handler only acts on it, so the truth table lives in the (smoke-tested) model, not inline.
  win.on('close', (e) => {
    // Quit already committed (⌘Q, tray Quit, or the quit path below re-entering through app.quit()):
    // let the close through before touching the cache. before-quit has closed the DB by now, so the
    // hint-row read below threw "The database connection is not open" on every quit.
    if (isQuitting) return
    const decision = planClose({
      isQuitting,
      closeToTray,
      hintShown: repo?.getSetting(TRAY_HINT_SHOWN_KEY) === '1'
    })
    if (decision.action === 'hide') {
      e.preventDefault()
      win.hide()
      if (decision.showHint) {
        const hint = trayHintNotification()
        // Persist ONCE, and only when a notification could be raised at all: where the platform has
        // none (isSupported() false, e.g. Linux without a notification daemon) the row stays unset and
        // the next hide tries again. macOS gives no failure signal for a denied permission, so there a
        // suppressed hint still spends the one shot.
        if (Notification.isSupported()) {
          new Notification({ title: hint.title, body: hint.body }).show()
          repo?.setSetting(TRAY_HINT_SHOWN_KEY, '1')
        }
      }
      return
    }
    // action === 'quit'. If teardown is already underway (tray Quit / ⌘Q / before-quit set isQuitting),
    // just let this close through. But when the user's ✕-means-quit SETTING drove it, closing the last
    // window quits NOTHING on its own: `window-all-closed` is a deliberate no-op (tray persistence), so
    // the app would survive headless with no window — the very "where did my app go" this setting
    // removes. Commit the quit explicitly, exactly like the tray's Quit item: isQuitting first (so
    // before-quit teardown and the re-entrant close from app.quit() both see the committed quit), then
    // app.quit().
    if (!isQuitting) {
      e.preventDefault()
      isQuitting = true
      app.quit()
    }
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  /**
   * Load the shell — the SAME call for first paint and for a post-crash reload, so a reload cannot
   * drift onto a different URL or lose the dev-server branch. Two copies of this line is how a
   * recovery path ends up reloading something that is not the app.
   */
  const loadShell = (): void => void loadShellPage(win)

  // The renderer PROCESS ending — OOM, a GPU fault, the kernel picking Beacon. Distinct from a React
  // throw, which #172's ErrorBoundary handles INSIDE the renderer: when the process is gone there is
  // no React left to catch anything and no DOM left to draw a fallback into, so this is the only half
  // that can recover. Without it the window kept showing its last painted frame, frozen, while the
  // tray reported the connection alive and the only exits were Alt+F4 and the tray menu.
  //
  // `unresponsive` is deliberately NOT handled here. It fires when the renderer stops answering for
  // ~30s WITHOUT having died — reloading then would discard a window that may still be working on a
  // long synchronous task, and the honest answer is a different one (wait, then offer a choice).
  // Adding it would be a second, larger decision; this closes the crash half.
  const recovery = createRendererRecovery({
    reload: () => {
      if (win.isDestroyed()) return
      loadShell()
      win.show() // a crash can leave the window hidden or unfocused; recovery should bring it back
    },
    notifyStopped: (notice, detail) => dialogNotifyStopped(notice, detail, () => {
      isQuitting = true // otherwise the window's own 'close' handler hides it and fights the quit
      app.quit()
    }),
    isQuitting: () => isQuitting,
    dir: () => app.getPath('userData'),
    appVersion: () => app.getVersion()
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[shell] main window renderer ended (${details.reason}) — ${JSON.stringify(details.exitCode ?? null)}`)
    void recovery.onRendererGone({
      reason: details.reason,
      ...(details.exitCode !== undefined ? { exitCode: details.exitCode } : {}),
      // THIS window is by construction the main one; the flag exists so the pop-outs (which share
      // this module) cannot opt into a shell policy they do not own.
      isMainWindow: true
    })
  })
  win.webContents.on('did-finish-load', () => {
    // Restore the persisted zoom (Electron resets to 100% each load otherwise). ⌘+/-/0 then stick.
    if (typeof st.zoom === 'number') win.webContents.setZoomLevel(st.zoom)
    if (connection) win.webContents.send(IPC.CONNECTION_STATUS_CHANGED, connection.getStatus())
  })
  // A link in the shell is an EXTERNAL link: it goes to the OS browser, never
  // into a privileged window. Gated by safeExternalUrl (src/shared/browser-pane)
  // — http(s) only, so a colon-free relative href from model-authored markdown
  // cannot resolve against this window's file:// base in a packaged build and
  // reach the OS launcher. The browser pane already applied the same allowlist
  // and its smoke already asserted file:///x is refused; this window simply did
  // not import it.
  win.webContents.setWindowOpenHandler(({ url }) => {
    const safe = safeExternalUrl(url)
    if (safe) void shell.openExternal(safe)
    // Deliberately does NOT log the refused URL: it is untrusted, model-
    // authored content, and a log line the operator reads later in a terminal
    // is exactly where such text should not appear.
    else console.warn('[shell] refused to open a non-web URL (see safeExternalUrl)')
    return { action: 'deny' }
  })

  // Dragging a link (or a file) onto the window would otherwise NAVIGATE this
  // preload-bridged window to a foreign document, which then reaches
  // terminal.write, daemon.write against any API path with the bearer token,
  // screenshot capture and the settings save that can repoint the gateway and
  // plant a token — the last being the phishing primitive the beacon:// deep-link
  // parser refuses by name. Only the terminal's handlers check the sender at all,
  // so the navigation itself has to be refused.
  //
  // adoptShellWindow(win), called where the window is made, installs that guard
  // (will-navigate AND will-redirect) with @shared/shell-window's
  // mayShellWindowNavigate. Until 2026-09-24 this guard was isAllowedNavigation,
  // which refuses file:// but admits every http(s) page: a dropped or injected
  // web link still put a foreign page at the top of this window WITH the bridge
  // (measured, scripts/window-guard-probe.mjs). Nothing in the app navigates this
  // window to a web page: its links open in the OS browser (the handler above),
  // and hash routing is not a navigation. So now nothing leaves the shell page
  // except about:blank, and the dev server's own reload under `npm run dev`.

  loadShell()
}

// ── quick-capture window (Slice 10) ───────────────────────────────────────────
// A spotlight-style always-on-top mini composer. Same renderer + preload (hash-routed #capture),
// so it rides the existing bridge — broadcast() already reaches every window with stream frames.
let captureWindow: BrowserWindow | null = null

function createCaptureWindow(): void {
  const win = new BrowserWindow({
    width: 620,
    height: 380,
    show: false,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    title: 'Beacon Quick Capture',
    backgroundColor: '#0b0d12',
    webPreferences: {
      devTools: debuggingAllowedHere(),
      preload: shellPreload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: builtinSpellcheck(process.platform)
    }
  })
  captureWindow = win
  adoptShellWindow(win)
  // It renders no links. Anything that would open a window is refused, as in the pop-outs; without a
  // handler a window.open here made a new Electron window on the page (window-guard-probe, 2026-09-24).
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // The red-button / ⌘W path (BrowserWindow.close) hides rather than destroys, matching the main
  // window's tray lifecycle. Esc in the renderer calls window.close(), which does NOT land here —
  // a renderer-initiated close skips this cancelable event and destroys the window (measured,
  // Electron 33: scripts/electron-close-semantics-probe.js); toggleCaptureWindow recreates it.
  // Both outcomes are fine for a transient box that holds no view and no live subscription.
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      win.hide()
    }
  })
  win.on('blur', () => win.hide())
  win.on('closed', () => {
    if (captureWindow === win) captureWindow = null
  })
  // Quick-capture is a composer in its own window — the menu matters most here, where there is
  // nothing else on screen but the field you are typing into.
  installContextMenu(win)
  void loadShellPage(win, 'capture')
}

function toggleCaptureWindow(): void {
  if (!captureWindow || captureWindow.isDestroyed()) createCaptureWindow()
  const win = captureWindow!
  if (win.isVisible()) {
    win.hide()
  } else {
    win.center()
    win.show()
    win.focus()
  }
}

// ── tray HUD (harness sprint #8) — the popover behind the Pulse icon ─────────────────────────
// Same lifecycle as QuickCapture: hash-routed (#hud), hidden on blur and on BrowserWindow.close;
// Esc in the renderer DESTROYS it (renderer window.close() bypasses the cancelable 'close') and the
// next tray click recreates it — correct for a transient popover with no view and no pty.
let hudWindow: BrowserWindow | null = null

function createHudWindow(): void {
  const win = new BrowserWindow({
    width: 330,
    height: 312,
    show: false,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    title: 'Beacon HUD',
    backgroundColor: '#0b0d12',
    webPreferences: {
      devTools: debuggingAllowedHere(),
      preload: shellPreload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: builtinSpellcheck(process.platform)
    }
  })
  hudWindow = win
  adoptShellWindow(win)
  // Same as quick-capture: no links, so nothing opens a window from here.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      win.hide()
    }
  })
  win.on('blur', () => win.hide())
  win.on('closed', () => {
    if (hudWindow === win) hudWindow = null
  })
  installContextMenu(win)
  void loadShellPage(win, 'hud')
}

/** Toggle the HUD, parked under the tray icon and clamped to the work area. */
function toggleHudWindow(): void {
  if (!hudWindow || hudWindow.isDestroyed()) createHudWindow()
  const win = hudWindow!
  if (win.isVisible()) {
    win.hide()
    return
  }
  const tb = tray?.getBounds()
  if (tb) {
    const wa = screen.getDisplayNearestPoint({ x: tb.x, y: tb.y }).workArea
    const [w] = win.getSize()
    const x = Math.round(Math.min(Math.max(tb.x + tb.width / 2 - w / 2, wa.x + 8), wa.x + wa.width - w - 8))
    const y = Math.round(tb.y + tb.height + 6)
    win.setPosition(x, y, false)
  }
  win.show()
  win.focus()
}

// ── tray + notifications ──────────────────────────────────────────────────────
/** Tray line for auto-update state — only when it's actionable (downloaded) or informative
 * (downloading). 'disabled'/'idle'/'up-to-date' stay out of the menu: no noise. */
function trayUpdateLine(): Electron.MenuItemConstructorOptions[] {
  const st = getUpdaterStatus()
  if (st.state === 'ready') {
    return [{ label: `⬆ Beacon v${st.version ?? ''} ready — restart to install`, click: () => installUpdate() }]
  }
  if (st.state === 'downloading') {
    return [{ label: `⬇ Updating… ${st.percent ?? 0}%`, enabled: false }]
  }
  return []
}

/** Tray context menu (Slice 5 quick actions): live state line, open, settings, quit. Rebuilt on
 * every presence/connection transition — Electron tray menus are immutable once set. */
function trayMenu(): Electron.Menu {
  return Menu.buildFromTemplate([
    { label: TRAY_TOOLTIP[deriveTrayStatus(presence)], enabled: false },
    ...(pendingApprovals > 0
      ? ([
          {
            label: `⚠ ${pendingApprovals} approval${pendingApprovals === 1 ? '' : 's'} waiting — review…`,
            click: showWindow
          }
        ] as Electron.MenuItemConstructorOptions[])
      : []),
    ...trayUpdateLine(),
    { type: 'separator' },
    { label: 'Open Beacon', click: showWindow, accelerator: SUMMON_ACCELERATOR },
    {
      label: 'Settings…',
      click: () => {
        showWindow()
        mainWindow?.webContents.send(IPC.OPEN_SETTINGS)
      }
    },
    { type: 'separator' },
    {
      label: 'Quit Beacon',
      click: () => {
        isQuitting = true
        app.quit()
      }
    }
  ])
}

/** The Pulse tray glyph as a Retina nativeImage: @1x + @2x reps. macOS gets the black TEMPLATE pair
 * (system-recolored to the bar); other platforms get the sanguine pair so it stays visible. */
function buildTrayIcon(): Electron.NativeImage {
  const mac = process.platform === 'darwin'
  const [b16, b32] = mac ? [TRAY_TEMPLATE_16, TRAY_TEMPLATE_32] : [TRAY_SANG_16, TRAY_SANG_32]
  const icon = nativeImage.createFromBuffer(Buffer.from(b16, 'base64'))
  icon.addRepresentation({ scaleFactor: 2, buffer: Buffer.from(b32, 'base64') })
  if (mac) icon.setTemplateImage(true)
  return icon
}

function createTray(): void {
  try {
    tray = new Tray(buildTrayIcon())
    tray.setToolTip(TRAY_TOOLTIP[deriveTrayStatus(presence)])
    if (process.platform === 'darwin') {
      // macOS: click opens the HUD popover (harness sprint #8); the menu moves to right-click.
      // Deliberately NO setContextMenu — with one set, macOS opens the menu on left-click and
      // the click handler never fires.
      tray.on('click', toggleHudWindow)
      tray.on('right-click', () => tray?.popUpContextMenu(trayMenu()))
    } else {
      // Linux/Windows keep the classic behavior: persistent menu + click toggles the window.
      tray.setContextMenu(trayMenu())
      tray.on('click', toggleWindow)
    }
  } catch (err) {
    console.error('[tray] creation failed (no display?):', (err as Error).message)
  }
}

function updateTray(): void {
  if (tray && !tray.isDestroyed()) {
    tray.setToolTip(TRAY_TOOLTIP[deriveTrayStatus(presence)])
    if (process.platform !== 'darwin') tray.setContextMenu(trayMenu()) // darwin builds fresh on right-click
  }
  updateBadge()
}

/**
 * The OS dock/taskbar badge, from the SAME pendingApprovals counter the tray line already uses.
 *
 * Rides updateTray() rather than getting its own call sites: that function is the one funnel every
 * approval-count change already flows through (the APPROVALS_COUNT ipc, the push-frame path, the poll
 * discovery), so the badge can never drift from the tray line by being updated somewhere else.
 *
 * WHY THE PLATFORM GUARDS LIVE HERE AND NOT IN @shared/badge. app.setBadgeCount is @platform
 * linux,darwin — NOT Windows — and on Linux it only paints under a Unity-style shell whose .desktop
 * name matches, and on macOS it needs notification permission. Three caveats, none of which change
 * WHAT number to show, which is the part worth proving headless. So the model decides the count and
 * this function decides whether the OS can take one.
 *
 * The return value is checked and logged once: setBadgeCount returns false when the platform cannot
 * show a badge (no Unity, no permission), and swallowing that silently would make "the badge never
 * appears on this Linux desktop" indistinguishable from "we never tried". It is not an error — most
 * Linux desktops are not Unity — so it is a one-line log, not a dialog.
 */
let badgeUnsupportedLogged = false
function updateBadge(): void {
  const n = displayedBadgeCount(badgeCount(pendingApprovals))
  if (process.platform === 'win32') return // no badge API; the taskbar overlay would be a separate feature
  const ok = app.setBadgeCount(n)
  if (!ok && !badgeUnsupportedLogged) {
    badgeUnsupportedLogged = true
    console.log('[badge] this desktop cannot show a badge count (setBadgeCount returned false) — the tray line still works')
  }
}

function notify(title: string, body: string, sessionId: string): void {
  if (!Notification.isSupported()) return
  const n = new Notification({ title, body })
  n.on('click', () => {
    if (sessionId) showSession(sessionId)
    else showWindow()
  })
  n.show()
}

// ── Approval push (feat/approval-push-ws) ────────────────────────────────────
// MAIN is the ONE notification authority for approvals. Two discovery paths
// feed it: the daemon's `approval_pending` WS frame (instant) and the
// renderer's poll reporting fresh ids via approvals:new (reconciler). One
// dedupe set here means one request gets ONE notification no matter which path
// saw it first — the frame+poll race the spec names, resolved by id.
//
// THE POLL IS NOT REDUNDANT: it is what clears rows the client missed while
// not listening. Push makes poll latency-free; poll makes push safe.
const notifiedApprovalIds = new Set<string>()

/** One pending request → one native notification, with Approve/Deny actions WHEN
 * the body can carry the decision. Buttons are darwin-gated (proven live on
 * Electron 33.4.11, step-0 check); elsewhere the notification falls back to
 * click → focus window, which is exactly the pre-push behavior — the premise
 * degrades, it never breaks.
 *
 * A REQUEST THAT CARRIES ARGUMENTS TAKES THAT SAME FALLBACK ON DARWIN TOO. The
 * button resolves the request with no confirmation step, so it is defensible only
 * while the body shows what runs; 200 characters cannot hold a description AND the
 * text about to be typed, and picking which argument to sacrifice is a judgement
 * Beacon is not the one to make. notificationPlan() decides body and buttons in ONE
 * call so the two cannot drift apart — see @shared/approval-push.
 *
 * Scope is ONCE only: the wide verbs stay in-app where extents are shown. */
function notifyApproval(
  /** The connection whose Prometheus asked: the buttons answer it, never a link brought up since (@shared/approval-push). */
  raisedBy: ConnectionManager | null,
  requestId: string,
  toolName: string,
  description: string,
  args?: ApprovalArguments
): void {
  if (notifiedApprovalIds.has(requestId)) return
  notifiedApprovalIds.add(requestId)
  if (!Notification.isSupported()) return
  if (windowFocused()) return // focused → the approval card IS the surface
  // The user's master mute / approval switch, placed with the other suppression conditions and AFTER
  // the dedupe add — so muting an approval behaves exactly like being focused: we've accounted for the
  // id, we just don't raise the OS alert. Approvals default ON and the settings UI flags them as the
  // channel that matters; this gate is here so a user who quiets 'task' and 'reply' is NOT also forced
  // to give up the blocked-agent alert, which is the whole point of per-kind control.
  if (!notifyAllowed(notifyPrefs, 'approval')) return

  const plan = notificationPlan(toolName, description, args)
  const actions =
    process.platform === 'darwin' && plan.offersActions
      ? ([
          { type: 'button', text: 'Approve' },
          { type: 'button', text: 'Deny' }
        ] as Electron.NotificationAction[])
      : []
  const n = new Notification({
    title: 'Prometheus — approval needed',
    body: plan.body,
    actions,
    silent: false
  })
  n.on('action', (_e, index: number) => {
    // The button is a side-effectful control; the daemon resolves stale ids
    // to a clean no-op (ok:false / 404), so acting on an already-resolved
    // notification can never double-run.
    const decision: ApprovalDecision = index === 0 ? { kind: 'approve', scope: 'once' } : { kind: 'deny' }
    void approvalActionTarget(raisedBy, connection)?.resolveApproval(requestId, decision).catch(() => undefined)
  })
  n.on('click', () => showWindow())
  n.show()
}

/** Frame path: the daemon pushes approval_pending/approval_resolved (PR #280).
 * Pending → notification; resolved → drop the id from the dedupe set so a
 * FUTURE request with the same id can notify again. The renderer's overlay
 * list is driven by its own frame+poll paths; main owns only the notification. */
function handleApprovalFrame(raisedBy: ConnectionManager, ev: { type?: string; payload?: Record<string, unknown> }): void {
  const p = ev.payload ?? {}
  if (ev.type === 'approval_pending') {
    const a = rawToApproval(p as RawApprovalPush)
    if (a) notifyApproval(raisedBy, a.requestId, a.toolName, a.description, a.arguments)
  } else if (ev.type === 'approval_resolved') {
    const rid = typeof p.request_id === 'string' ? p.request_id : null
    if (rid) notifiedApprovalIds.delete(rid)
  }
}

function snippet(s: string): string {
  const t = s.replace(/<\/?tool_call>/g, ' ').replace(/\s+/g, ' ').trim()
  return t.length > 140 ? `${t.slice(0, 137)}…` : t
}

/** Slice 9: mirror what Telegram gets — native notifications for background-task completion.
 * Fires only while the window is unfocused (focused → Mission Control's ticker is the surface). */
function maybeNotifyTask(ev: { type?: string; payload?: Record<string, unknown> }): void {
  if (ev.type !== 'task_completed' && ev.type !== 'task_failed') return
  if (windowFocused()) return
  // The user's per-kind switch, on top of the focus gate: 'task' is the frequent low-stakes channel,
  // the one a busy install most wants quieted — and quieting it must NOT touch approvals.
  if (!notifyAllowed(notifyPrefs, 'task')) return
  const p = ev.payload ?? {}
  const desc =
    typeof p.description === 'string' && p.description
      ? p.description
      : typeof p.task_id === 'string'
        ? `task ${p.task_id}`
        : 'background task'
  const sessionId = typeof p.session_id === 'string' ? p.session_id : ''
  notify(ev.type === 'task_failed' ? 'Prometheus — task failed' : 'Prometheus — task completed', snippet(desc), sessionId)
}

function onStatus(s: ConnectionStatus): void {
  broadcast(IPC.CONNECTION_STATUS_CHANGED, s)
  presence = applyPresenceEvent(presence, { type: 'conn', state: s.state })
  updateTray()
  if (
    s.state === 'failed' &&
    prevConnState !== 'failed' &&
    notifyAllowed(notifyPrefs, 'error') &&
    shouldNotify({ kind: 'error', sessionId: '', windowFocused: windowFocused(), activeSessionId })
  ) {
    notify('Beacon — disconnected', 'Lost the connection to Prometheus.', activeSessionId ?? '')
  }
  prevConnState = s.state
}

function onStreamFrame(f: ChatStreamFrame): void {
  broadcast(IPC.CHAT_STREAM, f)
  switch (f.kind) {
    case 'delta':
      presence = applyPresenceEvent(presence, { type: 'delta' })
      streamBuf.set(f.sessionId, (streamBuf.get(f.sessionId) ?? '') + f.content)
      break
    case 'done': {
      presence = applyPresenceEvent(presence, { type: 'done' })
      const text = streamBuf.get(f.sessionId) ?? ''
      streamBuf.delete(f.sessionId)
      if (
        notifyAllowed(notifyPrefs, 'reply') &&
        shouldNotify({ kind: 'chat_done', sessionId: f.sessionId, windowFocused: windowFocused(), activeSessionId, focusedPopout: sessionWindows.focused(), visibleSessionIds })
      ) {
        notify(`Prometheus · ${gatewayOf(f.sessionId)}`, snippet(text) || 'New reply', f.sessionId)
      }
      break
    }
    case 'tool_start':
      presence = applyPresenceEvent(presence, { type: 'tool_start' })
      break
    case 'tool_end':
      presence = applyPresenceEvent(presence, { type: 'tool_end' })
      break
    default:
      break
  }
  updateTray()
}

// ── app lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  proveSqlite()
  watchPowerEvents()

  // Dev-run dock icon (macOS): packaged builds get build/icon.png via electron-builder (.icns);
  // an electron-vite dev run would otherwise wear the stock Electron atom in the dock.
  if (isDev && process.platform === 'darwin' && app.dock) {
    const devIcon = nativeImage.createFromPath(join(app.getAppPath(), 'build/icon.png'))
    if (!devIcon.isEmpty()) app.dock.setIcon(devIcon)
  }

  if (!isDev) {
    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
      // Stamp the renderer CSP ONLY on the app's own documents (file:// — how the packaged
      // renderer loads). This hook sees EVERY response in the session, and stamping the wrong
      // ones ships features inert in packaged builds only (dev never installs the hook, so dev
      // always looks fine). It has now bitten twice: beacon-artifact:// responses (the rendered
      // artifact's own policy was overwritten — a1-packaged-html.png, 2026-08-28) and the PDF
      // viewer's internal chrome-extension:// pages (its chrome://resources scripts were refused
      // → a blank viewer — probe-a5-dbg, 2026-08-29). An allowlist ends the whack-a-mole.
      if (!details.url.startsWith('file://')) {
        cb({ responseHeaders: details.responseHeaders })
        return
      }
      cb({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            // frame-src/img-src admit beacon-artifact: for the rendered-artifact pane. Adding an
            // explicit frame-src also STOPS 'self' frames existing implicitly via default-src —
            // the only frame this app may host is a sandboxed artifact render.
            // frame-src blob: is the STAGED-pdf preview (a not-yet-sent file, Chromium's viewer).
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: beacon-artifact:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src beacon-artifact: blob:"
          ]
        }
      })
    })
  }

  // app.db plus one folder per Prometheus (docs/MULTI-PROMETHEUS.md §3); the first launch moves beacon.db in, backup first.
  // The A6 sweep of orphaned per-conversation settings runs per folder, as each is opened.
  folders = new DaemonFolders(app.getPath('userData'))
  repo = folders
  // Load the two window/notification choices before anything can fire one. Reading them here (not
  // lazily at the call site) means the gate uses a settled value from the first event onward — a
  // notification that arrives before the renderer has round-tripped the preference still respects it.
  loadNotifyPrefs()
  loadCloseMode()
  // The credential blob lives in app-data, encrypted by the OS keychain — never in the renderer.
  // Each Prometheus's key is a file in its folder, sealed by the OS keychain (DaemonFolders.keyPath), never the renderer.
  keyCipher = electronSafeStorageCipher()

  // Rendered artifacts: bytes are fetched in main by content id and served under their own
  // no-network CSP; the renderer only ever holds the beacon-artifact:// URL.
  registerArtifactRenderProtocol({ getConnection: () => connection })

  registerIpcHandlers({
    repo,
    getConnection: () => connection,
    getCache: () => cache,
    setupStatus,
    saveSetup,
    forgetConnection,
    pairWithCode,
    pairPoll,
    probeSetup,
    getConnectionSettings,
    saveConnectionSettings,
    testConnection
  })
  // Loop Manager: registry handlers + project files routed through the daemon (/api/project-file),
  // so a remote Beacon (e.g. on a Mac) can edit files that live on the daemon host.
  // Discovery: find a Prometheus without connecting to it (v0.4.0 onboarding). Stops with the app.
  const discovery = registerDiscoveryHandlers()
  registerPathAHandlers(prometheusInstaller) // path A: can Prometheus be set up on this Mac, and (once the person confirms) setting it up
  registerModelSetupHandlers({ setup: modelSetup, newSignIn: newOpenRouterSignIn, tradeOwed: () => repo?.getSetting(CREDENTIAL_KIND_KEY) === 'master' }) // O9: the cloud AI's key, and the owner trade
  registerJoinHandlers(joinSession, pairingWatcher) // path B: ask to join, wait for approval, be connected; and the owner's side
  registerNetworkSettingHandlers(networkSetting) // Settings → Other computers: the home-network switch, and the restart
  registerPairPinHandlers(pairPin) // Devices → Enrol: the pairing code's TLS pin, before the token is minted
  registerOwnerPromotionHandlers(ownerPromotion) // Settings → Make this Beacon an owner: the one-time code for an owner token
  registerMainModelHandlers(mainModelSetting) // Config → Models → Main model: which AI Prometheus thinks with (restart: the network setting's)
  app.on('before-quit', () => {
    discovery.stop()
    void joinSession.cancel() // a request still waiting is withdrawn, best effort
    void prometheusInstaller.cancel() // a download under way is stopped and deleted; an app already in Applications stays
  })
  registerLoopHandlers({
    projectsFile: () => join(app.getPath('userData'), 'loop-projects.json'),
    getWindow: () => mainWindow,
    getConnection: () => connection
  })
  // Integrations (contract v0.1): generic control-surface registry. Main owns
  // base URLs + auth; v1 ships authRef 'none' only ('stored' reserved for a
  // future keyed safeStorage blob — never the plaintext registry JSON).
  const integrationTokenStore = (id: string): CredentialStore =>
    new CredentialStore(join(app.getPath('userData'), `integration-${id}.bin`), electronSafeStorageCipher())
  registerIntegrationsHandlers({
    registryFile: () => join(app.getPath('userData'), 'integrations.json'),
    tokenFor: (entry) => (entry.authRef === 'stored' ? integrationTokenStore(entry.id).getToken() : null),
    setToken: (id, token) => integrationTokenStore(id).setToken(token),
    reveal: (path) => shell.showItemInFolder(path)
  })
  onFromShell(IPC.SESSION_ACTIVE, (_e, sessionId: string) => {
    activeSessionId = typeof sessionId === 'string' && sessionId ? sessionId : null
  })
  onFromShell(IPC.SESSION_VISIBLE, (_e, ids: unknown) => {
    visibleSessionIds = Array.isArray(ids) ? ids.filter((x): x is string => isPlausibleSessionId(x)).slice(0, MAX_PANES) : []
  })
  registerSessionWindowHandlers({
    windows: sessionWindows,
    // Runs once the session's window is gone, so the main window's popped-out set no longer holds it
    // and the switch lands in the main window instead of being bounced back to the closed one.
    showInMain: (sessionId) => {
      showWindow()
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.SESSION_SWITCH, sessionId)
    }
  })
  registerVoiceHandlers()
  registerHandsFreeHandlers()
  registerScreenshotHandlers()
  // Browser pane: WebContentsViews hosted in main, driven by the user only (@shared/browser-pane).
  registerBrowserPane({
    getMainWindow: () => mainWindow,
    isDev,
    openPopout: (onClose) =>
      openPopout({ title: 'Beacon Browser', hash: 'browser', stateFile: 'browser-window-state.json', defaultSize: { width: 1100, height: 800 }, onClose, isQuitting: () => isQuitting })
  })
  registerTerminalHandlers({
    mainWindow: () => mainWindow,
    openPopout: (onClose) =>
      openPopout({ title: 'Beacon Terminal', hash: 'terminal', stateFile: 'terminal-window-state.json', defaultSize: { width: 960, height: 600 }, onClose, isQuitting: () => isQuitting })
  })
  // Repaint the OS window buttons to match the active skin. Send-only: there is nothing for the
  // renderer to await and nothing to fail visibly — the buttons are already there, this only makes
  // them legible against the bar behind them.
  onFromShell(IPC.TITLEBAR_OVERLAY, (e, payload: unknown) => {
    // Narrower than onFromShell's check: only the main window paints chrome. The quick-capture, HUD
    // and pop-out windows are all `frame: false` with no overlay, and must not repaint the main
    // window's buttons.
    if (mainWindow?.webContents.id !== e.sender.id) return
    applyTitlebarOverlay(payload)
  })
  // The error boundary's "Reload Beacon". The renderer cannot reload itself in a built app: the shell
  // is a file:// page, `location.reload()` raises will-navigate, and the navigation guard every Beacon
  // window gets (adoptShellWindow) refuses the built shell's own file:// page, so the button did
  // nothing. `webContents.reload()` from here does not raise that event, which leaves the guard
  // exactly as strict. It reloads the SENDER and nothing else, so a pop-out that asks keeps its own
  // route.
  onFromShell(IPC.WINDOW_RELOAD, (e) => {
    e.sender.reload()
  })
  onFromShell(IPC.APPROVALS_COUNT, (_e, n: number) => {
    const next = typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0
    if (next !== pendingApprovals) {
      pendingApprovals = next
      updateTray()
    }
  })
  // Poll-discovered fresh requests → main's notification authority (same dedupe
  // set the push frame path uses). The renderer's own in-window notification
  // was retired with this: one authority, one notification per request.
  onFromShell(IPC.APPROVALS_NEW, (_e, requests: ApprovalRequest[]) => {
    if (!Array.isArray(requests)) return
    for (const a of requests) {
      // coerceArguments at the IPC boundary: this object crossed a wire, so it is
      // shaped like an ApprovalRequest rather than known to be one. Idempotent on an
      // already-coerced map, and it is the same function both daemon mappers use.
      if (a && typeof a.requestId === 'string')
        notifyApproval(connection, a.requestId, a.toolName ?? '', a.description ?? '', coerceArguments(a.arguments))
    }
  })
  onFromShell(IPC.CAPTURE_OPEN_MAIN, (_e, sessionId: string) => {
    captureWindow?.hide()
    if (typeof sessionId === 'string' && sessionId) showSession(sessionId)
    else showWindow()
  })

  createTray()
  buildAppMenu()

  // Auto-update: gated on app.isPackaged inside; dev builds report 'disabled'. Broadcasts every
  // state transition to all windows and refreshes the tray menu line.
  initUpdater((s: UpdaterStatus) => {
    broadcast(IPC.UPDATER_STATUS_CHANGED, s)
    updateTray()
  })
  handleFromShell(IPC.UPDATER_STATUS, () => getUpdaterStatus())
  handleFromShell(IPC.UPDATER_CHECK, () => {
    checkForUpdates()
    return getUpdaterStatus()
  })
  handleFromShell(IPC.UPDATER_INSTALL, () => installUpdate())
  // Notification prefs + close mode. SET parses through the shared model FIRST so what gets stored is
  // always canonical (hostile or partial input from the renderer degrades to defaults per-field), and
  // returns the STORED value so the UI renders the truth rather than what it asked for.
  handleFromShell(IPC.NOTIFY_PREFS_GET, () => notifyPrefs)
  handleFromShell(IPC.NOTIFY_PREFS_SET, (_e, input: unknown) => {
    // One parse, from the JSON of whatever arrived: hostile, partial, or non-object input degrades
    // per-field to the default rather than throwing or storing garbage (see parseNotifyPrefs).
    const prefs = parseNotifyPrefs(JSON.stringify(input ?? null))
    notifyPrefs = prefs
    repo?.setSetting(NOTIFY_PREFS_KEY, serializeNotifyPrefs(prefs))
    return prefs
  })
  handleFromShell(IPC.CLOSE_MODE_GET, () => (closeToTray ? 'tray' : 'quit'))
  handleFromShell(IPC.CLOSE_MODE_SET, (_e, input: unknown) => {
    const mode: CloseMode = input === 'quit' ? 'quit' : 'tray' // anything unrecognized → the default
    closeToTray = mode === 'tray'
    repo?.setSetting(CLOSE_MODE_KEY, mode)
    return mode
  })
  // Launch at login (@shared/login-item). GET reads LIVE from the OS — the user can flip this outside
  // Beacon (System Settings → Login Items, Task Manager → Startup), so a cached copy would show the
  // switch in the wrong position. SET writes, then returns the OS's readback: what it kept, not what
  // we asked for — the same contract as NOTIFY_PREFS_SET above.
  //
  // The platform + isPackaged gate lives in the MODEL (describeLoginItem), so GET and SET agree on
  // what "cannot honour" means. SET never calls the OS API when the gate says unsupported: on Linux
  // it would be a silent no-op anyway, and in an unpackaged build it would register the raw electron
  // binary as a startup item — a lie that outlives this process, in the user's OS settings.
  const loginItemPlatform = (): LoginItemPlatform =>
    process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux'
  const loginItemState = () => {
    const platform = loginItemPlatform()
    // Query the OS only where the call means something: on Linux it's a no-op, and in a dev build it
    // would report the raw electron binary's registration — state Beacon must not show or trust.
    const canHonour = describeLoginItem(platform, app.isPackaged, null).supported
    const os = canHonour ? app.getLoginItemSettings() : null
    return describeLoginItem(platform, app.isPackaged, os)
  }
  handleFromShell(IPC.LOGIN_ITEM_GET, () => loginItemState())
  handleFromShell(IPC.LOGIN_ITEM_SET, (_e, input: unknown) => {
    const want = input === true // anything not literally true unregisters — the safe direction
    if (loginItemState().supported) app.setLoginItemSettings({ openAtLogin: want })
    return loginItemState()
  })

  // Settings → About (@shared/legal-docs): the license, the third-party notices, Chromium's licenses. The
  // renderer sends a document's NAME; anything else is refused, so this cannot open an arbitrary path.
  // Unpackaged, the files are the repo's own, two levels above out/main.
  handleFromShell(IPC.LEGAL_DOC_OPEN, async (_e, doc: unknown): Promise<LegalDocResult> => {
    if (!isLegalDoc(doc)) return { ok: false, error: 'not a document Beacon ships' }
    const outMain: unknown = import.meta.mainOutDir
    if (!app.isPackaged && !(typeof outMain === 'string' && isAbsolute(outMain))) return { ok: false, error: 'this build cannot say where its own files are' }
    const path = legalDocPath(doc, {
      packaged: app.isPackaged,
      platform: process.platform,
      resourcesPath: process.resourcesPath,
      repoRoot: typeof outMain === 'string' ? resolve(outMain, '../..') : ''
    })
    if (!existsSync(path)) return { ok: false, error: `${path.split('/').pop()} is missing from this build` }
    const failed = await shell.openPath(path)
    return failed ? { ok: false, error: failed } : { ok: true }
  })

  // OS light/dark appearance (audit #6). The renderer is sandboxed and cannot read nativeTheme, so
  // main is its proxy: GET is the current appearance, and every nativeTheme 'updated' transition is
  // pushed to all windows so one wearing the "match system" skin re-skins live instead of waiting for
  // a relaunch. Registered ONCE here (app.whenReady scope) rather than per-window: 'updated' is an
  // app-level event, and a per-window listener would either duplicate the broadcast or miss windows
  // created later. broadcast() already skips windows mid-teardown, so a flip during a close is safe.
  handleFromShell(IPC.SYSTEM_THEME_GET, () => nativeTheme.shouldUseDarkColors)
  nativeTheme.on('updated', () => broadcast(IPC.SYSTEM_THEME_CHANGED, nativeTheme.shouldUseDarkColors))

  // First-run vs returning launch: connect if a gateway is stored (setup) or pinned via env (dev);
  // otherwise stay in setup mode (the renderer shows the first-run form, then calls setup:save).
  const storedGw = repo.getDefaultGatewayProfile()
  if (decideStartup({ hasStoredGateway: !!storedGw, hasEnvGateway: hasEnvGateway() }) === 'connect') {
    const gw: GatewayConfig = storedGw ?? resolveGateway()
    bringUpConnection(gw)
  }

  try {
    createWindow()
  } catch (err) {
    console.error('[main] window creation failed (no display?):', (err as Error).message)
  }
  // Bring back the session windows that were open at the last quit, where they were. Only sessions
  // the local cache still knows: a forgotten one is dropped from the list rather than opened empty.
  try {
    const known = repo ? new Set(repo.getSessions().map((s) => s.id)) : null
    sessionWindows.restore((id) => known === null || known.has(id))
  } catch (err) {
    console.warn('[main] session windows not restored:', (err as Error).message)
  }

  // beacon:// intake (A4): claim the scheme — a RELEASE build only. A dev run would claim it for the
  // bare Electron binary; a probe build (its own bundle id) took it over from the installed app on
  // 2026-10-06, because claiming writes LaunchServices' stored handler. Then drain whatever arrived
  // before the window existed (macOS open-url on a cold start) or rode this instance's own argv
  // (Windows/Linux cold start). Deep links still work in a probe build launched with one in argv.
  if (buildFlavor() === 'release') app.setAsDefaultProtocolClient('beacon')
  appReady = true
  if (!pendingDeepLink) pendingDeepLink = firstDeepLinkInArgv(process.argv)
  if (pendingDeepLink) {
    const u = pendingDeepLink
    pendingDeepLink = null
    handleDeepLink(u)
  }

  // Global summon (Slice 5): toggle Beacon from anywhere. Registration can fail if another app
  // owns the chord — log and move on, never block startup.
  try {
    const ok = globalShortcut.register(SUMMON_ACCELERATOR, toggleWindow)
    if (!ok) console.warn(`[main] global summon ${SUMMON_ACCELERATOR} unavailable (held by another app)`)
  } catch (err) {
    console.warn('[main] global summon registration failed:', (err as Error).message)
  }
  try {
    const ok = globalShortcut.register(CAPTURE_ACCELERATOR, toggleCaptureWindow)
    if (!ok) console.warn(`[main] quick-capture ${CAPTURE_ACCELERATOR} unavailable (held by another app)`)
  } catch (err) {
    console.warn('[main] quick-capture registration failed:', (err as Error).message)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else showWindow()
  })
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  // Tray persists; main-process connection survives — do NOT quit (background persistence).
})

app.on('before-quit', () => {
  isQuitting = true
  // Terminal pane: the ptys live in main and outlive windows, so quit is the one place they die.
  const shells = killAllTerminals()
  if (shells > 0) console.log(`[terminal] killed ${shells} shell(s) on quit`)
  connection?.stop()
  folders?.close()
})
