import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import qrcode from 'qrcode-generator'
import {
  activeDevices,
  fmtDeviceTime,
  hostForPairing,
  normalizePlatform,
  pairHostUnusable,
  pairPayloadProblem,
  pairUrl,
  revokedDevices,
  sortDevices,
  type DeviceDTO,
  type DevicePlatform,
  type MintedDevice
} from '@shared/devices'
import { Icon } from './Icon'
import { OwnerOnlyNote, useDeviceRole } from './OwnerOnlyNote'

// Device enrolment — the desktop half of GRAFT-MOBILE-BRIDGE Piece 1 (Prometheus PR 310).
//
// Lives on the DESKTOP because minting requires the global token, which only this app holds. A
// device token presented to POST /api/devices gets 401 by design: a stolen phone must not be able
// to enrol a second attacker device.
//
// THE ONE-SHOT TOKEN SHAPES THIS WHOLE PANEL. The daemon returns the plaintext once and keeps only
// a SHA-256, so:
//   * the QR is rendered from the mint response held in memory, and the token is never written to
//     the cache, to settings, or to a log;
//   * there is deliberately no "show it again" affordance, because there is nothing to show;
//   * the device list refreshes IMMEDIATELY after a mint. If the QR is dismissed unscanned, the
//     credential still exists on the daemon — the only way it stays revocable is if the user can
//     see the row. An orphan you cannot see is a credential you cannot withdraw.

const panel: CSSProperties = { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }
const head: CSSProperties = {
  padding: '10px 16px', borderBottom: '1px solid var(--c-line)',
  display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0
}
const input: CSSProperties = {
  padding: '5px 9px', fontSize: 12, background: 'var(--c-inset)',
  border: '1px solid var(--c-line)', borderRadius: 6, color: 'var(--c-text)', outline: 'none'
}
/** Disabled is a VISIBLE state (copyBtn's idiom in PreviewPane): a button whose disabled prop and
 * style come from different places drifts, and drifted here — Enrol looked live with an empty
 * name field and read as a broken panel. One derived flag feeds both, always. */
const btn = (disabled = false): CSSProperties => ({
  padding: '5px 11px', fontSize: 12, background: 'var(--c-inset)',
  border: '1px solid var(--c-line)', borderRadius: 6,
  color: disabled ? 'var(--c-text-faint)' : 'var(--c-text)',
  cursor: disabled ? 'not-allowed' : 'pointer'
})
const note: CSSProperties = { padding: '36px 16px', textAlign: 'center', color: 'var(--c-text-dim)', fontSize: 12.5 }
const warn: CSSProperties = {
  margin: '0 0 14px', padding: '9px 12px', fontSize: 11.5, borderRadius: 6,
  border: '1px solid var(--c-line)', background: 'var(--c-inset)', color: 'var(--c-text-dim)'
}

/** SVG, generated locally. Never a hosted image service: the payload contains a live credential,
 *  and a remote QR renderer would be exfiltrating it by construction. */
function qrSvg(payload: string): string {
  const qr = qrcode(0, 'M')
  qr.addData(payload)
  qr.make()
  return qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true })
}

export function DevicesPanel() {
  const [rows, setRows] = useState<DeviceDTO[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [platform, setPlatform] = useState<DevicePlatform>('ios')
  const [minted, setMinted] = useState<MintedDevice | null>(null)
  /** The TLS pin the shown code carries (0.4.3), decided before the token was minted; null = a plain code. */
  const [pin, setPin] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [host, setHost] = useState('')
  const [showRevoked, setShowRevoked] = useState(false)
  // An approved device lists only itself (it may sign itself out); adding a device is the owner's (POST /api/devices is refused), so
  // there is no Enrol to press, only the note.
  const limited = useDeviceRole() === 'limited'

  const load = useCallback((): void => {
    window.beacon.daemon
      .get('/api/devices')
      .then((raw) => setRows(Array.isArray(raw) ? (raw as DeviceDTO[]) : []))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
  }, [])

  useEffect(() => {
    load()
    // The host the phone must reach is the gateway this desktop is paired to — read from the
    // SAME settings the connection uses, so a pairing code can never point somewhere the desktop
    // does not itself talk to.
    window.beacon.connection
      .getSettings()
      .then((c) => setHost(hostForPairing(c?.apiBase ?? '')))
      .catch(() => setHost(''))
  }, [load])

  /**
   * A host problem that is knowable BEFORE the token exists.
   *
   * The payload check ran on `minted`, so an unusable host was discovered one step too late: the
   * daemon had already issued the one-shot token, the row was already enrolled, and the user's
   * recovery was to revoke the orphan and start again. Everything about the HOST is knowable
   * before minting, so it is checked before minting. A bad token or name still surfaces after,
   * because those are not knowable earlier.
   */
  const hostProblem = pairPayloadProblem(host, 'x', 'x') || pairHostUnusable(host)

  // ONE derived flag feeds the disabled prop, the style, and the title — they cannot drift.
  const enrolDisabled = busy || !name.trim() || !!hostProblem

  const mint = (): void => {
    // Belt as well as braces: the button is disabled, and the call still refuses. A disabled
    // button is a UI state; this is the thing that must not spend a credential.
    if (hostProblem) {
      setErr(hostProblem)
      return
    }
    setErr(null)
    setBusy(true)
    // The pin is decided BEFORE the token exists (0.4.3): a refusal here (TLS ports that do not answer with the key, a key that is not a
    // key, a daemon Beacon could not ask) spends nothing. Plain means today's code, unchanged.
    window.beacon.pairPin
      .decide(host)
      .then((d) => {
        if (d.kind === 'refused') throw new Error(d.message)
        setPin(d.kind === 'pinned' ? d.pin : null)
        return window.beacon.daemon.write('/api/devices', { name: name.trim(), platform }, 'POST')
      })
      .then((raw) => {
        const m = raw as MintedDevice
        if (!m || !m.token) throw new Error('the daemon returned no token')
        setMinted(m)
        setName('')
        // IMMEDIATELY, not on dismiss: if this render throws or the window closes, the row is
        // already visible and therefore revocable. See the panel comment.
        load()
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }

  const revoke = (d: DeviceDTO): void => {
    setErr(null)
    window.beacon.daemon
      .write(`/api/devices/${encodeURIComponent(d.id)}`, undefined, 'DELETE')
      .then(() => load())
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
  }

  // Both questions, because they fail differently: a malformed payload the phone cannot parse,
  // and a well-formed one it can parse but can never connect to.
  const problem = minted ? pairPayloadProblem(host, minted.token, minted.name) || pairHostUnusable(host) : ''
  const payload = minted && !problem ? pairUrl(host, minted.token, minted.name, pin) : ''
  const svg = useMemo(() => (payload ? qrSvg(payload) : ''), [payload])
  const payloadPin = payload ? /[?&]pin=([^&]*)/.exec(payload)?.[1] ?? null : null
  const sorted = useMemo(() => sortDevices(rows ?? []), [rows])
  const live = activeDevices(sorted).length

  const liveRows = activeDevices(sorted)
  const dead = revokedDevices(sorted)

  // ONE row renderer for both groups: a tombstone that drifted from a live row (different columns,
  // a Revoke button that cannot work) would be a second thing to keep right.
  const deviceRow = (d: DeviceDTO) => (
    <div
      key={d.id}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '8px 2px',
        borderBottom: '1px solid var(--c-line)',
        opacity: d.revoked_at ? 0.5 : 1
      }}
    >
      <span style={{ display: 'inline-flex', color: 'var(--c-text-faint)', flexShrink: 0 }} aria-hidden>
        <Icon name="plug" size={13} />
      </span>
      <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: 'var(--c-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {d.name}
        {d.is_self ? <span style={{ fontSize: 10, color: 'var(--c-text-faint)' }}> · this device</span> : null}
      </span>
      <span style={{ fontSize: 10.5, color: 'var(--c-text-faint)', flexShrink: 0 }}>{d.platform}</span>
      <span style={{ fontSize: 10.5, color: 'var(--c-text-faint)', flexShrink: 0, minWidth: 74, textAlign: 'right' }}>
        {d.revoked_at ? 'revoked' : `seen ${fmtDeviceTime(d.last_seen_at)}`}
      </span>
      {d.revoked_at ? null : (
        <button style={{ ...btn(), padding: '3px 8px', fontSize: 11 }} onClick={() => revoke(d)}>
          Revoke
        </button>
      )}
    </div>
  )

  return (
    <div style={panel}>
      <div style={head}>
                <span style={{ fontSize: 11, color: 'var(--c-text-dim)' }}>
          {rows === null ? 'loading…' : `${live} enrolled`}
        </span>
        {limited ? (
          <span style={{ marginLeft: 'auto' }} />
        ) : (
          <>
            <input
              style={{ ...input, marginLeft: 'auto', minWidth: 150 }}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Device name…"
              aria-label="Device name"
              spellCheck={false}
            />
            <select
              style={{ ...input, cursor: 'pointer' }}
              value={platform}
              onChange={(e) => setPlatform(normalizePlatform(e.target.value))}
              aria-label="Device platform"
            >
              <option value="ios">iOS</option>
              <option value="macos">macOS</option>
              <option value="other">Other</option>
            </select>
            <button
              style={btn(enrolDisabled)}
              onClick={mint}
              disabled={enrolDisabled}
              aria-label="Enrol device"
              title={
                busy
                  ? 'Minting a pairing code…'
                  : hostProblem
                    ? // Say WHY it is disabled, here, rather than leaving a dead button and a
                      // separate notice the reader has to connect to it.
                      hostProblem
                    : !name.trim()
                      ? 'Name the device first — the code is minted for a named device'
                      : 'Mint a one-shot pairing QR'
              }
            >
              {busy ? 'Minting…' : 'Enrol'}
            </button>
          </>
        )}
        <button
          onClick={load}
          title="Refresh"
          aria-label="Refresh devices"
          style={{ background: 'transparent', border: 'none', color: 'var(--c-text-dim)', cursor: 'pointer', display: 'inline-flex' }}
        >
          <Icon name="refresh" size={14} />
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>
        {err ? <div style={{ ...warn, color: 'var(--c-err)' }}>{err}</div> : null}
        {/* Standing, not only on click: the host is wrong NOW, and the reader should learn that
            while looking at the panel rather than after pressing a button that does nothing. */}
        {!err && hostProblem && !limited ? <div style={{ ...warn, color: 'var(--c-err)' }}>{hostProblem}</div> : null}
        {limited ? (
          <div style={{ marginBottom: 16 }}>
            <OwnerOnlyNote area="enrol" compact />
          </div>
        ) : null}

        {minted ? (
          <div style={{ marginBottom: 22, display: 'flex', gap: 18, alignItems: 'flex-start' }}>
            {/* A QR needs a LIGHT quiet zone to scan reliably, in either theme — so this one surface
                  is deliberately not theme-following. It still comes from a token rather than a literal
                  so the palette owns the value. */}
            <div
              style={{ flexShrink: 0, width: 190, background: 'var(--c-qr-quiet)', padding: 8, borderRadius: 8 }}
              data-testid="pair-code"
              // Read back from the payload the QR encodes, not from state: what a probe reads is what the phone scans.
              data-pinned={payloadPin ? 'true' : 'false'}
              data-pin={payloadPin ?? undefined}
            >
              {/* eslint-disable-next-line react/no-danger -- locally generated SVG from qrcode-generator,
                  never remote content; the payload is our own string. */}
              {svg ? <div dangerouslySetInnerHTML={{ __html: svg }} /> : null}
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--c-text)' }}>{minted.name}</div>
              {payloadPin ? (
                <div style={warn}>
                  Encrypted: this code carries Prometheus&apos;s key ({payloadPin.slice(0, 16)}…), so the phone connects over TLS on ports 8006 and 8011 and
                  only to this Prometheus.
                </div>
              ) : null}
              <div style={warn}>
                <strong>Scan this now.</strong> The token is shown once and cannot be shown again —
                the daemon keeps only a hash of it. If you dismiss this, revoke the device below
                and enrol again.
              </div>
              {problem ? (
                <div style={{ ...warn, color: 'var(--c-err)' }}>
                  Cannot build a pairing code: {problem}
                </div>
              ) : null}
              <button style={btn()} onClick={() => setMinted(null)}>Done</button>
            </div>
          </div>
        ) : null}

        {rows === null ? (
          <div style={note}>Loading…</div>
        ) : sorted.length === 0 ? (
          <div style={note}>
            No devices enrolled. Name one above and press Enrol to show a pairing code.
          </div>
        ) : (
          <>
            {liveRows.map(deviceRow)}
            {dead.length > 0 ? (
              <div style={{ marginTop: liveRows.length > 0 ? 14 : 0 }}>
                {/* Revoked rows are TOMBSTONES: `DELETE /api/devices/{id}` revokes, and the daemon
                    has no purge route by design, so no client can delete these. Every failed
                    pairing and every probe leaves one, and they pile up above the phone you
                    actually care about. Collapsed behind their count — reachable, never hidden
                    silently, never pretended to be deletable. */}
                <button
                  onClick={() => setShowRevoked((v) => !v)}
                  aria-expanded={showRevoked}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, width: '100%',
                    padding: '6px 2px', background: 'transparent', border: 'none',
                    borderTop: '1px solid var(--c-line)', color: 'var(--c-text-dim)',
                    fontSize: 11.5, cursor: 'pointer', font: 'inherit', textAlign: 'left'
                  }}
                  title="Revoked devices are kept by the daemon as a permanent record — they cannot authenticate, and no client can delete them."
                >
                  <span aria-hidden>{showRevoked ? '▾' : '▸'}</span>
                  <span>{dead.length} revoked</span>
                  <span style={{ color: 'var(--c-text-faint)' }}>
                    · kept as a record, cannot sign in
                  </span>
                </button>
                {showRevoked ? dead.map(deviceRow) : null}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}
