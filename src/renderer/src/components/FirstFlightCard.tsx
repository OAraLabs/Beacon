import { useEffect, useState } from 'react'
import type { ViewId } from '@shared/views'
import {
  FIRST_FLIGHT_DISMISSED_KEY,
  FIRST_FLIGHT_DONE_KEY,
  FIRST_FLIGHT_ITEMS,
  FIRST_FLIGHT_OFFERED_KEY,
  firstFlightVisible,
  parseFirstFlightDone,
  serializeFirstFlightDone,
  type FirstFlightItemId
} from '@shared/setup-wizard'

// "First flight" checklist (Onboarding Phase 2, step 8) — a dismissible card on Mission home shown
// ONLY after the setup wizard finished (b.settings 'firstflight:offered'). Three items with
// deep-link chips; per-item done state + dismissal persist via the SAME b.settings mechanism the
// other panels use. Purely additive to MissionHome — the armilla and HUD are untouched.

const CHIPS: { id: FirstFlightItemId; label: string; view: ViewId }[] = [
  { id: 'send-message', label: 'Chat', view: 'chat' },
  { id: 'explore-panel', label: 'Board', view: 'board' },
  { id: 'explore-panel', label: 'Loop Manager', view: 'loop-manager' }
]

export function FirstFlightCard({ onOpenView }: { onOpenView: (v: ViewId) => void }) {
  const [visible, setVisible] = useState(false)
  const [done, setDone] = useState<Set<FirstFlightItemId>>(new Set())

  useEffect(() => {
    const b = window.beacon
    if (!b) return
    void (async () => {
      const [offered, dismissed, doneRaw] = await Promise.all([
        b.settings.get(FIRST_FLIGHT_OFFERED_KEY).catch(() => null),
        b.settings.get(FIRST_FLIGHT_DISMISSED_KEY).catch(() => null),
        b.settings.get(FIRST_FLIGHT_DONE_KEY).catch(() => null)
      ])
      setDone(parseFirstFlightDone(doneRaw))
      setVisible(firstFlightVisible(offered, dismissed))
    })()
  }, [])

  if (!visible) return null

  const markDone = (id: FirstFlightItemId): void => {
    const next = new Set(done)
    next.add(id)
    setDone(next)
    void window.beacon?.settings.set(FIRST_FLIGHT_DONE_KEY, serializeFirstFlightDone(next)).catch(() => undefined)
  }

  const dismiss = (): void => {
    setVisible(false)
    void window.beacon?.settings.set(FIRST_FLIGHT_DISMISSED_KEY, '1').catch(() => undefined)
  }

  return (
    <div className="firstflight-card">
      <div className="firstflight-head">
        <span>First flight</span>
        <button className="firstflight-dismiss" onClick={dismiss} title="Dismiss (won't show again)">
          ✕
        </button>
      </div>
      <ul className="firstflight-list">
        {FIRST_FLIGHT_ITEMS.map((item) => (
          <li key={item.id} className={done.has(item.id) ? 'done' : undefined}>
            <button
              className="firstflight-check"
              onClick={() => markDone(item.id)}
              title="Mark done"
              aria-label={`Mark "${item.label}" done`}
            >
              {done.has(item.id) ? '✓' : '○'}
            </button>
            <span>{item.label}</span>
            {item.id === 'send-message' ? (
              <button
                className="firstflight-chip"
                onClick={() => {
                  markDone('send-message')
                  onOpenView('chat')
                }}
              >
                Chat →
              </button>
            ) : null}
            {item.id === 'explore-panel' ? (
              <span className="firstflight-chips">
                {CHIPS.filter((c) => c.id === 'explore-panel').map((c) => (
                  <button
                    key={c.view}
                    className="firstflight-chip"
                    onClick={() => {
                      markDone('explore-panel')
                      onOpenView(c.view)
                    }}
                  >
                    {c.label} →
                  </button>
                ))}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  )
}
