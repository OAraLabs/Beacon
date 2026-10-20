import { Fragment, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import type { AgentStatusDTO, BackendStatusDTO } from '@shared/daemon-api'
import {
  buildClearPayload,
  buildSavePayload,
  coerceKeyServices,
  envVarFieldLabel,
  groupKeyServices,
  keysPutPath,
  serviceKeyState,
  type ProviderKeyServiceDTO
} from '@shared/model-keys'
import { catalogAuthBadges, MODELS_CATALOG_PATH } from '@shared/model-auth'
import { MainModelSection } from './MainModelSection'
import { backendReading, defaultRowLabel, isCloudPrimary } from '@shared/backend-health'
import { useBackendRecheck } from '../backend-recheck'
import { useDeviceRole } from './OwnerOnlyNote'
import {
  catalogNoteSummary,
  catalogVersions,
  hasVersionChoice,
  usageHint,
  versionsFor,
  type ModelVersion
} from '@shared/model-versions'
import {
  coerceOAuthStatus,
  formatExpiry,
  oauthPhase,
  pollDecision,
  XAI_OAUTH_LOGIN_PATH,
  XAI_OAUTH_PATH,
  type XaiOAuthStatusDTO
} from '@shared/xai-oauth'

// Config→Models (MODELS KEYS UI sprint): the per-provider key manager + the backend registry.
// Rows render from GET /api/providers/keys (booleans only — the daemon never returns key
// values, so inputs NEVER prefill); Save/Remove PUT /api/providers/keys/{service} through the
// existing scoped daemon bridge and refresh every chip from the PUT response. Keys go live in
// the daemon immediately (no restart) — that's the top-of-tab promise.
//
// Design handoff 2026-09-03 — this tab is the worked example for the dense-page rules:
//   R11 repeated records are a TABLE: backends are rows (host · runtime · model · endpoint ·
//       window · latency · state · Probe), not four ~90px cards.
//   R12 rank by exception: one summary line up top ("1 backend down · 1 provider without a
//       key") with a "Show only problems" filter; healthy rows are short.
//   R13 no raw machine syntax, no wrapping rows: the `pulled: a, b, c · loaded: d` paragraph is a
//       `N pulled` chip that expands; every cell ellipsizes. (0.4.8: freshness was a column of its
//       own; it is now a re-check and a tooltip time, @shared/backend-health.)
//   Prose sits ABOVE what it explains; a key field opens only on demand (Add / Replace key).

const MONO = 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)'
const card: CSSProperties = {
  background: 'var(--c-base)',
  border: '1px solid var(--c-line)',
  borderRadius: 8,
  padding: '10px 14px'
}
const groupHead: CSSProperties = {
  fontFamily: MONO,
  fontSize: 9,
  textTransform: 'uppercase',
  letterSpacing: 'var(--track-caps)',
  color: 'var(--ink3)',
  margin: '10px 0 2px'
}
const keyInput: CSSProperties = {
  flex: 1,
  minWidth: 220,
  fontSize: 12,
  fontFamily: MONO,
  padding: '6px 9px',
  borderRadius: 6,
  border: '1px solid var(--c-line)',
  background: 'var(--c-inset)',
  color: 'var(--c-text)',
  outline: 'none',
  font: 'inherit'
}
const saveBtn = (disabled: boolean, ok: boolean): CSSProperties => ({
  fontSize: 12,
  padding: '5px 14px',
  borderRadius: 6,
  border: `1px solid ${ok ? 'var(--c-ok)' : 'var(--c-line)'}`,
  background: 'var(--c-raise)',
  color: disabled ? 'var(--c-text-faint)' : ok ? 'var(--c-ok)' : 'var(--c-text)',
  cursor: disabled ? 'not-allowed' : 'pointer',
  flexShrink: 0,
  font: 'inherit'
})
// Disabled is a visible state (see DevicesPanel btn): the flag drives prop + style together.
const removeBtn = (disabled = false): CSSProperties => ({
  fontSize: 11,
  padding: '3px 9px',
  borderRadius: 6,
  border: '1px solid var(--c-line)',
  background: 'transparent',
  color: disabled ? 'var(--c-text-faint)' : 'var(--c-err)',
  cursor: disabled ? 'not-allowed' : 'pointer',
  flexShrink: 0,
  font: 'inherit'
})
const muted: CSSProperties = { color: 'var(--c-text-dim)', fontSize: 13 }
const th: CSSProperties = { fontFamily: MONO, fontSize: 9, letterSpacing: 'var(--track-caps)', textTransform: 'uppercase', color: 'var(--ink3)', textAlign: 'left', padding: '0 8px 4px 0', fontWeight: 400, whiteSpace: 'nowrap' }
const td: CSSProperties = { fontFamily: MONO, fontSize: 11.5, color: 'var(--ink5)', padding: '0 8px 0 0', height: 30, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 0, borderTop: '1px solid var(--line3)', verticalAlign: 'middle' }
// The CHIP is a word ("up", "checking", "down"), so it takes the -text variants; the dot beside it
// is a glyph and keeps the raw fill colours. Different jobs, different tokens.
const stateChip = (tone: 'ok' | 'idle' | 'err' | 'none'): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  fontFamily: MONO,
  fontSize: 10,
  letterSpacing: '0.06em',
  color: tone === 'ok' ? 'var(--online-text)' : tone === 'idle' ? 'var(--idle-text)' : tone === 'err' ? 'var(--sang-text)' : 'var(--ink4)'
})
const dot = (tone: 'ok' | 'idle' | 'err' | 'none'): CSSProperties => ({ width: 6, height: 6, borderRadius: '50%', flex: 'none', background: tone === 'ok' ? 'var(--online)' : tone === 'idle' ? 'var(--idle)' : tone === 'err' ? 'var(--sang)' : 'var(--ink4)' })
const countChip: CSSProperties = { fontFamily: MONO, fontSize: 10, color: 'var(--ink3)', background: 'var(--line3)', borderRadius: 4, padding: '1px 6px', border: 'none', cursor: 'pointer', font: 'inherit' }
const linkBtn: CSSProperties = { background: 'transparent', border: 'none', padding: 0, font: 'inherit', fontSize: 12, color: 'var(--lapis-text)', cursor: 'pointer', flexShrink: 0 }
const summaryBar = (trouble: boolean): CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '7px 12px',
  borderRadius: 8,
  border: `1px solid ${trouble ? 'var(--lapis)' : 'var(--line2)'}`,
  background: trouble ? 'var(--lapis-soft)' : 'transparent',
  fontSize: 12.5,
  color: 'var(--ink)',
  marginBottom: 12
})

const PLACEHOLDER = 'Paste key — stored on the mini, never shown again'

const oauthBtn = (disabled: boolean): CSSProperties => ({
  fontSize: 12,
  padding: '5px 14px',
  borderRadius: 6,
  border: '1px solid var(--c-arc)',
  background: 'var(--c-raise)',
  color: disabled ? 'var(--c-text-faint)' : 'var(--c-arc)',
  cursor: disabled ? 'not-allowed' : 'pointer',
  flexShrink: 0,
  font: 'inherit'
})

// "Or use your SuperGrok subscription" — sits under the xAI key input. Uses the
// daemon device-code endpoints (Prometheus PR 100): POST login returns a URL +
// short code (approve in a browser), then we poll GET status until it flips to
// signed-in. A successful sign-in takes effect on the next /xai turn — no key,
// no restart.
function XaiOAuthPanel({ onAuthChanged }: { onAuthChanged?: () => void }) {
  const [status, setStatus] = useState<XaiOAuthStatusDTO | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopPoll = (): void => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  const refresh = async (): Promise<XaiOAuthStatusDTO | null> => {
    const b = window.beacon
    if (!b) return null
    try {
      const s = coerceOAuthStatus(await b.daemon.get(XAI_OAUTH_PATH))
      setStatus(s)
      return s
    } catch {
      return null // old daemon / offline — the key input above still works
    }
  }

  useEffect(() => {
    void refresh()
    return stopPoll
  }, [])

  const startPolling = (): void => {
    stopPoll()
    pollRef.current = setInterval(() => {
      void refresh().then((s) => {
        if (!s) return
        const d = pollDecision(s)
        if (d === 'logged-in') {
          stopPoll()
          onAuthChanged?.() // the card's "via …" badge reflects the new credential
        } else if (d === 'error') {
          stopPoll()
          setErr(s.last_error ?? 'sign-in failed')
        }
      })
    }, 3000)
  }

  const signIn = async (): Promise<void> => {
    const b = window.beacon
    if (!b) return
    setBusy(true)
    setErr(null)
    try {
      setStatus(coerceOAuthStatus(await b.daemon.write(XAI_OAUTH_LOGIN_PATH, {}, 'POST')))
      startPolling()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const signOut = async (): Promise<void> => {
    const b = window.beacon
    if (!b) return
    setBusy(true)
    setErr(null)
    stopPoll()
    try {
      await b.daemon.write(XAI_OAUTH_PATH, {}, 'DELETE')
      await refresh()
      onAuthChanged?.()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const phase = status ? oauthPhase(status) : 'signed-out'
  const rowStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    marginTop: 10,
    paddingTop: 10,
    borderTop: '1px solid var(--c-line)',
    flexWrap: 'wrap'
  }

  return (
    <div style={rowStyle}>
      <span style={{ fontSize: 11, color: 'var(--c-text-dim)', flexShrink: 0 }}>
        Or use your SuperGrok subscription:
      </span>
      {phase === 'signed-in' ? (
        <>
          <span style={{ fontSize: 12, color: 'var(--c-ok)' }}>● Signed in</span>
          <span style={{ fontSize: 11, color: 'var(--c-text-faint)' }}>
            {formatExpiry(status?.expires_at ?? null, Date.now())}
          </span>
          <span style={{ flex: 1 }} />
          <button style={removeBtn(busy)} disabled={busy} onClick={() => void signOut()} title="Sign out of SuperGrok on the daemon">
            Sign out
          </button>
        </>
      ) : phase === 'awaiting-approval' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ fontSize: 12, color: 'var(--c-text)' }}>
            Approve at{' '}
            <a
              href={status?.verification_uri ?? undefined}
              target="_blank"
              rel="noreferrer"
              style={{ color: 'var(--c-arc)', textDecoration: 'none' }}
            >
              accounts.x.ai ↗
            </a>
            {status?.user_code ? (
              <>
                {' '}· code <span style={{ fontFamily: MONO, color: 'var(--c-text)' }}>{status.user_code}</span>
              </>
            ) : null}
          </span>
          <span style={{ fontSize: 11, color: 'var(--c-text-faint)' }}>Waiting for approval…</span>
        </div>
      ) : (
        <button style={oauthBtn(busy)} disabled={busy} onClick={() => void signIn()} title="Sign in with your SuperGrok / X Premium+ subscription — no API key needed">
          {busy ? 'Starting…' : 'Sign in with SuperGrok'}
        </button>
      )}
      {err ? <span style={{ fontSize: 11, color: 'var(--c-err)' }}>{err}</span> : null}
    </div>
  )
}

/** The versions one provider offers (Prometheus PR 542).
 *
 * NOT A CONTROL, and it deliberately no longer looks like one. This started as a
 * <select>, which was wrong: no daemon endpoint writes `slash_commands.<key>.model`,
 * so picking could not change anything, and a dropdown that does nothing is worse
 * than the plain string it replaced — it spends the user's attention and returns
 * nothing. The honest job here is ORGANISATION: say how many versions exist and
 * which, on the page whose whole purpose is "what can I run?".
 *
 * Uses this tab's established idiom (R13): a count chip that expands, exactly like
 * `N pulled` on the backend rows. Switching a chat is the composer picker's job,
 * and the expanded panel says so with the command that does it.
 *
 * Renders only when there is more than one — a "1 version" chip is noise, which is
 * why xai (single-entry on purpose) keeps the plain model string.
 *
 * Open state lives in ServiceRow so the expanded panel can sit BELOW the flex row
 * rather than inside it: R13 forbids wrapping rows. */
function VersionList({
  versions,
  open,
  onToggle
}: {
  versions: ModelVersion[]
  open: boolean
  onToggle: () => void
}): React.JSX.Element {
  const current = versions.find((v) => v.isDefault) ?? versions[0]
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
      <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--ink4)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {current?.model ?? ''}
      </span>
      <button
        data-testid="version-chip"
        style={countChip}
        onClick={onToggle}
        aria-expanded={open}
        title={versions.map((v) => v.model).join(', ')}
      >
        {versions.length} versions
      </button>
    </span>
  )
}

/** The expanded version panel — its own row, so the summary row never wraps (R13). */
function VersionPanel({
  serviceId,
  versions
}: {
  serviceId: string
  versions: ModelVersion[]
}): React.JSX.Element {
  return (
    <div style={{ padding: '2px 0 8px 106px', display: 'flex', flexDirection: 'column', gap: 3 }}>
      {versions.map((v) => (
        <div key={v.key} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontFamily: MONO, fontSize: 11, color: 'var(--ink3)' }}>
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.model}</span>
          {v.isDefault ? <span style={{ fontSize: 10, color: 'var(--ink4)' }}>default</span> : null}
          <span style={{ fontSize: 10, color: 'var(--ink4)' }}>{usageHint(serviceId, v)}</span>
        </div>
      ))}
    </div>
  )
}

function ServiceRow({
  svc,
  authBadge,
  versions,
  onCatalog,
  onAuthChanged
}: {
  svc: ProviderKeyServiceDTO
  /** "SuperGrok subscription" / "API key" — how the provider is connected right
   * now per GET /api/models `auth` (Prometheus PR 102); null → no caption. */
  authBadge: string | null
  /** Every selectable version for this provider, default first (Prometheus PR 542).
   * Empty / single → the row renders the plain model string exactly as before. */
  versions: ModelVersion[]
  onCatalog: (data: unknown) => void
  /** OAuth sign-in/out below changed what the daemon would use — refetch badges. */
  onAuthChanged: () => void
}) {
  const [typed, setTyped] = useState<Record<string, string>>({})
  const [versionsOpen, setVersionsOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // An input that is always open is an input that always costs space: the field opens on demand.
  const [open, setOpen] = useState(false)
  const state = serviceKeyState(svc)

  const put = async (payload: { values: Record<string, string> }): Promise<void> => {
    const b = window.beacon
    if (!b) return
    setBusy(true)
    setErr(null)
    try {
      const catalog = await b.daemon.write(keysPutPath(svc.id), payload, 'PUT')
      setTyped({}) // inputs go blank again — values are never re-shown
      onCatalog(catalog) // refresh every chip from the PUT response
      setSaved(true)
      setOpen(false)
      setTimeout(() => setSaved(false), 1800)
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      const match = m.match(/\{"error":"([^"]+)"\}/)
      setErr(match ? match[1] : m)
    } finally {
      setBusy(false)
    }
  }

  const payload = buildSavePayload(svc, typed)
  const tone: 'ok' | 'idle' | 'none' = state === 'set' ? 'ok' : state === 'partial' ? 'idle' : 'none'

  return (
    <div data-testid="provider-row" data-key-state={state}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, height: 32, borderTop: '1px solid var(--line3)', minWidth: 0 }}>
        <span style={{ fontSize: 13, color: 'var(--ink)', width: 96, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{svc.label}</span>
        {hasVersionChoice(versions) ? (
          <VersionList versions={versions} open={versionsOpen} onToggle={() => setVersionsOpen((o) => !o)} />
        ) : (
          <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--ink4)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {svc.default_model ?? ''}
          </span>
        )}
        {authBadge ? (
          <span style={stateChip('ok')} title="Which credential this provider uses right now — a subscription is preferred over an API key when both are present">
            <span style={dot('ok')} />via {authBadge}
          </span>
        ) : (
          <span style={stateChip(tone)}>
            <span style={dot(tone)} />
            {state === 'set' ? 'configured' : state === 'partial' ? 'partial' : 'no key'}
          </span>
        )}
        {saved ? <span style={{ fontFamily: MONO, fontSize: 10, color: 'var(--online-text)' }}>saved</span> : null}
        <button style={linkBtn} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? 'Cancel' : state === 'unset' ? 'Add key' : 'Replace key'}
        </button>
        {state !== 'unset' ? (
          <button style={removeBtn(busy)} disabled={busy} onClick={() => void put(buildClearPayload(svc))} title="Forget this key on the daemon (clears it from the env file)">
            Remove
          </button>
        ) : null}
      </div>
      {versionsOpen && hasVersionChoice(versions) ? (
        <VersionPanel serviceId={svc.id} versions={versions} />
      ) : null}
      {open ? (
        <div style={{ ...card, margin: '0 0 8px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {svc.env_vars.map((v) => (
              <div key={v.name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {svc.env_vars.length > 1 ? (
                  <span style={{ fontSize: 11, color: 'var(--c-text-dim)', width: 74, flexShrink: 0 }}>
                    {envVarFieldLabel(svc, v.name)}
                  </span>
                ) : null}
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus={v === svc.env_vars[0]}
                  style={keyInput}
                  placeholder={PLACEHOLDER}
                  value={typed[v.name] ?? ''}
                  onChange={(e) => setTyped((t) => ({ ...t, [v.name]: e.target.value }))}
                />
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
            <button
              style={saveBtn(!payload || busy, saved)}
              disabled={!payload || busy}
              onClick={() => payload && void put(payload)}
              title="Save to the daemon's protected env file — live immediately"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
            {svc.docs_url ? (
              <a href={svc.docs_url} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: 'var(--lapis-text)', textDecoration: 'none' }} title={svc.docs_url}>
                Get a key ↗
              </a>
            ) : null}
            {err ? <span style={{ fontSize: 11, color: 'var(--c-err)' }}>{err}</span> : null}
          </div>
          {svc.id === 'xai' ? <XaiOAuthPanel onAuthChanged={onAuthChanged} /> : null}
        </div>
      ) : null}
    </div>
  )
}

const probeBtn = (disabled: boolean): CSSProperties => ({
  fontSize: 11,
  padding: '2px 8px',
  borderRadius: 6,
  border: '1px solid var(--c-line)',
  background: 'transparent',
  color: disabled ? 'var(--c-text-faint)' : 'var(--c-text-dim)',
  cursor: disabled ? 'not-allowed' : 'pointer',
  flexShrink: 0,
  font: 'inherit'
})

/** Up or down from the last check (@shared/backend-health). Stale is when it was checked, not how it is: not a state, not a column; a stale
 *  reading is checked again, and the time is in the tooltip. */
function backendState(bk: BackendStatusDTO): { tone: 'ok' | 'idle' | 'err' | 'none'; label: string; reason: string | null } {
  const r = backendReading(undefined, bk)
  if (r.state === 'checking') return { tone: 'none', label: 'checking', reason: null }
  if (r.state === 'up') return { tone: 'ok', label: 'up', reason: null }
  return { tone: 'err', label: 'down', reason: r.reason }
}
function backendTrouble(bk: BackendStatusDTO): boolean {
  return backendReading(undefined, bk).state !== 'up'
}

/** The boxes you own — one ROW per backend the daemon's registry knows (Prometheus PR 389/390),
 * from /api/status.backends: what each is serving, its reported window, latency, reachability
 * (up / down / checking, @shared/backend-health). "Probe" forces a re-probe now. On a daemon
 * without a registry (the field is absent or null) it degrades to the single "Local model" row
 * this used to be. Data from /api/status (no new endpoint). The parent owns the "only problems"
 * filter so the summary line and the table agree. */
function BackendTable({ status, onlyProblems, onLoad }: { status: AgentStatusDTO; onlyProblems: boolean; onLoad: () => void }) {
  const [probing, setProbing] = useState<string | null>(null)
  const [probeError, setProbeError] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const backends = status.backends
  if (!backends || typeof backends !== 'object' || Object.keys(backends).length === 0) {
    // No registry: one row for the main model. A cloud main model (Path A) is not "local" and does need its key.
    const main = { key: 'local', label: 'local', provider: status.provider ?? undefined, model: status.model ?? undefined, backend: 'local' }
    const cloud = isCloudPrimary(main)
    return (
      <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }} data-testid="backend-table">
        <tbody>
          <tr>
            <td style={{ ...td, width: 90, color: 'var(--ink)' }}>{cloud ? 'main model' : 'local'}</td>
            <td style={td} title={cloud ? defaultRowLabel(main, []) : undefined}>{status.provider ?? 'local'} · {shortModel(status.model)}</td>
            <td style={{ ...td, width: 150 }}><span style={stateChip('ok')}><span style={dot('ok')} />{cloud ? 'default' : 'default · no key needed'}</span></td>
          </tr>
        </tbody>
      </table>
    )
  }
  const probe = async (name: string): Promise<void> => {
    const b = window.beacon
    if (!b) return
    setProbing(name)
    setProbeError('')
    try {
      await b.daemon.write(`/api/backends/${encodeURIComponent(name)}/probe`, undefined, 'POST')
      onLoad()
    } catch (e) {
      setProbeError(`Probe of ${name} failed: ${(e as Error)?.message ?? e}`)
    } finally {
      setProbing(null)
    }
  }
  // R12: exceptions first — down, then not checked yet, then up.
  const rank = (bk: BackendStatusDTO): number => ({ down: 0, checking: 1, up: 2 })[backendReading(undefined, bk).state]
  const rows = Object.entries(backends)
    .map(([key, bk]) => ({ ...bk, name: bk.name ?? key }))
    .filter((bk) => !onlyProblems || backendTrouble(bk))
    .sort((a, z) => rank(a) - rank(z))
  return (
    <>
      <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }} data-testid="backend-table">
        <thead>
          <tr>
            <th style={{ ...th, width: 108 }}>host</th>
            <th style={th}>runtime · model</th>
            <th style={{ ...th, width: 150 }}>endpoint</th>
            <th style={{ ...th, width: 52 }}>window</th>
            <th style={{ ...th, width: 54 }}>lat</th>
            <th style={{ ...th, width: 154 }}>state</th>
            <th style={{ ...th, width: 62 }} />
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td style={{ ...td, color: 'var(--ink2)', fontFamily: 'var(--font-body)', fontSize: 13 }} colSpan={7}>Every backend is up.</td>
            </tr>
          ) : null}
          {rows.map((bk) => {
            const name = bk.name ?? '?'
            const st = backendState(bk)
            const pulled = bk.available_models ?? []
            const isOpen = expanded === name
            return (
              <Fragment key={name}>
                <tr data-testid="backend-row" data-state={st.label}>
                  <td style={{ ...td, color: 'var(--ink)' }} title={name}>
                    {name}
                    {name === 'local' ? <span style={{ color: 'var(--ink3)' }}> · default</span> : null}
                  </td>
                  <td style={td} title={`${bk.provider ?? '?'} · ${bk.model_path ?? bk.model ?? ''}`}>
                    {bk.provider ?? '?'} · {shortModel(bk.model_path ?? bk.model)}
                    {pulled.length > 0 ? (
                      <button style={{ ...countChip, marginLeft: 8 }} onClick={() => setExpanded(isOpen ? null : name)} aria-expanded={isOpen} title={pulled.join(', ')}>
                        {pulled.length} pulled
                      </button>
                    ) : null}
                  </td>
                  <td style={{ ...td, color: 'var(--ink4)' }} title={bk.base_url ?? ''}>{bk.base_url ?? '—'}</td>
                  <td style={{ ...td, color: 'var(--ink4)' }}>{bk.n_ctx ? `${Math.round(bk.n_ctx / 1024)}k` : '—'}</td>
                  <td style={{ ...td, color: 'var(--ink4)' }}>{typeof bk.latency_ms === 'number' ? `${Math.round(bk.latency_ms)}ms` : '—'}</td>
                  <td
                    style={td}
                    title={[
                      st.reason,
                      bk.error && st.reason ? `(${bk.error})` : null,
                      bk.probed_at ? `last checked ${new Date(bk.probed_at).toLocaleTimeString()}` : null,
                      bk.changed_at ? `served model changed ${new Date(bk.changed_at).toLocaleString()}` : null
                    ]
                      .filter(Boolean)
                      .join(' ') || undefined}
                  >
                    <span style={stateChip(st.tone)}>
                      <span style={dot(st.tone)} />
                      {st.label}
                      {st.reason ? <span style={{ color: 'var(--ink4)', letterSpacing: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}> · {st.reason}</span> : null}
                    </span>
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    <button onClick={() => void probe(name)} disabled={probing === name} style={probeBtn(probing === name)} title="Re-probe this box now">
                      {probing === name ? '…' : 'Probe'}
                    </button>
                  </td>
                </tr>
                {isOpen ? (
                  <tr>
                    <td style={{ ...td, height: 'auto', whiteSpace: 'normal', padding: '4px 8px 8px 0', color: 'var(--ink4)', fontSize: 11, borderTop: 'none' }} colSpan={7}>
                      pulled: {pulled.join(', ')}
                      {bk.loaded_models && bk.loaded_models.length ? ` · loaded: ${bk.loaded_models.join(', ')}` : ''}
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            )
          })}
        </tbody>
      </table>
      {probeError ? <div style={{ fontSize: 11, color: 'var(--c-warn)', marginTop: 4 }}>{probeError}</div> : null}
    </>
  )
}

/** `/home/x/models/Qwen3.8-27B-UD-Q4_K_XL.gguf` → `Qwen3.8-27B-UD-Q4_K_XL`; a bare id passes through. */
function shortModel(identity: string | null | undefined): string {
  if (!identity) return 'unknown'
  const tail = identity.split('/').pop() ?? identity
  return tail.endsWith('.gguf') ? tail.slice(0, -5) : tail
}

export function ModelKeysTab({ data }: { data: unknown }) {
  // Seed from the ConfigPanel GET; every successful PUT replaces the whole
  // catalog from the response (the daemon returns the same shape).
  const [catalog, setCatalog] = useState<unknown>(data)
  useEffect(() => setCatalog(data), [data])

  // "How it's connected" captions from GET /api/models (Prometheus PR 102) —
  // service ids match the models-catalog keys ('xai' row ↔ 'xai' preset).
  // Old daemon / offline → {} and the rows just keep their key chips.
  const [authBadges, setAuthBadges] = useState<Record<string, string>>({})
  // Same fetch, two derivations — the badge index and the version index come from one
  // body, so a row's caption and its picker can never disagree about the catalog.
  const [catalogVersionIndex, setCatalogVersionIndex] = useState<Record<string, ModelVersion[]>>({})
  const [catalogNote, setCatalogNote] = useState<string | null>(null)
  const [authEpoch, setAuthEpoch] = useState(0) // bumped by OAuth sign-in/out
  useEffect(() => {
    const b = window.beacon
    if (!b) return
    let alive = true
    void b.daemon
      .get(MODELS_CATALOG_PATH)
      .then((d) => {
        if (!alive) return
        setAuthBadges(catalogAuthBadges(d))
        setCatalogVersionIndex(catalogVersions(d))
        setCatalogNote(catalogNoteSummary(d))
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [catalog, authEpoch]) // a key save/remove or a sign-in/out changes what the daemon would use

  // The backend registry, from /api/status (no new endpoint). Owned here so the summary line
  // and the table read the same snapshot.
  const [status, setStatus] = useState<AgentStatusDTO | null>(null)
  const loadStatus = useCallback((): void => {
    const b = window.beacon
    if (!b) return
    void b.daemon
      .get('/api/status')
      .then((d) => setStatus((d ?? {}) as AgentStatusDTO))
      .catch(() => undefined) // the catalog below still renders; the table just stays quiet
  }, [])
  useEffect(loadStatus, [])
  const [onlyProblems, setOnlyProblems] = useState(false)
  // A stale or never-taken reading is checked again (an owner's route; rate-limited per server in backend-recheck).
  const role = useDeviceRole()
  const registry = status?.backends && typeof status.backends === 'object' ? Object.entries(status.backends).map(([k, bk]) => ({ name: bk.name ?? k, health: bk })) : []
  useBackendRecheck(registry, role === 'owner', loadStatus)

  const services = coerceKeyServices(catalog)
  if (services.length === 0) {
    return (
      <div style={{ maxWidth: 820 }}>
        <MainModelSection />
        <div style={muted}>
        Couldn&apos;t load the model catalog — the daemon may be unreachable or too old for
        /api/providers/keys. Check the connection (⌘,) and reopen this tab.
        </div>
      </div>
    )
  }

  // R12: the anomaly count, stated once at the top.
  const backendList = status?.backends && typeof status.backends === 'object' ? Object.entries(status.backends).map(([k, bk]) => ({ ...bk, name: bk.name ?? k })) : []
  const down = backendList.filter((bk) => backendReading(undefined, bk).state === 'down').length
  const unprobed = backendList.filter((bk) => backendReading(undefined, bk).state === 'checking').length
  const withoutKey = services.filter((svc) => serviceKeyState(svc) === 'unset' && !authBadges[svc.id]).length
  const problems: string[] = []
  if (down) problems.push(`${down} backend${down === 1 ? '' : 's'} down`)
  if (unprobed) problems.push(`${unprobed} not checked yet`)
  if (withoutKey) problems.push(`${withoutKey} provider${withoutKey === 1 ? '' : 's'} without a key`)
  const trouble = problems.length > 0
  const shownServices = onlyProblems ? services.filter((svc) => serviceKeyState(svc) !== 'set' && !authBadges[svc.id]) : services

  return (
    <div style={{ maxWidth: 820 }}>
      {/* What the assistant thinks with comes first: the rest of this tab is extras and hardware. */}
      <MainModelSection />
      <div style={summaryBar(trouble)} data-testid="models-summary">
        <span style={dot(trouble ? 'idle' : 'ok')} />
        <span style={{ flex: 1 }}>{trouble ? problems.join(' · ') : `${backendList.length || 1} backend${backendList.length === 1 ? '' : 's'} up · every provider keyed`}</span>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--ink2)', cursor: 'pointer' }}>
          <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />
          Show only problems
        </label>
      </div>
      {/* Explanatory prose ABOVE the thing it explains. */}
      <div style={{ ...muted, fontFamily: 'var(--font-body)', marginBottom: 8 }}>
        Your own hardware, from the daemon&apos;s backend registry. Switch a chat with /&lt;name&gt; or the composer&apos;s
        model picker; the daemon probes the box first.
      </div>
      {status ? <BackendTable status={status} onlyProblems={onlyProblems} onLoad={loadStatus} /> : <div style={muted}>Loading the registry…</div>}
      <div style={{ ...muted, fontFamily: 'var(--font-body)', margin: '18px 0 6px' }}>
        Cloud providers are optional extras behind /commands and tools. Keys are saved to your Prometheus
        machine&apos;s protected env file and light up the matching /commands and tools instantly.
      </div>
      {/* The daemon's own words (GET /api/models catalog_note, Prometheus PR 542). Rendered
          verbatim rather than paraphrased: the daemon is the thing that knows whether the
          catalog is a closed menu, and it says it is not — the model string is free-form and
          only the PROVIDER name is validated. Without this line the dropdowns below read as
          the complete set of what this machine can run, which is the opposite of true.
          Absent on an older daemon → the line simply does not appear. */}
      {catalogNote ? (
        <div style={{ ...muted, fontFamily: 'var(--font-body)', margin: '0 0 8px' }}>{catalogNote}</div>
      ) : null}
      {groupKeyServices(services).map((g) => {
        const rows = g.services.filter((svc) => shownServices.includes(svc))
        if (rows.length === 0) return null
        return (
          <div key={g.kind}>
            <div style={groupHead}>{g.label}</div>
            {rows.map((svc) => (
              <ServiceRow
                key={svc.id}
                svc={svc}
                authBadge={authBadges[svc.id] ?? null}
                versions={versionsFor(catalogVersionIndex, svc.id)}
                onCatalog={setCatalog}
                onAuthChanged={() => setAuthEpoch((e) => e + 1)}
              />
            ))}
          </div>
        )
      })}
      {onlyProblems && shownServices.length === 0 ? <div style={{ ...muted, fontFamily: 'var(--font-body)' }}>Every provider has a key.</div> : null}
    </div>
  )
}
