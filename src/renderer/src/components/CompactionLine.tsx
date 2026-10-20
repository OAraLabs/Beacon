/**
 * CompactionLine — "Tidying up the conversation so we can keep going…" with a progress bar, in the
 * chat's activity slot while the daemon compacts THIS session (issue 283). What it shows is decided in
 * @shared/compaction-status; this only draws it.
 *
 * Same rule as ActivityLine: movement means liveness. The spinner turns a quarter per
 * `agent_progress` pulse (the `tick` ChatShell already counts), the bar moves only when a progress
 * frame lands, and the indeterminate bar is a still hatch, not a CSS animation. A pass that stops
 * reporting therefore looks stopped.
 *
 * The polite live region is always mounted, even with nothing visible, so the "finished" announcement
 * is heard after the line itself has gone.
 */
import {
  COMPACTION_FAILED_TEXT,
  COMPACTION_RUNNING_TEXT,
  type CompactionState
} from '@shared/compaction-status'

const QUARTER_TURN = 90

export function CompactionLine({ state, tick }: { state: CompactionState; tick: number }): React.JSX.Element {
  const pct = state.fraction === null ? null : Math.round(state.fraction * 100)
  return (
    <>
      <div className="sr-only compaction-live" role="status" aria-live="polite">
        {state.announce}
      </div>
      {state.show === 'running' ? (
        <div className="activity-line compaction-line">
          <span
            className="activity-spinner"
            style={{ transform: `rotate(${tick * QUARTER_TURN}deg)` }}
            aria-hidden
          />
          <span className="activity-word">{COMPACTION_RUNNING_TEXT}</span>
          <span
            className={pct === null ? 'compaction-bar compaction-bar-indeterminate' : 'compaction-bar'}
            role="progressbar"
            aria-label="Tidying up the conversation"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct ?? undefined}
          >
            {pct === null ? null : <span className="compaction-bar-fill" style={{ width: `${pct}%` }} />}
          </span>
        </div>
      ) : state.show === 'failed' ? (
        <div className="activity-line compaction-failed">
          <span className="activity-word">{COMPACTION_FAILED_TEXT}</span>
        </div>
      ) : null}
    </>
  )
}
