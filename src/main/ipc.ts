import { exportFilename, renderExport, type ExportFormat } from '@shared/session-export'
import { ARTIFACT_PREVIEW_MAX_BYTES, previewKindFor, renderKindFor, utf8SafeEnd, type ArtifactPreview } from '@shared/artifacts'
import type { WatchdogEvent } from '@shared/watchdog-log'
import { app, shell } from 'electron'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { UiTraceEvent } from '@shared/ui-trace'
import { IPC } from '@shared/ipc'
import { doorRefusal } from '@shared/computer-door'
import type {
  ApprovalDecision,
  ArtifactDownloadResult,
  ChatSendRequest,
  ChatUploadRequest,
  ConnectionSettings,
  ConnectionTestRequest,
  ConnectionTestResult,
  DaemonWriteMethod,
  PairPollResult,
  PairRequest,
  PairResult,
  SetupProbeRequest,
  SetupProbeResult,
  SaveConnectionSettingsRequest,
  SaveConnectionSettingsResult,
  SetupRequest,
  SetupForgetResult,
  SetupResult,
  SetupStatus,
  SessionExportResult,
  HistoryMessage
} from '@shared/ipc'
import type { ConnectionManager } from './connection'
import type { CacheService } from './cache/service'
import type { CacheRepo } from './cache/repo'
import { handleFromShell, onFromShell } from './shell-windows'

/** The connection + cache are built lazily (at startup if configured, or on first-run save), so the
 * handlers read them through getters and degrade gracefully before a connection exists (setup mode). */
export interface IpcDeps {
  repo: CacheRepo
  getConnection: () => ConnectionManager | null
  getCache: () => CacheService | null
  setupStatus: () => Promise<SetupStatus>
  saveSetup: (req: SetupRequest) => Promise<SetupResult>
  forgetConnection: () => SetupForgetResult
  pairWithCode: (req: PairRequest) => Promise<PairResult>
  pairPoll: () => Promise<PairPollResult>
  probeSetup: (req: SetupProbeRequest) => Promise<SetupProbeResult>
  getConnectionSettings: () => ConnectionSettings
  saveConnectionSettings: (req: SaveConnectionSettingsRequest) => Promise<SaveConnectionSettingsResult>
  testConnection: (req: ConnectionTestRequest) => Promise<ConnectionTestResult>
}

/**
 * Register the allowlisted IPC surface (spec §3.5) ONCE. Connection-facing channels run through the
 * current ConnectionManager + CacheService; setup channels gate first-run. The renderer has no other
 * path into Node. Every channel answers only the shell page in a window Beacon created
 * (handleFromShell / onFromShell); any other sender gets null, or nothing.
 */
/**
 * Sanitize, uniquify, write, reveal. ONE definition: the artifact download and the conversation
 * export both land in ~/Downloads, and two copies of these rules would drift the first time one
 * of them learned something (a session id carries a colon; a name can start with a dot).
 */
async function saveToDownloads(name: string, data: Buffer | string, fallback: string): Promise<string> {
  const base =
    (typeof name === 'string' ? name : '')
      .replace(/[/\\]/g, '_')
      .replace(/^\.+/, '')
      .slice(0, 128)
      .trim() || fallback
  const dir = app.getPath('downloads')
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''
  let target = join(dir, base)
  for (let n = 2; existsSync(target); n++) target = join(dir, `${stem} (${n})${ext}`)
  await writeFile(target, data)
  shell.showItemInFolder(target)
  return target
}

export function registerIpcHandlers(deps: IpcDeps): void {
  handleFromShell(IPC.CONNECTION_STATUS, async () => deps.getConnection()?.getStatus() ?? { state: 'idle', gateway: null })

  handleFromShell(IPC.CHAT_SEND, async (_e, req: ChatSendRequest) => {
    const cache = deps.getCache()
    return cache ? cache.send(req) : { runId: '', status: 'not-connected' }
  })

  // Uploads go straight over the live WS (not the cache/outbox) — there's no durable optimistic row;
  // the daemon converts the file to text and broadcasts the echo like any other turn.
  handleFromShell(IPC.CHAT_UPLOAD, async (_e, req: ChatUploadRequest) => deps.getConnection()?.uploadFile(req) ?? false)

  // Stop the running turn (P9.1). Straight over REST like upload — there is nothing to outbox: a
  // stop request that cannot reach the daemon NOW is useless later (the turn it targets is long
  // gone), so not-connected reports stopped:false + a reason rather than queueing.
  handleFromShell(IPC.CHAT_INTERRUPT, async (_e, sessionId: string) => {
    const conn = deps.getConnection()
    if (!conn) return { stopped: false, error: 'not connected' }
    try {
      return await conn.interruptChat(sessionId)
    } catch (e) {
      return { stopped: false, error: String(e) }
    }
  })

  // Stop ONE desktop task (Prometheus#663). Same shape as CHAT_INTERRUPT and for the same reason
  // nothing is queued: a stop that cannot reach the daemon now is useless later. The WS is tried
  // first (its ack lands in the gateway store), REST when the socket is not open.
  handleFromShell(IPC.COMPUTER_TASK_STOP, async (_e, taskId: string) => {
    const conn = deps.getConnection()
    if (!conn) return { sent: false, error: 'not connected' }
    if (typeof taskId !== 'string' || !taskId) return { sent: false, error: 'no task id' }
    try {
      return await conn.stopComputerTask(taskId)
    } catch (e) {
      return { sent: false, error: String(e) }
    }
  })

  // ── the desktop door (v1.1 PR 7) ─────────────────────────────────────────
  // Each returns a DoorOutcome: on success {ok:true, value}, on any refusal
  // {ok:false, refusal} carrying the daemon's own {code, message, fromDaemon,
  // options, describes, app}. Nothing here throws and nothing re-words the
  // daemon — the refusal the renderer shows is the one the door wrote. A
  // missing connection is the one refusal this layer synthesises, shaped like
  // the daemon's so the renderer has one branch to handle.
  const doorNoConn = (): { ok: false; refusal: ReturnType<typeof doorRefusal> } => ({
    ok: false, refusal: doorRefusal(0, { error: 'network' })
  })

  handleFromShell(IPC.COMPUTER_APPS, async () => {
    const conn = deps.getConnection()
    if (!conn) return doorNoConn()
    return conn.listComputerApps()
  })

  handleFromShell(IPC.COMPUTER_BINDING_GET, async (_e, sessionId: string) => {
    const conn = deps.getConnection()
    if (!conn) return doorNoConn()
    if (typeof sessionId !== 'string' || !sessionId) return doorNoConn()
    return conn.getComputerBinding(sessionId)
  })

  handleFromShell(IPC.COMPUTER_BINDING_SET, async (_e, args: { sessionId: string; app: string }) => {
    const conn = deps.getConnection()
    if (!conn) return doorNoConn()
    if (typeof args?.sessionId !== 'string' || !args.sessionId) return doorNoConn()
    if (typeof args?.app !== 'string' || !args.app) return doorNoConn()
    return conn.setComputerBinding(args.sessionId, args.app)
  })

  handleFromShell(IPC.COMPUTER_BINDING_CLEAR, async (_e, sessionId: string) => {
    const conn = deps.getConnection()
    if (!conn) return doorNoConn()
    if (typeof sessionId !== 'string' || !sessionId) return doorNoConn()
    return conn.clearComputerBinding(sessionId)
  })

  handleFromShell(IPC.COMPUTER_TASK_START, async (_e, body: Record<string, string>) => {
    const conn = deps.getConnection()
    if (!conn) return doorNoConn()
    if (!body || typeof body !== 'object') return doorNoConn()
    // The goal is the one field the daemon requires; refuse here rather than
    // spend a round-trip on a 400 the renderer already knows to prevent.
    if (typeof body.goal !== 'string' || !body.goal.trim()) return doorNoConn()
    return conn.startComputerTask(body)
  })

  handleFromShell(IPC.SESSIONS_LIST, async () => {
    const cache = deps.getCache()
    return cache ? cache.listSessions() : []
  })

  // A hint is a suggestion, so a failure here costs only the chips: say so in the main log and
  // return none, rather than rejecting into the sidebar.
  handleFromShell(IPC.SESSIONS_PROJECT_HINTS, async () => {
    const cache = deps.getCache()
    if (!cache) return {}
    try {
      return cache.projectHints()
    } catch (e) {
      console.warn('[ipc] project hints failed:', e instanceof Error ? e.message : e)
      return {}
    }
  })

  handleFromShell(IPC.HISTORY_FETCH, async (_e, args: { sessionId: string; limit?: number }) => {
    const cache = deps.getCache()
    if (!cache) return []
    // Reconcile failures must be LOUD in the main log (live-walk finding: a silent swallow here
    // rendered a 45-message session as empty with zero trace).
    const warn = (e: unknown): void =>
      console.warn(`[ipc] history reconcile failed (${args.sessionId}):`, e instanceof Error ? e.message : e)
    const cached = cache.getHistory(args.sessionId)
    if (cached.length > 0) {
      void cache.reconcile(args.sessionId).catch(warn) // background refresh
      return cached
    }
    await cache.reconcile(args.sessionId).catch(warn)
    return cache.getHistory(args.sessionId)
  })

  // Jump-to-search-hit only: a full re-pull is expensive next to the forward cursor above, so it
  // is a separate channel the ordinary open path never touches. A failure here is LOUD for the
  // same reason HISTORY_FETCH's is — a silent empty return renders as "the message isn't there".
  handleFromShell(IPC.HISTORY_BACKFILL, async (_e, args: { sessionId: string }) => {
    const cache = deps.getCache()
    if (!cache) return []
    try {
      return await cache.backfill(args.sessionId)
    } catch (e) {
      console.warn(`[ipc] history backfill failed (${args.sessionId}):`, e instanceof Error ? e.message : e)
      return cache.getHistory(args.sessionId)
    }
  })

  handleFromShell(IPC.OUTBOX_STATUS, async () => deps.getCache()?.outboxStatus() ?? { pending: 0, failed: 0 })

  handleFromShell(IPC.APPROVALS_LIST, async () => deps.getConnection()?.listApprovals() ?? [])
  // DEV GATE, enforced in main so the renderer cannot bypass it and a packaged
  // build stores nothing. `send`, not `handle` — no reply, no round-trip added to
  // the path being measured.
  onFromShell(IPC.UI_TRACE, (_e, ev: UiTraceEvent) => {
    if (app.isPackaged) return
    deps.repo.recordUiTrace(ev)
  })

  // NO DEV GATE, deliberately. ui_events above is gated because it is
  // instrumentation for one question; this records the decision behind an
  // operator-facing alarm, and an alarm that cannot be audited in the build it
  // fires in is the defect this table exists to close.
  onFromShell(IPC.WATCHDOG_EVENT, (_e, ev: WatchdogEvent) => {
    deps.repo.recordWatchdogEvent(ev)
  })

  handleFromShell(IPC.APPROVAL_RESOLVE, async (_e, req: { requestId: string; decision: ApprovalDecision }) => {
    // BREADCRUMB 4 — what actually ARRIVED in main. If rows 1-3 exist and this one
    // does not, the call never crossed the boundary; that is the whole question.
    if (!app.isPackaged) {
      deps.repo.recordUiTrace({
        point: 'main:handler-enter',
        at: Date.now(),
        mono: performance.now(),
        proc: 'main',
        requestId: req?.requestId,
        scope: req?.decision?.kind === 'approve' ? req.decision.scope : undefined,
        detail: `decision.kind=${req?.decision?.kind}`
      })
    }
    await deps.getConnection()?.resolveApproval(req.requestId, req.decision)
  })
  handleFromShell(IPC.EVENTS_RECENT, async (_e, limit?: number) => deps.getConnection()?.listRecentEvents(limit) ?? [])
  handleFromShell(IPC.DAEMON_GET, async (_e, path: string) => deps.getConnection()?.getDaemon(path) ?? null)
  // Artifacts (feat/artifacts-api): manifest for chip matching; download fetches the bytes IN MAIN
  // (the token never reaches the renderer), saves to ~/Downloads under a sanitized + uniquified
  // name, and reveals it — never opens/executes (an agent-produced file is data, not a program).
  handleFromShell(IPC.ARTIFACTS_LIST, async () => (await deps.getConnection()?.listArtifacts().catch(() => [])) ?? [])
  // Preview read: bytes are fetched AND classified here, so the renderer never holds a raw buffer.
  // Every refusal is a described outcome — a blank pane that could mean "empty file", "too big" or
  // "request failed" is the ambiguity this shape exists to prevent.
  //
  // The cap is checked TWICE, and the first check is the one that matters: the manifest already
  // states the size, so an oversize artifact is refused BEFORE any fetch. Checking only after
  // downloadArtifact() would buffer the whole file in main first and refuse a 500MB artifact it
  // had already read — protection the earlier version of this comment claimed but did not have.
  // The post-fetch check stays because the manifest is a claim, not a guarantee.
  handleFromShell(
    IPC.ARTIFACT_READ,
    async (_e, req: { id: string; name: string; mime?: string; size?: number }): Promise<ArtifactPreview> => {
      const conn = deps.getConnection()
      if (!conn) return { kind: 'error', message: 'not connected' }
      // An SVG is text on the wire and this read feeds the SOURCE view — the rendered view rides
      // the beacon-artifact:// protocol with the full bytes. Classifying it as 'image' here would
      // hand the panel a data URL it can't show source for.
      const kind = renderKindFor(req.mime, req.name) === 'svg' ? 'text' : previewKindFor(req.mime, req.name)
      if (kind === 'binary') return { kind: 'unsupported', mime: req.mime ?? '', reason: 'not a text or image type' }
      // An image cannot be shown in part, so an oversize one is refused outright — and refused
      // from the MANIFEST size, before a byte is fetched.
      if (kind === 'image' && typeof req.size === 'number' && req.size > ARTIFACT_PREVIEW_MAX_BYTES)
        return { kind: 'too-large', size: req.size }
      try {
        const buf = await conn.downloadArtifact(req.id)
        if (kind === 'image') {
          if (buf.byteLength > ARTIFACT_PREVIEW_MAX_BYTES) return { kind: 'too-large', size: buf.byteLength }
          return { kind: 'image', dataUrl: `data:${req.mime || 'image/png'};base64,${buf.toString('base64')}` }
        }
        // Text CAN be shown in part, so it truncates — on a character boundary, never a byte one.
        const truncated = buf.byteLength > ARTIFACT_PREVIEW_MAX_BYTES
        const end = truncated ? utf8SafeEnd(buf, ARTIFACT_PREVIEW_MAX_BYTES) : buf.byteLength
        return { kind: 'text', text: buf.subarray(0, end).toString('utf8'), truncated }
      } catch (err) {
        return { kind: 'error', message: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  handleFromShell(IPC.ARTIFACT_DOWNLOAD, async (_e, req: { id: string; name: string }): Promise<ArtifactDownloadResult> => {
    const conn = deps.getConnection()
    if (!conn) return { ok: false, error: 'not connected' }
    try {
      const buf = await conn.downloadArtifact(req.id)
      const target = await saveToDownloads(req.name, buf, 'artifact')
      return { ok: true, savedPath: target }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  handleFromShell(
    IPC.DAEMON_WRITE,
    async (_e, req: { path: string; body?: unknown; method?: DaemonWriteMethod }) =>
      deps.getConnection()?.writeDaemon(req.path, req.body, req.method) ?? null
  )

  handleFromShell(IPC.SETTINGS_GET, async (_e, key: string) => deps.repo.getSetting(key))
  handleFromShell(IPC.SETTINGS_SET, async (_e, payload: { key: string; value: string }) =>
    deps.repo.setSetting(payload.key, payload.value)
  )
  handleFromShell(IPC.GATEWAY_PROFILES, async () => deps.repo.listGatewayProfiles())

  handleFromShell(IPC.SETUP_STATUS, async () => deps.setupStatus())
  handleFromShell(IPC.SETUP_SAVE, async (_e, req: SetupRequest) => deps.saveSetup(req))
  handleFromShell(IPC.SETUP_FORGET, async () => deps.forgetConnection())
  handleFromShell(IPC.SETUP_PAIR, async (_e, req: PairRequest) => deps.pairWithCode(req))
  handleFromShell(IPC.SETUP_PAIR_POLL, async () => deps.pairPoll())
  handleFromShell(IPC.SETUP_PROBE, async (_e, req: SetupProbeRequest) => deps.probeSetup(req))
  handleFromShell(IPC.CONNECTION_GET_SETTINGS, async () => deps.getConnectionSettings())
  handleFromShell(IPC.CONNECTION_SAVE_SETTINGS, async (_e, req: SaveConnectionSettingsRequest) =>
    deps.saveConnectionSettings(req)
  )
  handleFromShell(IPC.CONNECTION_RECONNECT, async () => deps.getConnection()?.reconnect())
  handleFromShell(IPC.CONNECTION_TEST, async (_e, req?: ConnectionTestRequest) => deps.testConnection(req ?? {}))

  // Conversation export. Built in MAIN from the cache using the SAME content parser the renderer
  // draws from, so an export cannot quietly disagree with what was on screen.
  //
  // It BACKFILLS first (a full re-pull) rather than reading the cache as-is: the ordinary cursor
  // only moves forward, so a session Beacon first met over the socket can be missing everything
  // older than its first frame — and an export is exactly the operation where a hole matters and
  // would never be noticed. Export is deliberate and infrequent; completeness beats latency here.
  // If that pull fails the export still happens, and SAYS it may be partial.
  handleFromShell(
    IPC.SESSION_EXPORT,
    async (
      _e,
      req: { sessionId: string; format: ExportFormat; meta?: { title?: string; gateway?: string } }
    ): Promise<SessionExportResult> => {
      const cache = deps.getCache()
      if (!cache) return { ok: false, error: 'no local cache' }
      let warning: string | undefined
      let rows: HistoryMessage[]
      try {
        rows = await cache.backfill(req.sessionId)
      } catch (err) {
        rows = cache.getHistory(req.sessionId)
        warning = `exported from the local cache only — the daemon was unreachable (${err instanceof Error ? err.message : String(err)})`
      }
      try {
        const when = Date.now()
        const format: ExportFormat = req.format === 'json' ? 'json' : 'markdown'
        const body = renderExport(format, {
          sessionId: req.sessionId,
          title: req.meta?.title,
          gateway: req.meta?.gateway,
          exportedAt: when,
          appVersion: app.getVersion()
        }, rows)
        const target = await saveToDownloads(exportFilename(req.sessionId, format, when), body, 'beacon-export')
        return { ok: true, savedPath: target, messages: rows.length, warning }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  handleFromShell(IPC.SESSION_FORGET, async (_e, sessionId: string) => {
    await deps.getCache()?.forgetSession(sessionId)
    // The session's local overrides (title/viewed/pinned) go with it — leaving them was the leak.
    if (typeof sessionId === 'string' && sessionId) deps.repo.deleteSessionSettings(sessionId)
  })

  console.log('[ipc] handlers registered (setup + connection-gated)')
}
