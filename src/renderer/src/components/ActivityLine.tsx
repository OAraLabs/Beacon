/**
 * ActivityLine — what the agent is doing RIGHT NOW, driven by the daemon's
 * `agent_progress` pulse (session-scoped, ~every 3s).
 *
 * Design rule that matters: **movement means liveness.** The spinner and the
 * rotating word advance ONLY when a real frame arrives — never on a CSS timer.
 * The old blinking caret animated forever regardless of whether anything was
 * alive, which is exactly how a dead socket masqueraded as a working one for
 * two days. Here, if the daemon goes quiet the line visibly freezes and then
 * says so.
 */
import { useEffect, useState } from 'react'

export interface Activity {
  phase: string
  toolName?: string | null
  round?: number
  chars?: number
  toolCalls?: number
  elapsedS?: number
  /** Client clock (ms) when the last pulse landed — drives the stall notice. */
  at: number
  /** Increments per pulse; rotates the word so the change is EVENT-driven. */
  tick: number
}

/** Phase-appropriate vocabulary. Playful, but always paired with real facts. */
const WORDS: Record<string, string[]> = {
  thinking: ['Pondering', 'Ruminating', 'Cogitating', 'Percolating', 'Deliberating', 'Musing'],
  tool: ['Rummaging', 'Spelunking', 'Foraging', 'Tinkering', 'Wrangling', 'Excavating'],
  generating: ['Composing', 'Weaving', 'Elaborating', 'Unspooling', 'Drafting'],
  // The daemon's pulse while it compacts the conversation (issue 283). One plain word, not a rotation:
  // the operator should read what is happening, and CompactionLine carries the detail when the
  // session-scoped frame is there too.
  compacting: ['Tidying up']
}
const FALLBACK = ['Working', 'Whirring', 'Churning']

/** Frames older than this mean the turn (or the link) is in trouble. The daemon
 * pulses every ~3s, so this is many missed beats — not an impatient timer. */
const STALL_AFTER_MS = 20_000

// The spinner is an ARC (match spec, step 11) rather than a text glyph — but it is still advanced
// BY THE FRAME, a quarter turn per pulse, never by a CSS animation. That is the whole point of the
// component: a spinner on an 0.8s timer keeps turning after the socket dies, which is exactly how
// a dead connection passed for a working one for two days. It looks like the spec's spinner and
// it still visibly freezes when the daemon goes quiet.
const QUARTER_TURN = 90

function words(phase: string): string[] {
  return WORDS[phase] ?? FALLBACK
}

function formatCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function formatElapsed(s: number): string {
  if (s < 60) return `${Math.round(s)}s`
  const m = Math.floor(s / 60)
  return `${m}m${String(Math.round(s % 60)).padStart(2, '0')}s`
}

export function ActivityLine({ activity }: { activity: Activity }): React.JSX.Element {
  // Re-render on a light interval ONLY to age the stall notice + elapsed clock.
  // It never advances the word or the spinner — those are frame-driven.
  const [, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(t)
  }, [])

  const silentMs = Date.now() - activity.at
  const stalled = silentMs > STALL_AFTER_MS

  if (stalled) {
    return (
      <div className="activity-line activity-stalled" role="status" aria-live="polite">
        <span className="activity-glyph" aria-hidden>⚠</span>
        <span className="activity-word">No signal from the gateway</span>
        <span className="activity-facts">
          · quiet for {formatElapsed(silentMs / 1000)} · the turn may have died, or the connection dropped
        </span>
      </div>
    )
  }

  const list = words(activity.phase)
  const word = list[activity.tick % list.length]

  // LEFT of the strip: what it is doing, in words. RIGHT: the measured facts, in mono, because
  // they are values. `2.1k tok` is what the design asks for and is NOT available — the pulse
  // carries characters, not tokens — so the strip says `chars` and means it.
  const said: string[] = []
  if (activity.toolName) said.push(activity.toolName)
  if (typeof activity.round === 'number' && activity.round > 1) said.push(`round ${activity.round}`)

  const measured: string[] = []
  if (typeof activity.elapsedS === 'number') measured.push(formatElapsed(activity.elapsedS))
  if (typeof activity.chars === 'number' && activity.chars > 0) {
    measured.push(`${formatCount(activity.chars)} chars`)
  }

  return (
    <div className="activity-line" role="status" aria-live="polite">
      <span
        className="activity-spinner"
        style={{ transform: `rotate(${activity.tick * QUARTER_TURN}deg)` }}
        aria-hidden
      />
      <span className="activity-word">
        {word}…{said.length > 0 ? <span className="activity-said"> {said.join(' · ')}</span> : null}
      </span>
      {measured.length > 0 ? <span className="activity-facts">{measured.join(' · ')}</span> : null}
    </div>
  )
}
