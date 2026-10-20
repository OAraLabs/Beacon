import { useEffect, useRef, useState } from 'react'
import type { ConnectionTestResult, PairResult } from '@shared/ipc'
import { PAIRING_CODE_LENGTH, PAIR_POLL_INTERVAL_MS, isValidPairingCode } from '@shared/pairing'
import { SETUP_LINKS } from '@shared/setup-links'

interface Props {
  currentAddress?: string
  onConnected: () => void
}

/** Mirror of main's gatewayFromAddress host-cleaning (display-side only, for the no-save test). */
function apiBaseFromAddress(address: string): string {
  const host = address
    .trim()
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
  return `http://${host}:8005`
}

type SetupMode = 'token' | 'code'

/** First-run / re-config: enter the gateway address (Tailscale host/IP) + optional API token, OR —
 * Onboarding Phase 1 — a 6-digit pairing code from a daemon in setup mode. Pairing exchanges the
 * code for the real token in the MAIN process (address → app-data, token → OS keychain — never
 * here), then polls until the real daemon is up and enters the app like a normal connect. */
export function FirstRunSetup({ currentAddress, onConnected }: Props) {
  const [mode, setMode] = useState<SetupMode>('token')
  const [address, setAddress] = useState(currentAddress ?? '')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [test, setTest] = useState<ConnectionTestResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Pairing path state
  const [code, setCode] = useState('')
  const [pairing, setPairing] = useState(false)
  const [paired, setPaired] = useState(false) // waiting for the real daemon
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  // Poll after "Paired ✓" until the REAL daemon answers /api/status 200 (the setup-mode daemon and
  // the restart gap both keep waiting), then proceed exactly like the normal connect path.
  useEffect(() => {
    if (!paired || !window.beacon) return
    let cancelled = false
    const tick = async (): Promise<void> => {
      try {
        const res = await window.beacon.setup.pairPoll()
        if (!cancelled && res.state === 'ready') onConnected()
      } catch {
        /* keep polling — unreachable is the expected restart gap */
      }
    }
    void tick()
    pollTimer.current = setInterval(() => void tick(), PAIR_POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      if (pollTimer.current) clearInterval(pollTimer.current)
    }
  }, [paired, onConnected])

  async function probe(): Promise<void> {
    const addr = address.trim()
    if (!addr || testing || !window.beacon) return
    setTesting(true)
    setTest(null)
    setError(null)
    try {
      const res = await window.beacon.connection.test({
        apiBase: apiBaseFromAddress(addr),
        token: token.trim() || undefined,
        useSavedToken: false // first-run: test exactly what's typed, nothing else
      })
      setTest(res)
    } catch (e) {
      setError(String(e))
    } finally {
      setTesting(false)
    }
  }

  async function connect(): Promise<void> {
    const addr = address.trim()
    if (!addr || busy || !window.beacon) return
    setBusy(true)
    setError(null)
    try {
      const res = await window.beacon.setup.save({ address: addr, token: token.trim() || undefined })
      if (res.ok) onConnected()
      else setError(res.error ?? 'Failed to connect.')
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  async function pair(): Promise<void> {
    const addr = address.trim()
    const c = code.trim()
    if (!addr || pairing || paired || !window.beacon) return
    if (!isValidPairingCode(c)) {
      setError(`The pairing code is exactly ${PAIRING_CODE_LENGTH} digits.`)
      return
    }
    setPairing(true)
    setError(null)
    try {
      const res: PairResult = await window.beacon.setup.pair({ address: addr, code: c })
      if (res.ok) setPaired(true)
      else setError(res.error ?? 'Pairing failed.')
    } catch (e) {
      setError(String(e))
    } finally {
      setPairing(false)
    }
  }

  function switchMode(next: SetupMode): void {
    if (paired) return // mid-handshake — don't abandon the poll silently
    setMode(next)
    setError(null)
    setTest(null)
  }

  const pairDisabled = pairing || paired || address.trim().length === 0 || !isValidPairingCode(code.trim())

  return (
    <div className="setup">
      <div className="setup-card">
        <div className="setup-brand">
          <span className="brand-dot" /> Beacon
        </div>
        <h1>Connect to your Prometheus</h1>

        <div className="setup-tabs" role="tablist" aria-label="Connection method">
          <button
            role="tab"
            aria-selected={mode === 'token'}
            className={mode === 'token' ? 'setup-tab active' : 'setup-tab'}
            onClick={() => switchMode('token')}
          >
            I have a token
          </button>
          <button
            role="tab"
            aria-selected={mode === 'code'}
            className={mode === 'code' ? 'setup-tab active' : 'setup-tab'}
            onClick={() => switchMode('code')}
          >
            I have a pairing code
          </button>
        </div>

        <p className="setup-sub">
          {mode === 'token' ? (
            <>
              Enter your mini&apos;s Tailscale address. The API token is optional — leave it blank if the daemon has
              no <code>PROMETHEUS_API_TOKEN</code> set.
            </>
          ) : (
            <>
              A daemon started without a config prints a 6-digit pairing code in its terminal. Enter its address and
              that code — Beacon exchanges it for the real token.
            </>
          )}
        </p>

        <label className="setup-field">
          Gateway address
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void (mode === 'token' ? connect() : pair())
            }}
            placeholder="host:8005  ·  your mini's Tailscale host or IP"
            autoFocus
            spellCheck={false}
            disabled={paired}
          />
        </label>

        {mode === 'token' ? (
          <label className="setup-field">
            API token <span className="opt">optional</span>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void connect()
              }}
              placeholder="PROMETHEUS_API_TOKEN, or leave blank"
              spellCheck={false}
            />
          </label>
        ) : (
          <label className="setup-field">
            Pairing code
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, PAIRING_CODE_LENGTH))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void pair()
              }}
              placeholder="6 digits from the daemon's terminal"
              inputMode="numeric"
              spellCheck={false}
              disabled={paired}
            />
          </label>
        )}

        {test ? <div className={test.ok ? 'setup-test-ok' : 'setup-error'}>{test.label}</div> : null}
        {error ? <div className="setup-error">{error}</div> : null}
        {paired ? (
          <div className="setup-test-ok">
            Paired ✓ — this daemon is still in setup mode. Finish <code>oara setup</code> in its terminal;
            Beacon will connect automatically.
          </div>
        ) : null}

        {mode === 'token' ? (
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="setup-test"
              onClick={() => void probe()}
              disabled={testing || address.trim().length === 0}
              title="Probe the gateway with these values — nothing is saved yet"
            >
              {testing ? 'Testing…' : 'Test'}
            </button>
            <button
              className="setup-connect"
              style={{ flex: 1, width: 'auto' }}
              onClick={() => void connect()}
              disabled={busy || address.trim().length === 0}
            >
              {busy ? 'Connecting…' : 'Connect'}
            </button>
          </div>
        ) : (
          <button className="setup-connect" onClick={() => void pair()} disabled={pairDisabled}>
            {paired ? 'Waiting for the daemon…' : pairing ? 'Pairing…' : 'Pair'}
          </button>
        )}

        <p className="setup-foot">
          The address is stored locally; the token goes in your OS keychain. Neither leaves this machine except to
          reach your mini. Once connected: <strong>⌘K</strong> opens the command palette, <strong>?</strong> shows
          every shortcut.
        </p>
        <p className="setup-foot">
          <a href={SETUP_LINKS.guide} target="_blank" rel="noreferrer" style={{ color: 'var(--c-arc)' }}>
            The setup guide ↗
          </a>{' '}
          covers installing Prometheus, pairing, and what each message means.
        </p>
      </div>
    </div>
  )
}
