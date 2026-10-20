import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import {
  reduceToolCalls,
  toolCallsFromApi,
  mergeToolCalls,
  toActivityItem,
  activityFromRow,
  inActivityFeed,
  type EventRow,
  type ToolCallRecord,
  type ToolCallRowDTO,
  type ActivityItem
} from '@shared/gateway-events'
import { asList } from '@shared/daemon-api'
import { CODING_EVENT_KINDS, reduceCodingRuns, type CodingRuns } from '@shared/coding'
import {
  EMPTY_COMPUTER,
  computerBackfillPath,
  isComputerEvent,
  mergeComputerBackfill,
  reduceComputer,
  type ComputerState
} from '@shared/computer'
import { reduceSessionActivity, pruneSessionActivity, type SessionActivity } from '@shared/session-activity'
import { useDeviceRole } from './components/OwnerOnlyNote'

/**
 * Renderer-side gateway store (Phase 5a). Subscribes ONCE to window.beacon.events.onGateway (the
 * non-chat frame stream surfaced by ws.ts) and folds it into derived state the panels read:
 *   - toolCalls: tool_call_start/end paired + latency (reduceToolCalls), seeded on mount from
 *     GET /api/tools/recent. NOT from the /api/events/recent tail activity uses: tool_call_* frames
 *     are WS fan-out and are never persisted to signal_events, so that tail has no tool call in it.
 *     Before the seed the feed opened EMPTY every launch, beside a telemetry card reporting the
 *     lifetime total_calls read off the very table /api/tools/recent now exposes per-call.
 *   - activity:  every frame as an ActivityItem, seeded from /api/events/recent on mount.
 *   - codingRuns: per-run live state from the coding_round/complete/stream_error stream (Phase A
 *     daemon, Prometheus PR #48) — the Coding panel's Live view reads it by session_id.
 *   - computer: the desktop action log (computer_* frames, Prometheus PR 663) per chat session — the
 *     dock's computer-use section reads it. Seeded per session by backfillComputer, which a view
 *     calls when it opens a session and again after a reconnect.
 * Mounted at MainView so it accumulates across view switches (Tool Feed shows history even if you
 * were on Chat when the calls happened). reduceToolCalls / reduceCodingRuns return the SAME ref for
 * unrelated events, so those don't re-render the lists.
 */
interface GatewayState {
  toolCalls: ToolCallRecord[]
  activity: ActivityItem[]
  /** Latest agent_state frame ('thinking' | 'idle' | …) — live badge for the Status panel. */
  agentState: string | null
  /** session_id (`coding:<id>`) → live coding-run state (rounds, terminal verdict, stream error). */
  codingRuns: CodingRuns
  /** chat session_id → desktop tasks (steps by seq, outcome) and the app pick (@shared/computer). */
  computer: ComputerState
  /** Merge one session's action log from GET /api/events/recent under the live frames. Resolves
   *  with the error text when the read failed, null when it landed. */
  backfillComputer: (sessionId: string) => Promise<string | null>
  /** session_id → the turn running in it right now (@shared/session-activity). Keyed, unlike
   * agentState, so the sidebar can mark every working session and not just the loudest one. */
  sessionActivity: SessionActivity
  /** Client clock, advanced every few seconds ONLY while some session is working — what turns a
   * silent turn into a stalled one without a frame arriving. */
  activityNow: number
  /** Drop the accumulated activity feed (the Activity panel's Clear button). Live frames still flow. */
  clearActivity: () => void
}

const ACTIVITY_CAP = 500
/** Matches reduceToolCalls' own cap — seeding more than the live reducer would ever keep is waste. */
const TOOL_SEED_LIMIT = 200
const GatewayContext = createContext<GatewayState>({
  toolCalls: [],
  activity: [],
  agentState: null,
  codingRuns: {},
  computer: EMPTY_COMPUTER,
  backfillComputer: async () => 'not connected',
  sessionActivity: {},
  activityNow: 0,
  clearActivity: () => {}
})

export function useGateway(): GatewayState {
  return useContext(GatewayContext)
}

export function GatewayStoreProvider({ children }: { children: ReactNode }) {
  const [toolCalls, setToolCalls] = useState<ToolCallRecord[]>([])
  const [activity, setActivity] = useState<ActivityItem[]>([])
  const [agentState, setAgentState] = useState<string | null>(null)
  const [codingRuns, setCodingRuns] = useState<CodingRuns>({})
  const [computer, setComputer] = useState<ComputerState>(EMPTY_COMPUTER)
  const [sessionActivity, setSessionActivity] = useState<SessionActivity>({})
  const [activityNow, setActivityNow] = useState(() => Date.now())
  const clearActivity = useCallback(() => setActivity([]), [])
  // Merges UNDER the live frames: the reducer's keys ((task_id, seq) for steps, task_id for
  // start/end, daemon time for the app pick) make the overlap with the socket a no-op.
  const backfillComputer = useCallback(async (sessionId: string): Promise<string | null> => {
    const b = window.beacon
    if (!b) return 'not connected'
    try {
      const rows = asList<EventRow>(await b.daemon.get(computerBackfillPath(sessionId)))
      if (rows.length > 0) setComputer((prev) => mergeComputerBackfill(prev, rows))
      return null
    } catch (e) {
      return String((e as Error)?.message ?? e)
    }
  }, [])

  // Backfill the tool feed from the per-call tail. Separate request, separate table: the signal
  // tail carries no tool call at all. Live frames can land before this resolves, so the seed merges
  // UNDER whatever is already there rather than replacing it. The owner's only (an approved device
  // is refused /api/tools/recent, and its feed is live-only), so it waits until main has said which.
  const role = useDeviceRole()
  useEffect(() => {
    const b = window.beacon
    if (!b || role === undefined || role === 'limited') return
    let alive = true
    void b.daemon
      .get(`/api/tools/recent?limit=${TOOL_SEED_LIMIT}`)
      .then((data) => {
        if (!alive) return
        const seeded = toolCallsFromApi(asList<ToolCallRowDTO>(data))
        // No state write on an empty seed: no needless re-render, and an empty feed stays visibly
        // empty instead of a no-op masquerading as a successful backfill.
        if (seeded.length > 0) setToolCalls((prev) => mergeToolCalls(prev, seeded))
      })
      .catch(() => undefined) // older daemon without the route → live-only, as before
    return () => {
      alive = false
    }
  }, [role])

  useEffect(() => {
    const b = window.beacon
    if (!b) return
    let alive = true

    // Backfill the activity feed from the durable signal_events tail, then subscribe live.
    void b.events
      .recent(100)
      .then((rows) => {
        if (!alive) return
        // The same exclusions as the live path below. The seed is the durable signal tail, which
        // carries computer_step and computer_binding rows too (and coding_round), so without this
        // they reached the feed through the backfill while the live path kept them out.
        const seed = rows
          .filter((r) => inActivityFeed(r.signal_type ?? ''))
          .map(activityFromRow)
          .sort((a, z) => a.ts - z.ts)
        setActivity((prev) => [...seed, ...prev].slice(-ACTIVITY_CAP))
      })
      .catch(() => undefined)

    const off = b.events.onGateway((ev) => {
      setToolCalls((prev) => reduceToolCalls(prev, ev))
      if (ev.type === 'agent_state' && typeof ev.payload.state === 'string') setAgentState(ev.payload.state)
      // Restamped with THIS machine's clock: ev.ts is the daemon's `timestamp` when it sends one,
      // and the daemon may be another host. The stall check subtracts it from Date.now().
      const now = Date.now()
      setSessionActivity((prev) => reduceSessionActivity(prev, { ...ev, ts: now }))
      setActivityNow(now)
      // The SAME set the reducer folds (@shared/coding), not a second hand-written list — a
      // gate here that drifts from the reducer drops frames with no error, which is the shape of
      // the ws_server promotion bug this pair of fixes came out of.
      if (CODING_EVENT_KINDS.has(ev.type)) {
        setCodingRuns((prev) => reduceCodingRuns(prev, ev))
      }
      // The same rule for the desktop action log: the gate is the reducer's own set (+ a kind that
      // arrives wrapped as sentinel_signal, which the reducer unwraps).
      if (isComputerEvent(ev)) {
        setComputer((prev) => reduceComputer(prev, ev))
      }
      // The high-frequency per-run coding streams have their own Live view; keep them out of the
      // general activity feed (30+ rounds and hundreds of tool frames per run would drown
      // everything else, like chat_delta is dropped upstream in ws.ts). The single complete/error
      // milestones still surface there.
      //
      // coding_tool and coding_acceptance joined this list the day they started arriving as
      // themselves: before Prometheus PR 503 they came wrapped as sentinel_signal, so they were ALREADY
      // falling into the feed here — uncategorised, one row per tool call — and nobody noticed
      // because the wrapper hid what they were.
      //
      // computer_step (one per desktop action) and computer_binding (the app pick on/off around each
      // task) are kept out for the same reason; the dock's computer-use section shows them. The set
      // lives in @shared/gateway-events (ACTIVITY_EXCLUDED_KINDS) so the seed above uses it too.
      if (!inActivityFeed(ev.type)) return
      setActivity((prev) => {
        const next = [...prev, toActivityItem(ev)]
        return next.length > ACTIVITY_CAP ? next.slice(-ACTIVITY_CAP) : next
      })
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  // The stall clock. Only runs while a turn is live; an idle app schedules nothing.
  const anyWorking = Object.keys(sessionActivity).length > 0
  useEffect(() => {
    if (!anyWorking) return
    const id = setInterval(() => {
      const now = Date.now()
      setActivityNow(now)
      setSessionActivity((prev) => pruneSessionActivity(prev, now))
    }, 5000)
    return () => clearInterval(id)
  }, [anyWorking])

  return (
    <GatewayContext.Provider value={{ toolCalls, activity, agentState, codingRuns, computer, backfillComputer, sessionActivity, activityNow, clearActivity }}>
      {children}
    </GatewayContext.Provider>
  )
}
