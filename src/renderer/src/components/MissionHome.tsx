import type { ApprovalDecision, ApprovalRequest } from '@shared/ipc'
import type { ViewId } from '@shared/views'
import { MissionControl } from './MissionControl'
import { FirstFlightCard } from './FirstFlightCard'
import { Armilla } from './Armilla'
import { MissionTopBar } from './MissionTopBar'

// Mission home — the cockpit landing (default view, a standalone rail destination). Design handoff
// 2026-09-03, screen 2: "is the daemon healthy, is anything waiting on me, what is scheduled."
//   BANNER — the Beacon banner (brand + read-only model pill + connection status + skin picker).
//   LEFT   — 452px fixed: the ARMILLA (telemetry-driven armillary sphere) and, new, a four-pair
//            LEGEND — the only place in the UI where the "motion is telemetry" contract is written
//            down for someone who will not read the caption sentence.
//   RIGHT  — flex: the MissionControl HUD (real /api/status, /api/tasks, /api/cron, /api/models,
//            /api/telemetry, /api/sentinel) — with every empty card collapsed to one row (R5).
// REMOVED (per the handoff): the right-hand "A light for the voyage" pane and its composer. That is
// a Conversations empty state; on Mission it competed with the page and duplicated "New chat",
// which lives in the agent strip. Renderer-only; no daemon change, no new IPC.

const LEGEND: { key: string; what: string }[] = [
  { key: 'SPIN', what: 'sphere rate = live work heat' },
  { key: 'NODES', what: 'ecliptic marks = open sessions' },
  { key: 'DIAL', what: 'horizon ticks = 24h signals' },
  { key: 'FROZEN', what: 'sky dims when the link drops' }
]

export function MissionHome({
  approvals,
  onResolveApproval,
  onNewChat,
  onOpenView
}: {
  approvals: ApprovalRequest[]
  onResolveApproval: (id: string, decision: ApprovalDecision) => void
  onNewChat: () => void
  onOpenView: (v: ViewId) => void
}) {
  return (
    <div className="mission-home" style={{ minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <MissionTopBar />
      <div className="mission-body hud-grid">
        {/* LEFT — the armilla and how to read it */}
        <div className="mission-left">
          <Armilla />
          <dl className="armilla-legend" aria-label="How to read the armilla">
            {LEGEND.map((l) => (
              <div key={l.key} className="armilla-legend-row">
                <dt>{l.key}</dt>
                <dd>{l.what}</dd>
              </div>
            ))}
          </dl>
        </div>
        {/* RIGHT — the HUD */}
        <div className="mission-right">
          {/* Onboarding Phase 2: dismissible first-flight checklist — additive; HUD untouched. */}
          <FirstFlightCard onOpenView={onOpenView} />
          <MissionControl approvals={approvals} onResolveApproval={onResolveApproval} onNewChat={onNewChat} onOpenView={onOpenView} />
        </div>
      </div>
    </div>
  )
}
