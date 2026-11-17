import { useEffect, useState, type CSSProperties } from 'react'
import type { ApprovalRequest } from '@shared/ipc'
import {
  RESULT_POLL_MS,
  RESULT_POLL_TRIES,
  coerceActionResult,
  homeActionPath,
  homeCardView,
  resultLineView,
  resultTone,
  type HomeActionResult
} from '@shared/home-approval'
import { Icon } from './Icon'
import { approvalCardStyle, approvalHeaderStyle } from './ExecApprovalCard'

/**
 * What happened after a Home approval was answered (docs/HA-UI-DATA-CONTRACT.md §3.1).
 *
 * The server re-reads the device after it acts and reports what it really reads. This card asks the
 * daemon for that (GET /api/home/actions/{id}, through the daemon bridge) about once a second, up to
 * 20 times, and shows the server's own sentence per device:
 *
 *   ✓ Confirmed      "Hall light is on"
 *   ⚠ Not confirmed  "Home Assistant accepted it, but the light still reports off"
 *   ✕ Failed         "Home Assistant did not answer"
 *
 * The warning differs from success in glyph, word and colour, so it is not read as a pass. If the
 * daemon has nothing by the end, the card says the result is not known; it never says "done".
 * A confirmed result clears itself after a few seconds; anything else stays until dismissed.
 */

const AUTO_DISMISS_MS = 8000
const body: CSSProperties = { padding: '11px 12px', display: 'flex', flexDirection: 'column', gap: 8 }

export function HomeResultCard({ approval, onDismiss }: { approval: ApprovalRequest; onDismiss: () => void }) {
  const [result, setResult] = useState<HomeActionResult | null>(null)
  const [gaveUp, setGaveUp] = useState<string | null>(null)
  const title = approval.home ? homeCardView(approval).title : approval.toolName

  useEffect(() => {
    let alive = true
    let tries = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = (): void => {
      tries += 1
      window.beacon.daemon.get(homeActionPath(approval.requestId)).then(
        (raw) => {
          if (!alive) return
          const r = coerceActionResult(raw)
          if (r) setResult(r)
          if (r && r.state === 'done') return
          next(null)
        },
        (e) => alive && next(String(e instanceof Error ? e.message : e))
      )
    }
    // 404 is "not run yet" and keeps polling; anything else is remembered so the last line can say it.
    const next = (err: string | null): void => {
      if (tries >= RESULT_POLL_TRIES) {
        setGaveUp(err && !/HTTP 404/.test(err) ? `Couldn't read the result: ${err.slice(0, 160)}` : 'Home Assistant has not reported the result yet. Check the device in Home Assistant.')
        return
      }
      timer = setTimeout(poll, RESULT_POLL_MS)
    }
    poll()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [approval.requestId])

  const tone = result ? resultTone(result) : 'pending'
  useEffect(() => {
    if (tone !== 'success') return
    const t = setTimeout(onDismiss, AUTO_DISMISS_MS)
    return () => clearTimeout(t)
  }, [tone, onDismiss])

  return (
    <div style={approvalCardStyle} data-testid="home-result" data-tone={gaveUp && tone === 'pending' ? 'unknown' : tone}>
      <div style={approvalHeaderStyle}>
        <span style={{ fontSize: 11.5, color: 'var(--lapis-text)' }}>Home · {title}</span>
        <button
          onClick={onDismiss}
          aria-label="Dismiss"
          style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: 'var(--c-text-dim)', cursor: 'pointer', padding: 2, display: 'inline-flex' }}
        >
          <Icon name="x" size={12} />
        </button>
      </div>
      <div style={body} aria-live="polite">
        {result && result.results.length > 0 ? (
          result.results.map((l, i) => {
            const v = resultLineView(l)
            const color = v.glyph === 'check' ? 'var(--c-ok-text)' : v.glyph === 'warn' ? 'var(--c-warn-text)' : 'var(--c-err-text)'
            return (
              <div key={`${l.deviceId}:${i}`} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5, lineHeight: 1.45 }} data-testid="home-result-line" data-glyph={v.glyph}>
                <span style={{ color, display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0, fontWeight: 600 }}>
                  <Icon name={v.glyph === 'check' ? 'check' : v.glyph === 'warn' ? 'warning' : 'x'} size={13} />
                  {v.word}
                </span>
                <span>{v.text}</span>
              </div>
            )
          })
        ) : gaveUp ? (
          <div style={{ fontSize: 12.5 }} data-testid="home-result-unknown">{gaveUp}</div>
        ) : result?.state === 'done' ? (
          <div style={{ fontSize: 12.5, color: 'var(--c-warn-text)' }} data-testid="home-result-unknown">Home Assistant reported nothing about this action. Check the device in Home Assistant.</div>
        ) : (
          <div style={{ fontSize: 12.5, color: 'var(--c-text-dim)' }}>Waiting for Home Assistant to report…</div>
        )}
      </div>
    </div>
  )
}
