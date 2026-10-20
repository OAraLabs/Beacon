// The v0.4.0 first-run flow as a pure state machine (docs/ONBOARDING-v0.4.0.md, §3 and §4).
//
// Screen ids are the spec's: W1 Welcome, W2 "Do you already have Prometheus?", C1 the tour, A1 the first
// screen of "set it up on this Mac", A-confirm its one confirmation, A-inst setting it up, A2 "how should your assistant think?", and path B: B1 "let Beacon look on your network", B2 looking, B3
// choose, B-empty nothing found, B-adv connect by address, B-differs "this looks different from last
// time", B4 waiting for approval, B-nojoin "this one can't approve a new device", B-ok "you're connected". The renderer draws each one; this file decides which comes next, what
// Back does, and where a launch starts, so a headless smoke can walk every path without a window
// (smoke:onboarding).
//
// The machine holds what the screens need to decide with: the computers a search has found, which one is
// selected, and what the quiet search from Welcome found on this Mac. It never starts a search itself:
// the renderer does, and feeds each update in as an event.
//
// No Node/Electron imports (same rule as shared/setup-wizard.ts).
import { differsFromKnown, type DiscoveredComputer, type LanState } from './discovery'
import type { MacVerdict } from './mac-check'
import { ONBOARDING_V4_LIVE } from './onboarding-gate'

export const SCREENS = ['W1', 'W2', 'C1', 'UNCONNECTED', 'A1', 'A-confirm', 'A-inst', 'A2', 'A3c-1', 'A3c-or', 'A3c-2', 'A5', 'B1', 'B2', 'B3', 'B-empty', 'B-adv', 'B-differs', 'B4', 'B-nojoin', 'B-ok', 'F1'] as const
export type ScreenId = (typeof SCREENS)[number]

/** Screens the machine routes to that have no real screen yet. The renderer draws a stand-in (with a
 *  way back, and a way into the old setup) for exactly these. Each later PR deletes its own entry.
 *  smoke:onboarding refuses ONBOARDING_V4_LIVE while this is not empty, and refuses an entry that no
 *  path reaches, so the list cannot go stale in either direction. */
export const PENDING_SCREENS: readonly ScreenId[] = []

/** Screens a dev build can skip from to the first message, by firing `connected`: setting it up on this Mac, so a probe can reach F1
 *  against a stub that is not a Prometheus.app (the hello probe). EMPTY once onboarding is live: a release build has no way round
 *  setting it up. The real ways on are `installed` (A-inst) and `approved` (B4). */
export const CONNECTS_FROM: readonly ScreenId[] = ONBOARDING_V4_LIVE ? [] : ['A-inst']

/** The answers on W2. "another" and "address" are offered only once a Prometheus has answered on this Mac (whereChoices): then
 *  "existing" means that one, and these are the ways to another computer (0.4.2). */
export type Where = 'new' | 'existing' | 'another' | 'address' | 'looking'

/** What W2 offers, in order: the three answers; or, with a Prometheus found on this Mac, connecting to it first, then another computer
 *  (a fresh network search) and an address, before setting it up here and just looking. */
export function whereChoices(found: readonly DiscoveredComputer[]): readonly Where[] {
  return found.length > 0 ? ['existing', 'another', 'address', 'new', 'looking'] : ['new', 'existing', 'looking']
}

/** What W2 recommends: set it up on this Mac, unless a Prometheus has already answered on this Mac. */
export function recommendedWhere(found: readonly DiscoveredComputer[]): Where {
  return found.length > 0 ? 'existing' : 'new'
}

export interface OnboardingContext {
  /** This platform asks for Local Network permission, and Beacon has not yet explained why (B1). */
  explainLan: boolean
  /** Computers this Mac connected to before: name → fingerprint (S1). */
  known: Readonly<Record<string, string>>
}

export interface OnboardingState {
  screen: ScreenId
  /** W2's selection; null until the person chooses, so W2 follows the recommendation until then. */
  where: Where | null
  /** Screens to go Back to, oldest first. */
  history: readonly ScreenId[]
  /** What the quiet search from Welcome found on this Mac. */
  found: readonly DiscoveredComputer[]
  explainLan: boolean
  known: Readonly<Record<string, string>>
  /** Path B: what the current search has found, and which of it is selected. */
  computers: readonly DiscoveredComputer[]
  /** Computers the search found that need an update to be joined (DiscoveredComputer.needsUpdate), by name: never rows, but the
   *  "couldn't find" screen names them. */
  outdated: readonly string[]
  selected: string | null
  lan: LanState
  /** Counts the searches path B has started, so the renderer starts a new one when it changes. */
  searchGen: number
  /** Path A: what the check of this Mac found, once it has (null while it is being made). */
  mac: MacVerdict | null
  /** F1 has had its first reply: the flow is finished and there is nothing to go back to. */
  done: boolean
  /** B3 is showing a computer someone typed, not a search's results: no search runs for it and none may
   *  overwrite it. Found by the real-app probe: the search that B3 would have started replaced the typed
   *  row with an empty list. */
  typed: boolean
  /** A3c-2: whose key is being pasted. */
  company: 'anthropic' | 'openai' | null
}

/** Which search the renderer should be running on a screen: the quiet one (this Mac only) while Welcome and
 *  the question are showing, the full one while B2 and B3 are, and none while B1 is still explaining why
 *  Beacon wants to look, or anywhere else. */
export function searchModeFor(s: Pick<OnboardingState, 'screen' | 'typed'>): 'quiet' | 'full' | null {
  if (s.screen === 'W1' || s.screen === 'W2') return 'quiet'
  if (s.screen === 'B2' || (s.screen === 'B3' && !s.typed)) return 'full'
  return null
}

export type OnboardingEvent =
  | { type: 'start' } // W1 → W2
  | { type: 'choose'; where: Where } // W2: select an answer (does not move)
  | { type: 'continue' } // W2 → the screen for the selected answer; B3 → B4 or the card that says it cannot approve (or the S1 warning); B-ok → F1
  | { type: 'back' }
  | { type: 'setItUp' } // C1 or the empty home → W2
  | { type: 'notNow' } // C1 → the empty home
  | { type: 'quiet'; computers: readonly DiscoveredComputer[] } // the quiet search's answer, on Welcome or W2
  | { type: 'lanExplained' } // B1 → B2
  | { type: 'results'; computers: readonly DiscoveredComputer[]; lan: LanState; done: boolean } // the search's update
  | { type: 'select'; id: string } // B3: pick a computer
  | { type: 'lookAgain' } // B3 or B-empty → B2
  | { type: 'notSeeing' } // B3 → B-empty ("Don't see it?")
  | { type: 'toAddress' } // B3 or B-empty → B-adv
  | { type: 'typed'; computer: DiscoveredComputer } // B-adv found a Prometheus at the typed address
  | { type: 'setItUpHere' } // B-empty → set it up on this Mac
  | { type: 'proceed' } // B-differs → on, despite the warning
  | { type: 'macChecked'; verdict: MacVerdict } // A1: the check of this Mac is done
  | { type: 'recheck' } // A1: "check again"
  | { type: 'confirmSetup' } // A-confirm → set it up (A-inst)
  | { type: 'connectElsewhere' } // A1: this Mac can't run it → look for a Prometheus elsewhere (path B)
  | { type: 'useRunningHere' } // A1: a Prometheus is already here → the list, with This Mac selected
  | { type: 'approved' } // B4: the computer said yes and this Mac is connected → B-ok
  | { type: 'installed'; daemon: 'setup' | 'configured' } // A-inst: Prometheus is in place here and connected → A2 (to set up) or F1 (set up before)
  | { type: 'connected' } // a dev build's skip to the first message (CONNECTS_FROM)
  | { type: 'helloDone' } // F1 got its first reply: nothing to go back to
  // O9 (docs/ONBOARDING-v0.4.0-O9.md §3). A2's Continue is a cloud AI, the only choice in O9 (`continue`, above).
  | { type: 'otherKey'; company: 'anthropic' | 'openai' } // A3c-1 → paste a key from that company (A3c-2)
  | { type: 'signedIn' } // A3c-or: signed in with OpenRouter and the key checked → finishing (A5)
  | { type: 'keyAccepted' } // A3c-2: the pasted key checked → finishing (A5)
  | { type: 'setUp' } // A5: configured, started, and this Mac is its owner → F1

export type OnboardingEntry = 'legacy' | 'welcome' | 'unconnected' | 'resumeModel' | 'resumeTrade'

/** Where a launch starts.
 *  - 'legacy': the existing wizard. The gate is closed, or a setup is part-way (a saved connection
 *    whose Prometheus is still in setup mode): resuming belongs to the new flow's later PRs, and the
 *    existing wizard already does it.
 *  - 'resumeModel': a setup part-way on THIS Mac (Prometheus installed by the new flow, still in setup mode, its setup credential
 *    kept): the new flow resumes at A2, "How should your assistant think?" (O9).
 *  - 'resumeTrade': Prometheus on this Mac is configured but Beacon still holds its master token (a relaunch during A5's owner
 *    trade): the new flow reopens A5 to finish the trade, gate or no gate.
 *  - 'unconnected': this person chose "Not now" and has not set up since.
 *  - 'welcome': everyone else on a first run. */
export function onboardingEntry(input: { visible: boolean; resume: boolean; browsing: boolean; resumeHere?: boolean; resumeTrade?: boolean }): OnboardingEntry {
  // The owner trade is owed (@shared/model-setup resumeAtTrade): only the new flow can finish it, so the gate does not decide.
  if (input.resumeTrade) return 'resumeTrade'
  if (!input.visible) return 'legacy'
  if (input.resume) return input.resumeHere ? 'resumeModel' : 'legacy'
  return input.browsing ? 'unconnected' : 'welcome'
}

export const NO_CONTEXT: OnboardingContext = { explainLan: false, known: {} }

export function initialOnboardingState(entry: Exclude<OnboardingEntry, 'legacy'>, ctx: OnboardingContext = NO_CONTEXT): OnboardingState {
  const resuming = entry === 'resumeModel'
  const trading = entry === 'resumeTrade'
  return {
    // Resuming on this Mac: as if setting it up had just finished (`installed`), so Back is the question. A trade still owed
    // reopens "Finishing setup", which has no Back.
    screen: entry === 'unconnected' ? 'UNCONNECTED' : resuming ? 'A2' : trading ? 'A5' : 'W1',
    where: resuming || trading ? 'new' : null,
    history: resuming ? ['W1', 'W2'] : [],
    found: [],
    explainLan: ctx.explainLan,
    known: ctx.known,
    computers: [],
    outdated: [],
    selected: null,
    lan: 'off',
    searchGen: 0,
    done: false,
    typed: false,
    mac: null,
    company: null
  }
}

/** W2's selection, with the recommendation standing in until the person chooses. */
export function effectiveWhere(s: Pick<OnboardingState, 'where' | 'found'>): Where {
  // A choice that is no longer offered (the Prometheus found here stopped answering) falls back to the recommendation.
  return s.where !== null && whereChoices(s.found).includes(s.where) ? s.where : recommendedWhere(s.found)
}

/** The selected computer on B3, if it is still in the list. */
export function selectedComputer(s: Pick<OnboardingState, 'computers' | 'selected'>): DiscoveredComputer | null {
  return s.computers.find((c) => c.id === s.selected) ?? null
}

/** Go forward to a screen. The Back stack never holds a screen twice: arriving at one that is already behind us is
 *  going back to it, so the stack is cut to where it stood then. Without that, a lap round a loop (A1 → connect
 *  elsewhere → B-empty → "set it up on this Mac instead" → A1 …) adds to the stack on every circuit. The walk in
 *  smoke:onboarding found that lap, and now asserts the invariant. */
/** Where Connect leads for a computer: the wait for approval when it offers approval, else the card that says it cannot. */
export function joinScreenFor(c: Pick<DiscoveredComputer, 'pair'>): 'B4' | 'B-nojoin' {
  return c.pair === 'approve' ? 'B4' : 'B-nojoin'
}

function push(s: OnboardingState, to: ScreenId): OnboardingState {
  const history = [...s.history, s.screen]
  const seen = history.indexOf(to)
  return { ...s, screen: to, history: seen >= 0 ? history.slice(0, seen) : history }
}

/** Move without adding to the history: B2 gives way to B3 or B-empty, and "look again" goes back to B2,
 *  so Back from any of them is still W2. */
function swap(s: OnboardingState, to: ScreenId): OnboardingState {
  // Same rule as push: a screen already behind us is not behind us twice.
  const seen = s.history.indexOf(to)
  return { ...s, screen: to, history: seen >= 0 ? s.history.slice(0, seen) : s.history }
}

/** The start of a path B search: nothing found yet, nothing selected, and a new generation. */
function freshSearch(s: OnboardingState): Pick<OnboardingState, 'computers' | 'outdated' | 'selected' | 'lan' | 'searchGen' | 'typed'> {
  return { computers: [], outdated: [], selected: null, lan: 'off', searchGen: s.searchGen + 1, typed: false }
}

/** One computer is selected for you; with several, nothing is until the person chooses. */
function keepSelection(computers: readonly DiscoveredComputer[], selected: string | null): string | null {
  if (selected !== null && computers.some((c) => c.id === selected)) return selected
  return computers.length === 1 ? computers[0].id : null
}

export function onboardingReduce(s: OnboardingState, e: OnboardingEvent): OnboardingState {
  switch (e.type) {
    case 'start':
      return s.screen === 'W1' ? push(s, 'W2') : s
    case 'choose':
      return s.screen === 'W2' && whereChoices(s.found).includes(e.where) ? { ...s, where: e.where } : s
    case 'continue': {
      if (s.screen === 'W2') {
        const where = effectiveWhere(s)
        if (where === 'new') return { ...push(s, 'A1'), mac: null }
        if (where === 'looking') return push(s, 'C1')
        if (where === 'address') return push(s, 'B-adv')
        // "Connect to it" with one found on this Mac is that one: its row, selected, and no search (a search is a network scan
        // that may raise the macOS prompt, for a computer that is not on the network). Like useRunningHere.
        if (where === 'existing' && s.found.length > 0) return { ...push(s, 'B3'), computers: s.found, selected: keepSelection(s.found, null), lan: 'off', typed: true }
        return { ...push(s, s.explainLan ? 'B1' : 'B2'), ...freshSearch(s) }
      }
      if (s.screen === 'B3') {
        const c = selectedComputer(s)
        if (!c) return s
        return push(s, differsFromKnown(s.known, c) ? 'B-differs' : joinScreenFor(c))
      }
      if (s.screen === 'B-ok') return push(s, 'F1')
      if (s.screen === 'A2') return push(s, 'A3c-1')
      if (s.screen === 'A3c-1') return push(s, 'A3c-or')
      return s
    }
    case 'back': {
      if (s.history.length === 0) return s
      const to = s.history[s.history.length - 1]
      return { ...s, screen: to, history: s.history.slice(0, -1) }
    }
    case 'setItUp':
      // From the tour or the empty home, straight to the question, with Welcome behind it. Pushing
      // would leave the tour in the history and make Back loop between the two.
      return s.screen === 'C1' || s.screen === 'UNCONNECTED' ? { ...s, screen: 'W2', history: ['W1'] } : s
    case 'notNow':
      // The empty home is where onboarding ends: nothing to go back to.
      return s.screen === 'C1' ? { ...s, screen: 'UNCONNECTED', history: [] } : s
    case 'quiet':
      return s.screen === 'W1' || s.screen === 'W2' ? { ...s, found: e.computers.filter((c) => c.where === 'this-mac') } : s
    case 'lanExplained':
      return s.screen === 'B1' ? { ...swap(s, 'B2'), explainLan: false } : s
    case 'results': {
      // A computer that needs an update cannot be joined: it is never a row, and a search that found only those says so.
      const joinable = e.computers.filter((c) => !c.needsUpdate)
      const outdated = e.computers.filter((c) => c.needsUpdate).map((c) => c.name)
      if (s.screen === 'B2') {
        if (joinable.length > 0) return { ...swap(s, 'B3'), computers: joinable, outdated, selected: keepSelection(joinable, null), lan: e.lan }
        if (e.done) return { ...swap(s, 'B-empty'), lan: e.lan, outdated }
        return { ...s, lan: e.lan, outdated }
      }
      if (s.screen === 'B3') return s.typed ? s : { ...s, computers: joinable, outdated, selected: keepSelection(joinable, s.selected), lan: e.lan }
      return s
    }
    case 'select':
      return s.screen === 'B3' && s.computers.some((c) => c.id === e.id) ? { ...s, selected: e.id } : s
    case 'lookAgain':
      // A search is a network scan: where B1 has not yet explained the permission it asks for, it comes first.
      return s.screen === 'B3' || s.screen === 'B-empty' ? { ...swap(s, s.explainLan ? 'B1' : 'B2'), ...freshSearch(s) } : s
    case 'notSeeing':
      return s.screen === 'B3' ? swap(s, 'B-empty') : s
    case 'toAddress':
      return s.screen === 'B3' || s.screen === 'B-empty' ? push(s, 'B-adv') : s
    case 'typed': {
      if (s.screen !== 'B-adv') return s
      // The typed row is a list like any other, so Back from it is the question. The history is cut back to
      // that, not just swapped: B-adv was pushed from B-empty or B3, and leaving those in the stack would
      // grow it on every lap (B-empty → address → typed → don't see it? → B-empty → …). The walk in
      // smoke:onboarding found that lap.
      const w2 = s.history.lastIndexOf('W2')
      return { ...swap(s, 'B3'), history: w2 >= 0 ? s.history.slice(0, w2 + 1) : s.history, computers: [e.computer], selected: e.computer.id, lan: 'off', typed: true }
    }
    case 'setItUpHere':
      return s.screen === 'B-empty' ? { ...push(s, 'A1'), where: 'new', mac: null } : s
    case 'proceed': {
      const c = selectedComputer(s)
      return s.screen === 'B-differs' && c ? swap(s, joinScreenFor(c)) : s
    }
    case 'macChecked':
      if (s.screen !== 'A1') return s
      // A Mac that can run it goes straight on to the one confirmation; anything else stays here, as a card.
      return e.verdict.kind === 'ok' ? { ...swap(s, 'A-confirm'), mac: e.verdict } : { ...s, mac: e.verdict }
    case 'recheck':
      return s.screen === 'A1' && s.mac !== null ? { ...s, mac: null } : s
    case 'confirmSetup':
      // Back from setting it up is the question, as it is from the confirmation (the confirmation is a step, not a place to return to).
      return s.screen === 'A-confirm' ? swap(s, 'A-inst') : s
    case 'installed': {
      if (s.screen !== 'A-inst') return s
      // The app is in place and the connection kept: Back from here is the question, never the screens that got it here.
      const w2 = s.history.lastIndexOf('W2')
      return { ...s, screen: e.daemon === 'setup' ? 'A2' : 'F1', history: w2 >= 0 ? s.history.slice(0, w2 + 1) : s.history }
    }
    case 'connectElsewhere':
      // Looking elsewhere is path B: the question's answer becomes "connect to it", explained first where macOS asks.
      return s.screen === 'A1' ? { ...push(s, s.explainLan ? 'B1' : 'B2'), ...freshSearch(s), where: 'existing' } : s
    case 'useRunningHere': {
      if (s.screen !== 'A1' || s.mac?.kind !== 'running') return s
      // The computer is already known: the list is that one row, selected, and no search runs for it (a search is a
      // network scan that may raise the macOS prompt before B1 has explained it).
      const c = s.mac.computer
      return { ...push(s, 'B3'), where: 'existing', computers: [c], selected: c.id, lan: 'off', typed: true }
    }
    case 'approved':
      // The request is spent and the connection kept: there is nothing to go back to.
      return s.screen === 'B4' ? { ...s, screen: 'B-ok', history: [] } : s
    case 'connected':
      return CONNECTS_FROM.includes(s.screen) ? push(s, 'F1') : s
    case 'helloDone':
      return s.screen === 'F1' ? { ...s, history: [], done: true } : s
    case 'otherKey':
      return s.screen === 'A3c-1' ? { ...push(s, 'A3c-2'), company: e.company } : s
    case 'signedIn':
    case 'keyAccepted':
      // Finishing runs with nothing behind it: the choice is being saved, and once it is the setup credential is traded away.
      return (e.type === 'signedIn' && s.screen === 'A3c-or') || (e.type === 'keyAccepted' && s.screen === 'A3c-2') ? { ...s, screen: 'A5', history: [] } : s
    case 'setUp':
      // Configured, started, and the owner credential kept: the master token is gone, and there is nothing to go back to.
      return s.screen === 'A5' ? { ...s, screen: 'F1', history: [] } : s
  }
}

export function canGoBack(s: OnboardingState): boolean {
  return s.history.length > 0
}

/** b.settings key: "Not now" was chosen. Set on the way into the empty home, cleared on the way out
 *  and by Set up again, so a person who said "just looking" is not greeted with Welcome on every
 *  launch, and one who later sets up again is. */
export const ONBOARDING_BROWSING_KEY = 'onboarding:browsing'

/** b.settings key: B1 has explained the Local Network permission and the person chose Continue, so it is
 *  not explained again. macOS offers no way to ask whether permission was granted; a refusal is reported
 *  by the search itself (LanState 'denied'). */
export const ONBOARDING_LAN_ASKED_KEY = 'onboarding:lan-asked'

/** b.settings key: computers this Mac has connected to, as JSON `{ name: fingerprint }` (S1). Written when
 *  a connection is made (a later PR); read here to flag a computer whose fingerprint has changed. */
export const ONBOARDING_KNOWN_KEY = 'onboarding:known-computers'

export function parseBrowsing(raw: string | null | undefined): boolean {
  return raw === '1'
}

/** The known-computers map, or {} for anything that is not a map of strings. */
export function parseKnown(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {}
  try {
    const v = JSON.parse(raw) as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    const out: Record<string, string> = {}
    for (const [k, x] of Object.entries(v)) if (typeof x === 'string') out[k] = x
    return out
  } catch {
    return {}
  }
}
