// "Let other computers on my home network connect" (docs/MULTI-COMPUTER-v0.4.md §2): reading and changing Prometheus's
// network setting (Prometheus #700, GET/PUT /api/network) and restarting it (Prometheus #724, POST /api/restart). What each
// answer means is decided here, against answers recorded from a real daemon (src/main/fixtures/network_setting_700.json).
//
// One trap in the wire: GET's `mode` is what is RUNNING (a saved change is `pending_mode`), but PUT's answer describes the SAVED
// state, with no `pending_mode`. So the view always comes from GET; PUT's answer only says saved or refused.
//
// No Node/Electron imports (same rule as the rest of src/shared).

export const NETWORK_ROUTE = '/api/network'
export const RESTART_ROUTE = '/api/restart'
/** How long Beacon waits for Prometheus to answer again after a restart (spec §2.4). A real one took about 1 s. */
export const RESTART_WAIT_MS = 60_000

export type NetworkMode = 'this_mac' | 'home_network' | 'open'
const MODES: readonly string[] = ['this_mac', 'home_network', 'open']

export interface NetworkView {
  /** What the switch shows: the saved choice when a restart is pending, else what is running. */
  on: boolean
  /** Whether the switch is there at all (can_change); when not, `why` says why. */
  canChange: boolean
  why: string | null
  /** The line under the switch, and one more line per warning or advertising reason. */
  line: string
  notes: string[]
  /** A saved change waits for a restart. */
  restartNeeded: boolean
}

export type NetworkRead = { kind: 'shown'; view: NetworkView } | { kind: 'hidden' } | { kind: 'unreadable'; detail: string }

const LINE: Record<NetworkMode, string> = {
  this_mac: 'Only this Mac can use Prometheus.',
  home_network: 'Beacon on your other computers can find this Prometheus and ask to connect. You approve each one.',
  open: 'Prometheus can already be reached from other computers, without the home-network protections. Turn this on to use them.'
}
export const RESTART_LINE = 'Restart Prometheus to finish.'
const WARNING: Record<string, string | null> = {
  plain_http_on_lan: 'Messages to Prometheus travel unencrypted on your home network.',
  home_network_unavailable: "Prometheus can't share safely on your network yet, so it isn't announcing itself.",
  home_network_on_loopback: 'Prometheus is set to share, but it only listens on this Mac.',
  listening_on_all_interfaces: 'Prometheus listens on every network this Mac is on.',
  restart_required: null // the restart line says it
}
const ADVERTISING: Record<string, string> = {
  no_usable_address: "This Mac isn't on a home network right now, so other computers can't find it.",
  library_missing: "Prometheus can't announce itself on this network (it's missing a part). Other computers can still connect by address.",
  registration_failed: "Prometheus couldn't announce itself; it will keep trying."
}
/** Why there is no switch, by what fixed the address (#700's bind_source; "config" and "default" are the file's, and changeable). */
const PINNED: Record<string, string> = {
  flag: 'Prometheus was started in a way that keeps it on this Mac.',
  env: "Prometheus's address is set where it starts, so it can't be changed here.",
  caller: 'Prometheus was set up to stay on the address Beacon first reached it on.'
}
const PINNED_OTHER = "This setting can't be changed from here."
const pinnedWhy = (source: string): string => (Object.hasOwn(PINNED, source) ? PINNED[source] : PINNED_OTHER)

interface Notice {
  code: string
  message: string
}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const notice = (v: unknown): Notice | null => (isObj(v) && typeof v.code === 'string' && typeof v.message === 'string' ? { code: v.code, message: v.message } : null)
/** A code Beacon has words for, or the daemon's own message (never nothing: #700, "clients must tolerate a code they do not know"). */
const said = (n: Notice, words: Record<string, string | null>): string | null => (Object.hasOwn(words, n.code) ? words[n.code] : n.message.trim() || n.code)

/** GET /api/network's answer: the section (shown or not) and what it says. */
export function readNetwork(status: number, body: unknown): NetworkRead {
  // An approved device that is not the owner: the setting is not theirs, so there is no section at all (recorded: 403 operator_only).
  if (status === 403 && isObj(body) && body.error === 'operator_only') return { kind: 'hidden' }
  if (status !== 200) return { kind: 'unreadable', detail: `HTTP ${status}` }
  if (!isObj(body)) return { kind: 'unreadable', detail: 'not a JSON object' }
  const b = body
  const warnings = Array.isArray(b.warnings) ? b.warnings.map(notice) : null
  const reason = b.advertising_reason === null ? null : notice(b.advertising_reason)
  const ok =
    typeof b.mode === 'string' &&
    MODES.includes(b.mode) &&
    typeof b.bind === 'string' &&
    typeof b.bind_source === 'string' &&
    isObj(b.tls) &&
    typeof b.advertising === 'boolean' &&
    (b.advertising_reason === null || reason !== null) &&
    (b.applied === 'live' || b.applied === 'on_restart') &&
    warnings !== null &&
    warnings.every((w) => w !== null) &&
    typeof b.can_change === 'boolean' &&
    (b.pending_mode === undefined || (typeof b.pending_mode === 'string' && MODES.includes(b.pending_mode)))
  if (!ok) return { kind: 'unreadable', detail: 'an answer Beacon does not understand' }
  const mode = b.mode as NetworkMode
  const restartNeeded = b.applied === 'on_restart'
  const saved = restartNeeded && typeof b.pending_mode === 'string' ? (b.pending_mode as NetworkMode) : mode
  const notes: string[] = []
  for (const w of warnings as Notice[]) {
    const line = said(w, WARNING)
    if (line) notes.push(line)
  }
  // Why a home-network Prometheus is not announcing itself. In the other modes the line under the switch already says it.
  if (mode === 'home_network' && !b.advertising && reason) notes.push(said(reason, ADVERTISING) as string)
  const canChange = b.can_change as boolean
  return {
    kind: 'shown',
    view: {
      on: saved === 'home_network',
      canChange,
      why: canChange ? null : pinnedWhy(b.bind_source as string),
      line: restartNeeded ? RESTART_LINE : LINE[mode],
      notes,
      restartNeeded
    }
  }
}

/** The body of PUT /api/network for the switch: on is home_network, off is this_mac, and "open" is never sent. */
export function putBody(on: boolean): Record<string, string> {
  return { mode: on ? 'home_network' : 'this_mac' }
}

export const PUT_FAILED = "Beacon couldn't change this setting."
export type PutOutcome = { kind: 'saved'; restartNeeded: boolean } | { kind: 'refused'; message: string; detail: string }
/** What the switch gets back: the setting read again after a save, or the refusal. */
export type SetOutcome = NetworkRead | { kind: 'refused'; message: string; detail: string }
/** PUT /api/network's answer. A 200 is saved (what it means is read back with GET); every refusal #700 has is said in Beacon's words. */
export function readPut(status: number, body: unknown): PutOutcome {
  if (status === 200) return { kind: 'saved', restartNeeded: isObj(body) && body.applied === 'on_restart' }
  const error = isObj(body) && typeof body.error === 'string' ? body.error : ''
  const detail = `HTTP ${status}${body === null || body === undefined ? '' : ` ${JSON.stringify(body).slice(0, 400)}`}`
  const refuse = (message: string): PutOutcome => ({ kind: 'refused', message, detail })
  if (status === 409 && error === 'tls_unavailable') return refuse('Prometheus needs an update before it can share safely on your network.')
  if (status === 409 && error === 'would_lock_out') return refuse('Turn this off from the Mac running Prometheus: doing it from here would disconnect this computer.')
  if (status === 409 && error === 'no_config_file') return refuse("Prometheus wasn't started from a settings file, so this can't be saved here.")
  if (status === 409 && error === 'bind_overridden') {
    const source = isObj(body) && typeof body.source === 'string' ? body.source : ''
    return refuse(pinnedWhy(source))
  }
  if (status === 500 && error === 'persist_failed') return refuse("Prometheus couldn't save this. Nothing changed.")
  return refuse(PUT_FAILED)
}

/** POST /api/restart's answer (Prometheus #724, recorded): 202 is restarting. A Prometheus without the route answers 405 (recorded:
 *  its page catch-all owns the path) or 404, and #724's 503 restart_unavailable is a process that was not started as the daemon:
 *  all three are "restart it yourself". Anything else (401, 403, 400 browser_not_allowed) is a failure, said as one. */
export type RestartAsk = 'restarting' | 'unavailable' | 'failed'
export function readRestart(status: number, body: unknown): RestartAsk {
  if (status === 202 && isObj(body) && body.restarting === true) return 'restarting'
  if (status === 404 || status === 405) return 'unavailable'
  if (status === 503 && isObj(body) && body.error === 'restart_unavailable') return 'unavailable'
  return 'failed'
}

export type RestartOutcome = { kind: 'back'; read: NetworkRead } | { kind: 'unavailable' } | { kind: 'not-back' } | { kind: 'someone-else' } | { kind: 'failed' }
/** What the section says after [Restart now], for every outcome but "back" (which shows the setting read again). */
export const RESTART_COPY: Record<Exclude<RestartOutcome['kind'], 'back'>, string> = {
  unavailable: "This Prometheus can't be restarted from Beacon. Restart it on the Mac it runs on to finish.",
  'not-back': "Prometheus didn't come back.",
  'someone-else': "Something else answered at Prometheus's address after the restart, so Beacon isn't using it.",
  failed: "Beacon couldn't restart Prometheus."
}
export const RESTARTING = 'Restarting Prometheus…'
export const READ_FAILED = "Beacon couldn't read this setting from Prometheus."
