import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc'
import type { DiscoveryUpdate } from '@shared/discovery'
import type { VoiceStreamEvent } from '@shared/voice-stream'
import type { VadClientEvent } from '@shared/hands-free'
import type { NotifyPrefs } from '@shared/notification-prefs'
import type { CloseMode } from '@shared/tray-hint'
import type {
  ApprovalDecision,
  ApprovalRequest,
  BeaconBridge,
  ChatSendRequest,
  ChatStreamFrame,
  ChatUploadRequest,
  ConnectionStatus,
  ConnectionTestRequest,
  DaemonWriteMethod,
  PairRequest,
  SetupProbeRequest,
  SaveConnectionSettingsRequest,
  SetupRequest,
  UpdaterStatus
} from '@shared/ipc'
import type { TerminalExit, TerminalOpenRequest, TerminalPlacement } from '@shared/terminal'
import type { GatewayEvent } from '@shared/gateway-events'
import type { LoopProject } from '@shared/loop'
import type { IntegrationEntry } from '@shared/integrations'
import { BROWSER_IPC, type BrowserState, type ChromeKey, type FindRequest, type ViewRect, type ZoomDirection } from '@shared/browser-pane'

// The ONLY bridge between the sandboxed renderer and Node. Every method maps to one
// allowlisted channel (spec §3.5); there is no general-purpose Node exposure.
const api: BeaconBridge = {
  platform: process.platform,
  connection: {
    status: () => ipcRenderer.invoke(IPC.CONNECTION_STATUS),
    onStatus: (cb: (s: ConnectionStatus) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, s: ConnectionStatus): void => cb(s)
      ipcRenderer.on(IPC.CONNECTION_STATUS_CHANGED, listener)
      return () => ipcRenderer.removeListener(IPC.CONNECTION_STATUS_CHANGED, listener)
    },
    getSettings: () => ipcRenderer.invoke(IPC.CONNECTION_GET_SETTINGS),
    saveSettings: (req: SaveConnectionSettingsRequest) => ipcRenderer.invoke(IPC.CONNECTION_SAVE_SETTINGS, req),
    onOpenSettings: (cb: () => void) => {
      const listener = (): void => cb()
      ipcRenderer.on(IPC.OPEN_SETTINGS, listener)
      return () => ipcRenderer.removeListener(IPC.OPEN_SETTINGS, listener)
    },
    onFolderChanged: (cb: () => void) => {
      const listener = (): void => cb()
      ipcRenderer.on(IPC.CACHE_FOLDER_CHANGED, listener)
      return () => ipcRenderer.removeListener(IPC.CACHE_FOLDER_CHANGED, listener)
    },
    reconnect: () => ipcRenderer.invoke(IPC.CONNECTION_RECONNECT),
    test: (req?: ConnectionTestRequest) => ipcRenderer.invoke(IPC.CONNECTION_TEST, req)
  },
  chat: {
    send: (req: ChatSendRequest) => ipcRenderer.invoke(IPC.CHAT_SEND, req),
    upload: (req: ChatUploadRequest) => ipcRenderer.invoke(IPC.CHAT_UPLOAD, req),
    interrupt: (sessionId: string) => ipcRenderer.invoke(IPC.CHAT_INTERRUPT, sessionId),
    onStream: (cb: (f: ChatStreamFrame) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, f: ChatStreamFrame): void => cb(f)
      ipcRenderer.on(IPC.CHAT_STREAM, listener)
      return () => ipcRenderer.removeListener(IPC.CHAT_STREAM, listener)
    }
  },
  computer: {
    stopTask: (taskId: string) => ipcRenderer.invoke(IPC.COMPUTER_TASK_STOP, taskId),
    listApps: () => ipcRenderer.invoke(IPC.COMPUTER_APPS),
    getBinding: (sessionId: string) => ipcRenderer.invoke(IPC.COMPUTER_BINDING_GET, sessionId),
    setBinding: (sessionId: string, app: string) =>
      ipcRenderer.invoke(IPC.COMPUTER_BINDING_SET, { sessionId, app }),
    clearBinding: (sessionId: string) => ipcRenderer.invoke(IPC.COMPUTER_BINDING_CLEAR, sessionId),
    startTask: (body: Record<string, string>) => ipcRenderer.invoke(IPC.COMPUTER_TASK_START, body)
  },
  sessions: {
    list: () => ipcRenderer.invoke(IPC.SESSIONS_LIST),
    projectHints: () => ipcRenderer.invoke(IPC.SESSIONS_PROJECT_HINTS)
  },
  history: {
    fetch: (sessionId: string, limit?: number) =>
      ipcRenderer.invoke(IPC.HISTORY_FETCH, { sessionId, limit }),
    backfill: (sessionId: string) => ipcRenderer.invoke(IPC.HISTORY_BACKFILL, { sessionId })
  },
  outbox: {
    status: () => ipcRenderer.invoke(IPC.OUTBOX_STATUS)
  },
  settings: {
    get: (key: string) => ipcRenderer.invoke(IPC.SETTINGS_GET, key),
    set: (key: string, value: string) => ipcRenderer.invoke(IPC.SETTINGS_SET, { key, value })
  },
  notifications: {
    prefs: () => ipcRenderer.invoke(IPC.NOTIFY_PREFS_GET),
    setPrefs: (prefs: NotifyPrefs) => ipcRenderer.invoke(IPC.NOTIFY_PREFS_SET, prefs),
    closeMode: () => ipcRenderer.invoke(IPC.CLOSE_MODE_GET),
    setCloseMode: (mode: CloseMode) => ipcRenderer.invoke(IPC.CLOSE_MODE_SET, mode)
  },
  gateway: {
    profiles: () => ipcRenderer.invoke(IPC.GATEWAY_PROFILES)
  },
  trace: (e: import('@shared/ui-trace').UiTraceEvent) => ipcRenderer.send(IPC.UI_TRACE, e),
  watchdog: (e: import('@shared/watchdog-log').WatchdogEvent) => ipcRenderer.send(IPC.WATCHDOG_EVENT, e),
  /** Push the active skin's chrome colours so the OS window buttons match the bar they sit on.
   *  Send-only: main ignores it on macOS, where the traffic lights are the system's own. */
  setTitlebarOverlay: (colors: { color: string; symbolColor: string }) =>
    ipcRenderer.send(IPC.TITLEBAR_OVERLAY, colors),
  reloadWindow: () => ipcRenderer.send(IPC.WINDOW_RELOAD),
  approvals: {
    list: () => ipcRenderer.invoke(IPC.APPROVALS_LIST),
    resolve: (requestId: string, decision: ApprovalDecision) =>
      ipcRenderer.invoke(IPC.APPROVAL_RESOLVE, { requestId, decision }),
    notifyCount: (n: number) => ipcRenderer.send(IPC.APPROVALS_COUNT, n),
    notifyNew: (requests: ApprovalRequest[]) => ipcRenderer.send(IPC.APPROVALS_NEW, requests)
  },
  voice: {
    turn: (audioBase64: string) => ipcRenderer.invoke(IPC.VOICE_TURN, { audioBase64 }),
    turnStream: (audioBase64: string) => ipcRenderer.invoke(IPC.VOICE_TURN_STREAM, { audioBase64 }),
    onStreamEvent: (cb: (ev: VoiceStreamEvent) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, ev: VoiceStreamEvent): void => cb(ev)
      ipcRenderer.on(IPC.VOICE_STREAM_EVENT, listener)
      return () => ipcRenderer.removeListener(IPC.VOICE_STREAM_EVENT, listener)
    },
    dictate: (audioBase64: string) => ipcRenderer.invoke(IPC.VOICE_DICTATE, { audioBase64 }),
    configured: () => ipcRenderer.invoke(IPC.VOICE_CONFIGURED),
    preflight: () => ipcRenderer.invoke(IPC.VOICE_PREFLIGHT)
  },
  vad: {
    start: () => ipcRenderer.invoke(IPC.VAD_START),
    stop: () => ipcRenderer.invoke(IPC.VAD_STOP),
    reset: () => ipcRenderer.invoke(IPC.VAD_RESET),
    audio: (chunk: Float32Array) => ipcRenderer.send(IPC.VAD_AUDIO, chunk),
    onEvent: (cb: (ev: VadClientEvent) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, ev: VadClientEvent): void => cb(ev)
      ipcRenderer.on(IPC.VAD_EVENT, listener)
      return () => ipcRenderer.removeListener(IPC.VAD_EVENT, listener)
    }
  },
  events: {
    onGateway: (cb: (ev: GatewayEvent) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, ev: GatewayEvent): void => cb(ev)
      ipcRenderer.on(IPC.GATEWAY_EVENT, listener)
      return () => ipcRenderer.removeListener(IPC.GATEWAY_EVENT, listener)
    },
    recent: (limit?: number) => ipcRenderer.invoke(IPC.EVENTS_RECENT, limit)
  },
  artifacts: {
    list: () => ipcRenderer.invoke(IPC.ARTIFACTS_LIST),
    download: (id: string, name: string) => ipcRenderer.invoke(IPC.ARTIFACT_DOWNLOAD, { id, name }),
    read: (id: string, name: string, mime?: string, size?: number) =>
      ipcRenderer.invoke(IPC.ARTIFACT_READ, { id, name, mime, size })
  },
  daemon: {
    get: (path: string) => ipcRenderer.invoke(IPC.DAEMON_GET, path),
    write: (path: string, body?: unknown, method?: DaemonWriteMethod) =>
      ipcRenderer.invoke(IPC.DAEMON_WRITE, { path, body, method })
  },
  session: {
    setActive: (sessionId: string) => ipcRenderer.send(IPC.SESSION_ACTIVE, sessionId),
    setVisible: (sessionIds: string[]) => ipcRenderer.send(IPC.SESSION_VISIBLE, sessionIds),
    export: (sessionId: string, format: string, meta?: { title?: string; gateway?: string }) =>
      ipcRenderer.invoke(IPC.SESSION_EXPORT, { sessionId, format, meta }),
    forget: (sessionId: string) => ipcRenderer.invoke(IPC.SESSION_FORGET, sessionId),
    onSwitch: (cb: (sessionId: string) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, sessionId: string): void => cb(sessionId)
      ipcRenderer.on(IPC.SESSION_SWITCH, listener)
      return () => ipcRenderer.removeListener(IPC.SESSION_SWITCH, listener)
    }
  },
  sessionWindows: {
    open: (sessionId: string) => ipcRenderer.invoke(IPC.SESSION_WINDOW_OPEN, sessionId),
    requestClose: (sessionId: string) => ipcRenderer.invoke(IPC.SESSION_WINDOW_REQUEST_CLOSE, sessionId),
    closeReady: (returnToMain: boolean) => ipcRenderer.invoke(IPC.SESSION_WINDOW_CLOSE_READY, returnToMain === true),
    list: () => ipcRenderer.invoke(IPC.SESSION_WINDOW_LIST),
    onChanged: (cb: (sessionIds: string[]) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, ids: string[]): void => cb(Array.isArray(ids) ? ids : [])
      ipcRenderer.on(IPC.SESSION_WINDOWS_CHANGED, listener)
      return () => ipcRenderer.removeListener(IPC.SESSION_WINDOWS_CHANGED, listener)
    },
    onClosing: (cb: () => void) => {
      const listener = (): void => cb()
      ipcRenderer.on(IPC.SESSION_WINDOW_CLOSING, listener)
      return () => ipcRenderer.removeListener(IPC.SESSION_WINDOW_CLOSING, listener)
    }
  },
  setup: {
    status: () => ipcRenderer.invoke(IPC.SETUP_STATUS),
    save: (req: SetupRequest) => ipcRenderer.invoke(IPC.SETUP_SAVE, req),
    pair: (req: PairRequest) => ipcRenderer.invoke(IPC.SETUP_PAIR, req),
    pairPoll: () => ipcRenderer.invoke(IPC.SETUP_PAIR_POLL),
    probe: (req: SetupProbeRequest) => ipcRenderer.invoke(IPC.SETUP_PROBE, req),
    forget: () => ipcRenderer.invoke(IPC.SETUP_FORGET)
  },
  discovery: {
    start: (req?: { quiet?: boolean }) => ipcRenderer.invoke(IPC.DISCOVERY_START, req),
    stop: () => ipcRenderer.invoke(IPC.DISCOVERY_STOP),
    probeAddress: (req: { host: string; port: number }) => ipcRenderer.invoke(IPC.DISCOVERY_PROBE, req),
    openLocalNetworkSettings: () => ipcRenderer.invoke(IPC.DISCOVERY_OPEN_SETTINGS),
    onUpdate: (cb: (u: DiscoveryUpdate) => void) => {
      const handler = (_e: unknown, u: DiscoveryUpdate): void => cb(u)
      ipcRenderer.on(IPC.DISCOVERY_UPDATE, handler)
      return () => ipcRenderer.removeListener(IPC.DISCOVERY_UPDATE, handler)
    }
  },
  pairing: {
    requests: () => ipcRenderer.invoke(IPC.PAIRING_LIST),
    approve: (req) => ipcRenderer.invoke(IPC.PAIRING_APPROVE, req),
    deny: (requestId) => ipcRenderer.invoke(IPC.PAIRING_DENY, requestId),
    onRequests: (cb) => {
      const handler = (_e: unknown, r: Parameters<typeof cb>[0]): void => cb(r)
      ipcRenderer.on(IPC.PAIRING_REQUESTS, handler)
      return () => ipcRenderer.removeListener(IPC.PAIRING_REQUESTS, handler)
    }
  },
  join: {
    begin: (req) => ipcRenderer.invoke(IPC.JOIN_BEGIN, req),
    poll: () => ipcRenderer.invoke(IPC.JOIN_POLL),
    cancel: () => ipcRenderer.invoke(IPC.JOIN_CANCEL)
  },
  pathA: {
    check: () => ipcRenderer.invoke(IPC.PATHA_CHECK),
    openStorageSettings: () => ipcRenderer.invoke(IPC.PATHA_OPEN_STORAGE),
    installStart: () => ipcRenderer.invoke(IPC.PATHA_INSTALL_START),
    installCancel: () => ipcRenderer.invoke(IPC.PATHA_INSTALL_CANCEL),
    onInstallUpdate: (cb) => {
      const handler = (_e: unknown, v: Parameters<typeof cb>[0]): void => cb(v)
      ipcRenderer.on(IPC.PATHA_INSTALL_UPDATE, handler)
      return () => ipcRenderer.removeListener(IPC.PATHA_INSTALL_UPDATE, handler)
    },
    openLoginItems: () => ipcRenderer.invoke(IPC.PATHA_OPEN_LOGIN_ITEMS)
  },
  capture: {
    openMain: (sessionId: string) => ipcRenderer.send(IPC.CAPTURE_OPEN_MAIN, sessionId)
  },
  screenshot: {
    sources: () => ipcRenderer.invoke(IPC.SCREENSHOT_SOURCES),
    grab: (sourceId: string) => ipcRenderer.invoke(IPC.SCREENSHOT_GRAB, sourceId),
    openSettings: () => ipcRenderer.send(IPC.SCREENSHOT_OPEN_SETTINGS)
  },
  loop: {
    listProjects: () => ipcRenderer.invoke(IPC.LOOP_PROJECTS_GET),
    saveProjects: (projects: LoopProject[]) => ipcRenderer.invoke(IPC.LOOP_PROJECTS_SET, projects),
    readFile: (path: string) => ipcRenderer.invoke(IPC.LOOP_FILE_READ, path),
    writeFile: (path: string, content: string) => ipcRenderer.invoke(IPC.LOOP_FILE_WRITE, { path, content }),
    pickFile: () => ipcRenderer.invoke(IPC.LOOP_FILE_PICK)
  },
  integrations: {
    status: () => ipcRenderer.invoke(IPC.INTEGRATIONS_STATUS),
    save: (entries: IntegrationEntry[]) => ipcRenderer.invoke(IPC.INTEGRATIONS_SET, entries),
    get: (integrationId: string, relPath: string) =>
      ipcRenderer.invoke(IPC.INTEGRATIONS_GET, integrationId, relPath),
    invoke: (integrationId: string, relPath: string, method: string) =>
      ipcRenderer.invoke(IPC.INTEGRATIONS_INVOKE, integrationId, relPath, method),
    setToken: (integrationId: string, token: string) =>
      ipcRenderer.invoke(IPC.INTEGRATIONS_SET_TOKEN, integrationId, token),
    reveal: () => ipcRenderer.invoke(IPC.INTEGRATIONS_REVEAL)
  },
  // Browser pane — the chrome's controls. Nothing here takes page content IN; extract() returns
  // text OUT, once, on a click. See @shared/browser-pane for the invariant.
  browser: {
    navigate: (input: string) => ipcRenderer.invoke(BROWSER_IPC.NAVIGATE, input),
    back: () => ipcRenderer.send(BROWSER_IPC.BACK),
    forward: () => ipcRenderer.send(BROWSER_IPC.FORWARD),
    reload: () => ipcRenderer.send(BROWSER_IPC.RELOAD),
    stop: () => ipcRenderer.send(BROWSER_IPC.STOP),
    zoom: (dir: ZoomDirection) => ipcRenderer.send(BROWSER_IPC.ZOOM, dir),
    find: (req: FindRequest) => ipcRenderer.send(BROWSER_IPC.FIND, req),
    extract: () => ipcRenderer.invoke(BROWSER_IPC.EXTRACT),
    bounds: (rect: ViewRect | null) => ipcRenderer.send(BROWSER_IPC.BOUNDS, rect),
    state: () => ipcRenderer.invoke(BROWSER_IPC.STATE_GET),
    onState: (cb: (s: BrowserState) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, s: BrowserState): void => cb(s)
      ipcRenderer.on(BROWSER_IPC.STATE, listener)
      return () => ipcRenderer.removeListener(BROWSER_IPC.STATE, listener)
    },
    onChromeKey: (cb: (key: ChromeKey) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, key: ChromeKey): void => cb(key)
      ipcRenderer.on(BROWSER_IPC.CHROME_KEY, listener)
      return () => ipcRenderer.removeListener(BROWSER_IPC.CHROME_KEY, listener)
    },
    detach: () => ipcRenderer.send(BROWSER_IPC.DETACH),
    reattach: () => ipcRenderer.send(BROWSER_IPC.REATTACH),
    onComposeInsert: (cb: (text: string) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, text: string): void => cb(text)
      ipcRenderer.on(BROWSER_IPC.COMPOSE_INSERT, listener)
      return () => ipcRenderer.removeListener(BROWSER_IPC.COMPOSE_INSERT, listener)
    },
    newTab: () => ipcRenderer.send(BROWSER_IPC.TAB_NEW),
    closeTab: (id: string) => ipcRenderer.send(BROWSER_IPC.TAB_CLOSE, id),
    selectTab: (id: string) => ipcRenderer.send(BROWSER_IPC.TAB_SELECT, id),
    moveTab: (id: string, toIndex: number) => ipcRenderer.send(BROWSER_IPC.TAB_MOVE, { id, toIndex })
  },
  terminal: {
    open: (req: TerminalOpenRequest) => ipcRenderer.invoke(IPC.TERMINAL_OPEN, req),
    list: () => ipcRenderer.invoke(IPC.TERMINAL_LIST),
    attach: (id: string, cols: number, rows: number) => ipcRenderer.invoke(IPC.TERMINAL_ATTACH, id, cols, rows),
    detach: (id: string) => ipcRenderer.send(IPC.TERMINAL_DETACH, id),
    write: (id: string, data: string) => ipcRenderer.send(IPC.TERMINAL_WRITE, id, data),
    resize: (id: string, cols: number, rows: number) => ipcRenderer.send(IPC.TERMINAL_RESIZE, id, cols, rows),
    rename: (id: string, title: string) => ipcRenderer.invoke(IPC.TERMINAL_RENAME, id, title),
    close: (id: string) => ipcRenderer.invoke(IPC.TERMINAL_CLOSE, id),
    onData: (cb: (m: { id: string; data: string }) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, m: { id: string; data: string }): void => cb(m)
      ipcRenderer.on(IPC.TERMINAL_DATA, listener)
      return () => ipcRenderer.removeListener(IPC.TERMINAL_DATA, listener)
    },
    onExit: (cb: (m: { id: string; exit: TerminalExit }) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, m: { id: string; exit: TerminalExit }): void => cb(m)
      ipcRenderer.on(IPC.TERMINAL_EXIT, listener)
      return () => ipcRenderer.removeListener(IPC.TERMINAL_EXIT, listener)
    },
    popOut: () => ipcRenderer.invoke(IPC.TERMINAL_POP_OUT),
    popIn: () => ipcRenderer.send(IPC.TERMINAL_POP_IN),
    placement: () => ipcRenderer.invoke(IPC.TERMINAL_PLACEMENT_GET),
    peers: () => ipcRenderer.invoke(IPC.TERMINAL_PEERS),
    onPlacement: (cb: (p: TerminalPlacement) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, p: TerminalPlacement): void => cb(p)
      ipcRenderer.on(IPC.TERMINAL_PLACEMENT, listener)
      return () => ipcRenderer.removeListener(IPC.TERMINAL_PLACEMENT, listener)
    }
  },
  updater: {
    status: () => ipcRenderer.invoke(IPC.UPDATER_STATUS),
    check: () => ipcRenderer.invoke(IPC.UPDATER_CHECK).then(() => undefined),
    install: () => ipcRenderer.invoke(IPC.UPDATER_INSTALL),
    onStatus: (cb: (s: UpdaterStatus) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, s: UpdaterStatus): void => cb(s)
      ipcRenderer.on(IPC.UPDATER_STATUS_CHANGED, listener)
      return () => ipcRenderer.removeListener(IPC.UPDATER_STATUS_CHANGED, listener)
    }
  },
  loginItem: {
    get: () => ipcRenderer.invoke(IPC.LOGIN_ITEM_GET),
    set: (openAtLogin: boolean) => ipcRenderer.invoke(IPC.LOGIN_ITEM_SET, openAtLogin)
  },
  network: {
    get: () => ipcRenderer.invoke(IPC.NETWORK_GET),
    set: (on: boolean) => ipcRenderer.invoke(IPC.NETWORK_SET, on),
    restart: () => ipcRenderer.invoke(IPC.NETWORK_RESTART)
  },
  pairPin: {
    decide: (host: string) => ipcRenderer.invoke(IPC.PAIR_PIN, host)
  },
  ownerPromotion: {
    redeem: (code: string) => ipcRenderer.invoke(IPC.OWNER_PROMOTE, code)
  },
  mainModel: {
    get: () => ipcRenderer.invoke(IPC.MAIN_MODEL_GET),
    check: (provider: string, key: string, checkable: boolean) => ipcRenderer.invoke(IPC.MAIN_MODEL_CHECK, provider, key, checkable),
    signIn: () => ipcRenderer.invoke(IPC.MAIN_MODEL_SIGNIN),
    cancelSignIn: () => ipcRenderer.invoke(IPC.MAIN_MODEL_SIGNIN_CANCEL),
    save: (provider: string, version: string, useNewKey: boolean) => ipcRenderer.invoke(IPC.MAIN_MODEL_SAVE, provider, version, useNewKey)
  },
  model: {
    signIn: () => ipcRenderer.invoke(IPC.MODEL_SIGNIN),
    cancelSignIn: () => ipcRenderer.invoke(IPC.MODEL_SIGNIN_CANCEL),
    checkKey: (company: 'anthropic' | 'openai', key: string) => ipcRenderer.invoke(IPC.MODEL_CHECK_KEY, company, key),
    finish: () => ipcRenderer.invoke(IPC.MODEL_FINISH),
    onUpdate: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, v: import('@shared/model-setup').ModelSetupView): void => cb(v)
      ipcRenderer.on(IPC.MODEL_UPDATE, listener)
      return () => ipcRenderer.removeListener(IPC.MODEL_UPDATE, listener)
    }
  },
  legal: {
    open: (doc) => ipcRenderer.invoke(IPC.LEGAL_DOC_OPEN, doc)
  },
  systemTheme: {
    isDark: () => ipcRenderer.invoke(IPC.SYSTEM_THEME_GET),
    onChange: (cb: (isDark: boolean) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, isDark: boolean): void => cb(isDark)
      ipcRenderer.on(IPC.SYSTEM_THEME_CHANGED, listener)
      return () => ipcRenderer.removeListener(IPC.SYSTEM_THEME_CHANGED, listener)
    }
  }
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('beacon', api)
} else {
  // contextIsolation is always on (see main webPreferences); this branch is a safety net.
  ;(globalThis as unknown as { beacon: BeaconBridge }).beacon = api
}
