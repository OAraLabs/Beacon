import { thisComputer } from '@shared/this-computer'
import { NOT_ENCRYPTED_NOTICE } from '@shared/plain-lan'
import { useEffect, useState, type CSSProperties } from 'react'
import type { ConnectionTestResult, UpdaterStatus } from '@shared/ipc'
import type { NotifyPrefs } from '@shared/notification-prefs'
import type { CloseMode } from '@shared/tray-hint'
import { loginItemNote, type LoginItemState } from '@shared/login-item'
import type { LegalDoc } from '@shared/legal-docs'
import { READ_FAILED, RESTARTING, RESTART_COPY, type NetworkRead, type RestartOutcome } from '@shared/network-setting'
import { OWNER_SETTINGS_COPY, type OwnerOutcome } from '@shared/owner-promotion'
import { useDeviceRole } from './OwnerOnlyNote'
import { WorkerModelSection } from './WorkerModelSection'

/** For the words that name this computer: "this Mac" on macOS, "this computer" elsewhere. */
const PLATFORM = window.beacon?.platform ?? ''

// Connection Settings (⌘, / panel "Open Settings"). Reachable AFTER first-run. Edit the gateway REST
// + WS URLs and the bearer token, then Save & test — main writes to the SAME keychain first-run uses
// and immediately re-tests GET /api/status so the result is real, not a guess. The token VALUE is
// never read back into the renderer: we only show whether one is saved; blank = keep, or Clear it.

const backdrop: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 70,
  background: 'var(--c-scrim)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 16
}
const modal: CSSProperties = {
  width: 'min(480px, 94vw)',
  // The dialog can never be taller than the window, and its content scrolls INSIDE it. Until
  // 2026-09-15 a failed update check rendered the provider's whole 1.5 KB header dump into the
  // Updates panel, which sits directly above the action row: the modal grew past the viewport,
  // and because a flex-centred child overflows equally in both directions there was nothing to
  // scroll — Test and Save & test were simply unreachable, so the bearer token could not be
  // changed at all while the update check was failing.
  maxHeight: 'calc(100vh - 32px)', // the backdrop's own 16px padding, top and bottom
  minHeight: 0,
  background: 'var(--c-raise)',
  border: '1px solid var(--c-line)',
  borderRadius: 12,
  padding: 18,
  display: 'flex',
  flexDirection: 'column',
  gap: 12
}
/** Everything above the action row scrolls; the row itself does not, so it is always reachable
 * no matter what any panel above it decides to render. */
const scrollBody: CSSProperties = {
  overflowY: 'auto',
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  marginRight: -4,
  paddingRight: 4
}
const field: CSSProperties = {
  fontSize: 13,
  padding: '8px 10px',
  borderRadius: 6,
  border: '1px solid var(--c-line)',
  background: 'var(--c-base)',
  color: 'var(--c-text)',
  outline: 'none',
  font: 'inherit',
  width: '100%',
  boxSizing: 'border-box'
}
const labelStyle: CSSProperties = { fontSize: 12, color: 'var(--c-text-dim)', display: 'flex', flexDirection: 'column', gap: 5 }
const btn = (primary = false, disabled = false): CSSProperties => ({
  fontSize: 13,
  padding: '8px 16px',
  borderRadius: 6,
  border: `1px solid ${primary ? 'var(--c-arc)' : 'var(--c-line)'}`,
  background: disabled ? 'var(--c-base)' : primary ? 'var(--c-arc)' : 'var(--c-inset)',
  color: disabled ? 'var(--c-text-faint)' : primary ? 'var(--c-on-arc)' : 'var(--c-text)',
  cursor: disabled ? 'not-allowed' : 'pointer',
  font: 'inherit'
})


/** App updates (electron-updater, main-owned). Status is pushed via UPDATER_STATUS_CHANGED and
 * mirrored here; Check now / Install on ready. Dev builds show 'disabled' — updates only exist
 * once packaged. */
function UpdatesSection() {
  const [st, setSt] = useState<UpdaterStatus | null>(null)
  useEffect(() => {
    const b = window.beacon
    if (!b) return
    void b.updater.status().then(setSt)
    return b.updater.onStatus(setSt)
  }, [])
  const label =
    st == null ? '…'
    : st.state === 'disabled' ? 'dev build — updates are packaged-app only'
    : st.state === 'idle' ? 'not checked yet'
    : st.state === 'checking' ? 'checking the release feed…'
    : st.state === 'available' ? `update ${st.version ?? ''} found — downloading`
    : st.state === 'downloading' ? `downloading ${st.percent ?? 0}%`
    : st.state === 'up-to-date' ? `up to date${st.version ? ` (v${st.version})` : ''}`
    : st.state === 'ready' ? `v${st.version ?? ''} downloaded — restart to install`
    : st.detail ?? 'update check failed'
  const busy = st?.state === 'checking' || st?.state === 'downloading'
  return (
    <div style={{ borderTop: '1px solid var(--c-line)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--c-text-dim)' }}>Updates</div>
      {/* main caps detail at 180 chars (updater.ts describeError); this is the second half of that
          guarantee — the panel cannot grow past three lines even if something upstream regresses,
          and an unbroken 400-character token wraps instead of widening the dialog. */}
      <div
        title={label}
        style={{
          fontSize: 12,
          lineHeight: 1.35,
          color: st?.state === 'error' ? 'var(--c-err-text)' : 'var(--c-text-dim)',
          display: '-webkit-box',
          WebkitLineClamp: 3,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          overflowWrap: 'anywhere'
        }}
      >
        {label}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--c-line)', background: 'var(--c-base)', color: busy || st?.state === 'disabled' ? 'var(--c-text-faint)' : 'var(--c-text)', cursor: busy ? 'wait' : st?.state === 'disabled' ? 'not-allowed' : 'pointer', font: 'inherit' }}
          disabled={busy || st?.state === 'disabled'}
          title={st?.state === 'disabled' ? 'Updates are disabled in dev builds' : busy ? 'Working…' : 'Check GitHub releases for a newer build'}
          onClick={() => void window.beacon?.updater.check()}
        >
          {busy ? 'Working…' : 'Check for updates'}
        </button>
        {st?.state === 'ready' ? (
          <button
            style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--c-arc)', background: 'var(--c-arc-soft, var(--c-raise))', color: 'var(--c-text)', cursor: 'pointer', font: 'inherit' }}
            onClick={() => void window.beacon?.updater.install()}
          >
            Restart & install
          </button>
        ) : null}
      </div>
    </div>
  )
}

/** About: Beacon's terms in one line, and the documents that ship with it. Each button names a document
 * (@shared/legal-docs); main opens the file the build shipped for it in the OS's viewer, and says why
 * when it cannot. */
function AboutSection() {
  const [err, setErr] = useState<string | null>(null)
  const open = async (doc: LegalDoc): Promise<void> => {
    const r = await window.beacon?.legal.open(doc)
    setErr(r && !r.ok ? r.error : null)
  }
  const link: CSSProperties = { fontSize: 11, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--c-line)', background: 'var(--c-base)', color: 'var(--c-text)', cursor: 'pointer', font: 'inherit' }
  return (
    <div style={{ borderTop: '1px solid var(--c-line)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--c-text-dim)' }}>About</div>
      <div style={{ fontSize: 12, color: 'var(--c-text-dim)' }}>Free · open source (MIT) · beta</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button style={link} title="Beacon's license" onClick={() => void open('license')}>
          License
        </button>
        <button style={link} title="The open-source software in Beacon, with its licenses" onClick={() => void open('notices')}>
          Third-party notices
        </button>
        <button style={link} title="Chromium's licenses, and those of the other components built into Electron" onClick={() => void open('chromium')}>
          Chromium licenses
        </button>
      </div>
      {err ? <div style={{ fontSize: 12, color: 'var(--c-err-text)' }}>{err}</div> : null}
    </div>
  )
}

/** Notifications + window-close behavior (@shared/notification-prefs, @shared/tray-hint). Every
 * toggle commits on click (the SET returns what main stored, and the UI renders THAT) rather than
 * on a Save button — these are switches, not fields, and a switch that looks flipped but is waiting
 * for a save reads as broken. */
function NotificationsSection() {
  const [prefs, setPrefs] = useState<NotifyPrefs | null>(null)
  const [closeMode, setCloseMode] = useState<CloseMode | null>(null)
  useEffect(() => {
    const b = window.beacon
    if (!b) return
    void b.notifications.prefs().then(setPrefs).catch(() => undefined)
    void b.notifications.closeMode().then(setCloseMode).catch(() => undefined)
  }, [])

  const toggleKind = (kind: keyof NotifyPrefs): void => {
    const b = window.beacon
    if (!b || !prefs) return
    // Optimistically flip, then replace with what main stored — SET parses and sanitizes, so the
    // stored value is canonical even if this local object was somehow not.
    const next = { ...prefs, [kind]: !prefs[kind] }
    setPrefs(next)
    void b.notifications.setPrefs(next).then(setPrefs).catch(() => undefined)
  }
  const chooseCloseMode = (mode: CloseMode): void => {
    const b = window.beacon
    if (!b) return
    setCloseMode(mode)
    void b.notifications.setCloseMode(mode).then(setCloseMode).catch(() => undefined)
  }

  const row: CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12, color: 'var(--c-text)' }
  const hint: CSSProperties = { fontSize: 11, color: 'var(--c-text-dim)', lineHeight: 1.35 }
  if (!prefs || !closeMode) return null

  const kinds: { key: keyof NotifyPrefs; label: string; note: string }[] = [
    { key: 'approval', label: 'Approvals', note: 'The agent is stopped and waiting for you. This is the one that matters.' },
    { key: 'reply', label: 'Replies', note: 'A chat reply finished in a session you are not looking at.' },
    { key: 'task', label: 'Background tasks', note: 'A task completed or failed. The frequent, low-stakes one.' },
    { key: 'error', label: 'Disconnections', note: 'The connection to Prometheus was lost.' }
  ]
  return (
    <div style={{ borderTop: '1px solid var(--c-line)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--c-text-dim)' }}>Notifications</div>
      <label style={{ ...row, cursor: 'pointer' }}>
        <input type="checkbox" checked={prefs.muted} onChange={() => toggleKind('muted')} />
        <span>
          Mute everything
          <div style={hint}>Do not disturb — suppresses ALL notifications, including approvals.</div>
        </span>
      </label>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 7,
          opacity: prefs.muted ? 0.5 : 1,
          pointerEvents: prefs.muted ? 'none' : undefined
        }}
      >
        {kinds.map((k) => (
          <label key={k.key} style={{ ...row, cursor: 'pointer' }}>
            <input type="checkbox" checked={prefs[k.key]} onChange={() => toggleKind(k.key)} />
            <span>
              {k.label}
              <div style={hint}>{k.note}</div>
            </span>
          </label>
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        <span style={{ fontSize: 12, color: 'var(--c-text-dim)' }}>When you close the window</span>
        <label style={{ ...row, cursor: 'pointer' }}>
          <input type="radio" name="close-mode" checked={closeMode === 'tray'} onChange={() => chooseCloseMode('tray')} />
          <span>
            Hide to tray
            <div style={hint}>Stay connected and keep tasks running. Reopen from the tray icon.</div>
          </span>
        </label>
        <label style={{ ...row, cursor: 'pointer' }}>
          <input type="radio" name="close-mode" checked={closeMode === 'quit'} onChange={() => chooseCloseMode('quit')} />
          <span>
            Quit Beacon
            <div style={hint}>The ✕ button fully closes the app, connection and all.</div>
          </span>
        </label>
      </div>
    </div>
  )
}

/** Launch at login (@shared/login-item). A single switch whose position is read LIVE from the OS on
 * mount (the user can flip it in System Settings / Task Manager, so we never trust a cached value).
 * When the platform or build can't honour it (Linux, or an unpackaged dev build) the switch renders
 * disabled with the model's reason — a control that silently no-ops is the lie this avoids. */
function LoginItemSection() {
  const [st, setSt] = useState<LoginItemState | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void window.beacon?.loginItem.get().then(setSt).catch(() => undefined)
  }, [])

  const toggle = async (): Promise<void> => {
    const b = window.beacon
    if (!b || !st) return
    setBusy(true)
    try {
      // Optimistic flip, then replace with the OS readback the SET returns — what the OS kept, which
      // can differ from what we asked (e.g. macOS needs approval, Windows deactivates the run key).
      setSt({ ...st, enabled: !st.enabled })
      setSt(await b.loginItem.set(!st.enabled))
    } catch {
      /* re-read on failure so the switch reflects reality, not the optimistic guess */
      try {
        setSt(await b.loginItem.get())
      } catch {
        /* leave the last good state */
      }
    } finally {
      setBusy(false)
    }
  }

  if (!st) return null
  const row: CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12, color: 'var(--c-text)' }
  const hint: CSSProperties = { fontSize: 11, color: 'var(--c-text-dim)', lineHeight: 1.35 }
  const note = loginItemNote(st)
  return (
    <div style={{ borderTop: '1px solid var(--c-line)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--c-text-dim)' }}>Startup</div>
      <label style={{ ...row, cursor: st.supported && !busy ? 'pointer' : 'default', opacity: st.supported ? 1 : 0.6 }}>
        <input
          type="checkbox"
          checked={st.enabled}
          disabled={!st.supported || busy}
          onChange={() => void toggle()}
        />
        <span>
          Launch at login
          <div style={hint}>{note}</div>
        </span>
      </label>
    </div>
  )
}

/** Other computers (docs/MULTI-COMPUTER-v0.4.md §2): "Let other computers on my home network connect", the connected
 *  Prometheus's own setting (its GET/PUT /api/network, Prometheus PR 700). Only an owner sees it: an approved device is told no by
 *  Prometheus and there is no section. Saving does not apply it (Prometheus binds at start), so a saved change offers
 *  [Restart now], which waits until Prometheus answers again as the same computer (Prometheus PR 724). The switch never flips
 *  ahead of Prometheus: it shows what Prometheus read back, so a refusal leaves it where it was. */
function OtherComputersSection() {
  const [read, setRead] = useState<NetworkRead | null>(null)
  const [busy, setBusy] = useState<'saving' | 'restarting' | null>(null)
  const [refusal, setRefusal] = useState<{ message: string; detail: string } | null>(null)
  const [restarted, setRestarted] = useState<Exclude<RestartOutcome['kind'], 'back'> | null>(null)
  const [copied, setCopied] = useState(false)
  const load = async (): Promise<void> => {
    try {
      setRead((await window.beacon?.network.get()) ?? { kind: 'hidden' })
    } catch {
      setRead({ kind: 'unreadable', detail: 'Beacon could not ask' })
    }
  }
  // Asked again when the role changes: an approved device made an owner here gets the section without reopening Settings.
  const role = useDeviceRole()
  useEffect(() => {
    if (role === undefined) return // main has not said yet: wait rather than ask
    if (role === 'limited') {
      setRead({ kind: 'hidden' }) // the setting is the owner's (an approved device is refused it): no section, and nothing asked
      return
    }
    void load()
  }, [role])

  const toggle = async (on: boolean): Promise<void> => {
    const b = window.beacon
    if (!b || busy) return
    setBusy('saving')
    setRefusal(null)
    setRestarted(null)
    setCopied(false)
    try {
      const r = await b.network.set(on)
      if (r.kind === 'refused') setRefusal({ message: r.message, detail: r.detail })
      else setRead(r)
    } catch {
      await load()
    } finally {
      setBusy(null)
    }
  }
  const restart = async (): Promise<void> => {
    const b = window.beacon
    if (!b || busy) return
    setBusy('restarting')
    setRefusal(null)
    setRestarted(null)
    try {
      const r = await b.network.restart()
      if (r.kind === 'back') setRead(r.read)
      else setRestarted(r.kind)
    } catch {
      setRestarted('failed')
    } finally {
      setBusy(null)
    }
  }

  if (!read || read.kind === 'hidden') return null
  const box: CSSProperties = { borderTop: '1px solid var(--c-line)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }
  const title = <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--c-text-dim)' }}>Other computers</div>
  const hint: CSSProperties = { fontSize: 11, color: 'var(--c-text-dim)', lineHeight: 1.35 }
  const small = (disabled: boolean): CSSProperties => ({ ...btn(false, disabled), padding: '4px 10px', fontSize: 12, alignSelf: 'flex-start' })
  if (read.kind === 'unreadable')
    return (
      <div style={box} data-testid="other-computers">
        {title}
        <div style={hint}>{READ_FAILED}</div>
        <button style={small(!!busy)} disabled={!!busy} onClick={() => void load()}>
          Try again
        </button>
      </div>
    )
  const v = read.view
  const row: CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12, color: 'var(--c-text)' }
  // Once Prometheus has said it cannot restart from here, [Restart now] would only say so again.
  const offerRestart = v.restartNeeded && restarted !== 'unavailable'
  return (
    <div style={box} data-testid="other-computers">
      {title}
      {v.canChange ? (
        <label style={{ ...row, cursor: busy ? 'default' : 'pointer' }}>
          <input type="checkbox" checked={v.on} disabled={!!busy} onChange={() => void toggle(!v.on)} data-testid="home-network-switch" />
          <span>
            Let other computers on my home network connect
            <div style={hint} data-testid="home-network-line">
              {v.line}
            </div>
          </span>
        </label>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={hint} data-testid="home-network-line">
            {v.line}
          </div>
          {v.why ? <div style={hint}>{v.why}</div> : null}
        </div>
      )}
      {v.notes.map((n) => (
        <div key={n} style={hint}>
          {n}
        </div>
      ))}
      {busy === 'restarting' ? <div style={hint}>{RESTARTING}</div> : null}
      {offerRestart && busy !== 'restarting' ? (
        <button style={small(!!busy)} disabled={!!busy} onClick={() => void restart()} data-testid="restart-prometheus">
          Restart now
        </button>
      ) : null}
      {restarted ? (
        <div style={{ ...hint, color: restarted === 'unavailable' ? 'var(--c-text-dim)' : 'var(--c-err)' }}>
          {RESTART_COPY[restarted]}{' '}
          {restarted === 'not-back' ? (
            <button style={small(!!busy)} disabled={!!busy} onClick={() => (setRestarted(null), void load())}>
              Try again
            </button>
          ) : null}
        </div>
      ) : null}
      {refusal ? (
        <div style={{ ...hint, color: 'var(--c-err)', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {refusal.message}
          <button
            style={small(false)}
            onClick={() =>
              void navigator.clipboard
                ?.writeText(refusal.detail)
                .then(() => setCopied(true))
                .catch(() => undefined)
            }
          >
            {copied ? 'Copied' : 'Copy details'}
          </button>
        </div>
      ) : null}
    </div>
  )
}

/** Make this Beacon an owner (@shared/owner-promotion, Prometheus PR 748). A Beacon on another computer connected with the API token can't
 *  approve worker requests (Prometheus PR 744); `oara pair --owner` on the computer running Prometheus prints a one-time code, and this
 *  trades it for an owner key of this Beacon's own, kept in place of the API token. The key never comes to this page. */
function OwnerSection({ bare = false }: { bare?: boolean }) {
  const C = OWNER_SETTINGS_COPY
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<OwnerOutcome | null>(null)
  const [copied, setCopied] = useState(false)
  const hint: CSSProperties = { fontSize: 11, color: 'var(--c-text-dim)', lineHeight: 1.35 }
  const ready = code.trim().length > 0 && !busy
  const go = async (): Promise<void> => {
    const b = window.beacon
    if (!b || !ready) return
    setBusy(true)
    setOutcome(null)
    setCopied(false)
    try {
      const r = await b.ownerPromotion.redeem(code)
      setOutcome(r)
      if (r.kind === 'owner') {
        setCode('')
        // The connection was rebuilt with the owner key: remount the panels, as a save does, so none keeps an answer from before.
        window.dispatchEvent(new Event('beacon:connection-changed'))
      }
    } catch {
      setOutcome({ kind: 'refused', message: C.failed, detail: 'Beacon could not ask' })
    } finally {
      setBusy(false)
    }
  }
  const [before, after] = C.body.split('{command}')
  return (
    <div
      style={bare ? { display: 'flex', flexDirection: 'column', gap: 8 } : { borderTop: '1px solid var(--c-line)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}
      data-testid="make-owner"
    >
      {bare ? null : <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--c-text-dim)' }}>{C.title}</div>}
      <div style={hint}>
        {before}
        <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--c-text)' }}>{C.command}</code>
        {after}
      </div>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--c-text)' }}>
        {C.codeLabel}
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            style={{ ...field, maxWidth: 160, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em' }}
            value={code}
            placeholder={C.placeholder}
            inputMode="numeric"
            autoComplete="one-time-code"
            spellCheck={false}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void go()
            }}
            data-testid="make-owner-code"
          />
          <button style={{ ...btn(false, !ready), padding: '4px 10px', fontSize: 12 }} disabled={!ready} onClick={() => void go()} data-testid="make-owner-go">
            {busy ? C.going : C.go}
          </button>
        </span>
      </label>
      {outcome?.kind === 'owner' ? <div style={{ ...hint, color: 'var(--online-text)' }}>{C.done}</div> : null}
      {outcome?.kind === 'refused' ? (
        <div style={{ ...hint, color: 'var(--c-err)', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {outcome.message}
          <button
            style={{ ...btn(false, false), padding: '4px 10px', fontSize: 12, alignSelf: 'flex-start' }}
            onClick={() =>
              void navigator.clipboard
                ?.writeText(outcome.detail)
                .then(() => setCopied(true))
                .catch(() => undefined)
            }
          >
            {copied ? 'Copied' : 'Copy details'}
          </button>
        </div>
      ) : null}
    </div>
  )
}

/** Set up again (0.3.1 Part A, R2): forget this Mac's saved connection and go back through setup.
 *  Two clicks, and the first one says what you'll need, because a configured Prometheus can't hand
 *  out a new pairing code: someone who paired and then forgets needs its API token, or a restart
 *  into setup mode, to get back in. */
function SetupAgainSection({ onSetUpAgain }: { onSetUpAgain: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const hint: CSSProperties = { fontSize: 11, color: 'var(--c-text-dim)', lineHeight: 1.35 }
  return (
    <div style={{ borderTop: '1px solid var(--c-line)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--c-text-dim)' }}>Setup</div>
      {confirming ? (
        <>
          <div style={hint}>
            Beacon will forget this Prometheus&apos;s address and the key saved on {thisComputer(PLATFORM)}, then open setup. Nothing
            changes on Prometheus itself. To connect again you&apos;ll need a pairing code or the API token.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={btn(false)} onClick={onSetUpAgain}>
              Forget and set up again
            </button>
            <button style={btn(false)} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button style={btn(false)} onClick={() => setConfirming(true)}>
            Set up again…
          </button>
          <span style={hint}>Connect to a different Prometheus, or start setup over.</span>
        </div>
      )}
    </div>
  )
}

export function ConnectionSettings({ onClose, onSetUpAgain, at = null }: { onClose: () => void; onSetUpAgain: () => void; at?: string | null }) {
  const [apiBase, setApiBase] = useState('')
  const [wsUrl, setWsUrl] = useState('')
  const [token, setToken] = useState('')
  const [hasToken, setHasToken] = useState(false)
  const [plainHome, setPlainHome] = useState(false)
  const [clearToken, setClearToken] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [test, setTest] = useState<ConnectionTestResult | null>(null)
  const [err, setErr] = useState<string | null>(null)
  // "Make this Beacon an owner" (the end of path B, an owner-only note) opens this sheet with that section only: a new person never
  // meets the connection's address or key there (filming Path B on 0.4.6 found both at the top of the sheet).
  const ownerOnly = at === 'make-owner'
  // The address and the key sit under Advanced, closed, unless Settings was opened to fix the connection (a rejected key, Change
  // connection…), which is the one time a person needs them.
  const [advanced, setAdvanced] = useState(at === 'connection')

  useEffect(() => {
    const b = window.beacon
    if (!b) {
      setLoading(false)
      return
    }
    void b.connection
      .getSettings()
      .then((s) => {
        setApiBase(s.apiBase)
        setWsUrl(s.wsUrl)
        setHasToken(s.hasToken)
        setPlainHome(s.notEncrypted === true)
      })
      .catch(() => undefined)
      .finally(() => setLoading(false))
  }, [])

  // Opened from an owner-only note: "Make this Beacon an owner" in view, its code field ready to type in.
  useEffect(() => {
    if (loading || at !== 'make-owner') return
    const section = document.querySelector<HTMLElement>('[data-testid="make-owner"]')
    section?.scrollIntoView({ block: 'center' })
    document.querySelector<HTMLInputElement>('[data-testid="make-owner-code"]')?.focus({ preventScroll: true })
  }, [loading, at])

  const canSave = apiBase.trim().length > 0 && wsUrl.trim().length > 0 && !busy

  /**
   * What the badge next to the field is allowed to claim. It used to read straight off `hasToken`,
   * which is the STORE's state — so it said "· saved" the whole time you were typing a replacement,
   * and kept saying it if the save never happened. That is the reassuring-but-false label: while the
   * action row was pushed out of the modal by a failed update check, the dialog told you your token
   * was saved when nothing had been written at all. A pending edit now says so in plain words.
   */
  const tokenBadge = clearToken
    ? { text: '· unsaved — will clear on save', color: 'var(--c-amber-text)' }
    : token.trim().length > 0
      ? { text: '· unsaved — press Save & test', color: 'var(--c-amber-text)' }
      : hasToken
        ? { text: '· saved', color: 'var(--c-ok)' }
        : { text: '· none', color: 'var(--c-text-faint)' }

  /** Probe with the FORM's values, persisting nothing: typed token wins; the Clear-token checkbox
   * previews a no-token connect; blank field falls back to the saved token. */
  const probe = async (): Promise<void> => {
    const b = window.beacon
    if (!b) return
    setTesting(true)
    setTest(null)
    setErr(null)
    try {
      const res = await b.connection.test({
        apiBase: apiBase.trim(),
        wsUrl: wsUrl.trim() || undefined,
        token: token.trim() || undefined,
        useSavedToken: !clearToken
      })
      setTest(res)
    } catch (e) {
      setErr(String(e))
    } finally {
      setTesting(false)
    }
  }

  const save = async (): Promise<void> => {
    const b = window.beacon
    if (!b) return
    setBusy(true)
    setErr(null)
    setTest(null)
    try {
      const res = await b.connection.saveSettings({
        apiBase: apiBase.trim(),
        wsUrl: wsUrl.trim(),
        token: token.trim() || undefined,
        clearToken: clearToken || undefined
      })
      if (!res.saved) {
        setErr(res.error ?? 'Save failed.')
        return
      }
      setTest(res.test ?? null)
      setToken('')
      setClearToken(false)
      // Refresh hasToken from the authoritative store (token value never returns to the renderer).
      const fresh = await b.connection.getSettings().catch(() => null)
      if (fresh) setHasToken(fresh.hasToken)
      // The connection was rebuilt — tell App to remount the panels so they refetch with the new token
      // (otherwise an already-open Skills/Status tab keeps showing its stale Not-authorized state).
      window.dispatchEvent(new Event('beacon:connection-changed'))
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={backdrop} onClick={onClose}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--c-text)', margin: 0 }}>{ownerOnly ? OWNER_SETTINGS_COPY.title : 'Connection Settings'}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{ background: 'transparent', border: 'none', color: 'var(--c-text-dim)', cursor: 'pointer', fontSize: 16, lineHeight: 1 }}
          >
            ✕
          </button>
        </div>

        {loading ? (
          <div style={{ color: 'var(--c-text-dim)', fontSize: 13 }}>Loading…</div>
        ) : ownerOnly ? (
          <>
            <div style={scrollBody}>
              <OwnerSection bare />
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 4, flexShrink: 0 }}>
              <div style={{ flex: 1 }} />
              <button style={btn(false)} onClick={onClose}>
                Close
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={scrollBody}>
            {plainHome ? (
              <div data-testid="not-encrypted-notice" style={{ color: 'var(--c-amber)', fontSize: 12, lineHeight: 1.4 }}>
                {NOT_ENCRYPTED_NOTICE}
              </div>
            ) : null}
            <button
              type="button"
              onClick={() => setAdvanced((o) => !o)}
              aria-expanded={advanced}
              style={{ alignSelf: 'flex-start', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', fontSize: 12, fontWeight: 600, color: 'var(--c-text-dim)' }}
            >
              Advanced: how Beacon reaches Prometheus {advanced ? '▾' : '▸'}
            </button>
            {advanced ? (
              <>
                <label style={labelStyle}>
                  Gateway REST URL (:8005)
                  <input style={field} value={apiBase} onChange={(e) => setApiBase(e.target.value)} placeholder="http://host:8005" spellCheck={false} />
                </label>
                <label style={labelStyle}>
                  Gateway WS URL (:8010)
                  <input style={field} value={wsUrl} onChange={(e) => setWsUrl(e.target.value)} placeholder="ws://host:8010" spellCheck={false} />
                </label>
                <label style={labelStyle}>
                  <span>
                    Bearer token{' '}
                    <span style={{ color: tokenBadge.color }}>{tokenBadge.text}</span>
                  </span>
                  <input
                    style={{ ...field, opacity: clearToken ? 0.5 : 1 }}
                    type="password"
                    value={token}
                    disabled={clearToken}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder={hasToken ? 'leave blank to keep the saved token' : 'PROMETHEUS_API_TOKEN'}
                    spellCheck={false}
                  />
                </label>
                {hasToken ? (
                  <label style={{ fontSize: 12, color: 'var(--c-text-dim)', display: 'flex', alignItems: 'center', gap: 7 }}>
                    <input type="checkbox" checked={clearToken} onChange={(e) => setClearToken(e.target.checked)} />
                    Clear the saved token (connect with no auth)
                  </label>
                ) : null}
                <div style={{ fontSize: 12, color: 'var(--c-text-faint)', lineHeight: 1.45 }}>
                  Beacon sends this key with everything it asks Prometheus. Test checks both ways it connects, separately.
                </div>

                {test ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div
                      style={{
                        fontSize: 13,
                        padding: '8px 10px',
                        borderRadius: 6,
                        border: `1px solid ${test.ok ? 'var(--c-ok)' : 'var(--c-err)'}`,
                        background: test.ok ? 'var(--c-ok-soft)' : 'var(--c-err-soft)',
                        color: test.ok ? 'var(--c-ok)' : 'var(--c-err)'
                      }}
                    >
                      REST — {test.label}
                    </div>
                    {test.ws ? (
                      <div
                        style={{
                          fontSize: 13,
                          padding: '8px 10px',
                          borderRadius: 6,
                          border: `1px solid ${test.ws.ok ? 'var(--c-ok)' : 'var(--c-err)'}`,
                          background: test.ws.ok ? 'var(--c-ok-soft)' : 'var(--c-err-soft)',
                          color: test.ws.ok ? 'var(--c-ok)' : 'var(--c-err)'
                        }}
                      >
                        {test.ws.label}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : null}
            {err ? <div style={{ fontSize: 12, color: 'var(--c-err)' }}>{err}</div> : null}

            <SetupAgainSection onSetUpAgain={onSetUpAgain} />
            <OtherComputersSection />
            <OwnerSection />
            <NotificationsSection />
            <LoginItemSection />
            <WorkerModelSection />
            <UpdatesSection />
            <AboutSection />
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 4, flexShrink: 0 }}>
              {advanced ? (
                <button
                  style={btn(false, testing || apiBase.trim().length === 0)}
                  disabled={testing || apiBase.trim().length === 0}
                  onClick={() => void probe()}
                  title="Probe GET /api/status with the values above — nothing is saved"
                >
                  {testing ? 'Testing…' : 'Test'}
                </button>
              ) : null}
              <div style={{ flex: 1 }} />
              <button style={btn(false)} onClick={onClose}>
                Close
              </button>
              {advanced ? (
                <button style={btn(true, !canSave)} disabled={!canSave} onClick={() => void save()}>
                  {busy ? 'Saving…' : 'Save & test'}
                </button>
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
