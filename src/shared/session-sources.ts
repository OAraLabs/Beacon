/**
 * Session source labelling + conversational/automated classification.
 *
 * The sidebar's source chips were auto-derived as "first two letters,
 * uppercased" for anything not in a small hand-map. On the live box that
 * produced VE / RE / TH / ME — four visually-colliding chips that turned out
 * to be one-off `verify:`, `restore-verify:`, `thinking-verify:` and
 * `merge-verify:` test sessions. Unreadable, and worse, they sat beside real
 * conversations with equal weight.
 *
 * Two jobs here:
 *   1. Give every known source a readable name.
 *   2. Separate CONVERSATIONS from MACHINE RUNS. `bakeoff:` alone was 69 of
 *      127 sessions — a genuine audit trail of benchmark runs (real ids like
 *      `bakeoff:t01_rename_private_helper:r1:1781187048`, real transcripts),
 *      but not something you scroll past to find yesterday's chat. Automated
 *      sources are folded behind ONE chip rather than hidden: the trail stays
 *      reachable, it just stops competing for attention.
 */

/** Readable names for sources we know. Anything else falls back to a
 *  title-cased version of the raw prefix — still far better than 2 letters. */
const SOURCE_LABELS: Record<string, string> = {
  beacon: 'Beacon',
  desktop: 'Desktop',
  telegram: 'Telegram',
  slack: 'Slack',
  discord: 'Discord',
  voice: 'Voice',
  web: 'Web',
  paperclip: 'Paperclip',
  coding: 'Coding',
  bakeoff: 'Bakeoff',
  unknown: 'Unlabelled'
}

/**
 * Sources that are machine-generated runs rather than conversations.
 *
 * `bakeoff` is the benchmark harness. The `*-verify` family (plus bare
 * `verify`) are throwaway sessions minted by past verification scripts —
 * typically 2 messages each. `eval` covers the eval harness.
 *
 * Matched by exact name or `-verify` suffix so future one-offs
 * (`foo-verify:`) classify correctly without a code change.
 */
// Mirrors the daemon's reserved machine namespace (Prometheus memory/session_kind.py:
// bakeoff: coding: eval: gym: smoke:). The two lists must agree — a session the daemon treats as
// disposable and Beacon files under a live gateway is one the user sees but retention deletes.
// `verify` and the -verify/-eval suffixes are Beacon's own additions for older hand-run families.
const AUTOMATED_EXACT = new Set(['bakeoff', 'coding', 'eval', 'gym', 'smoke', 'verify'])

export function isAutomatedSource(source: string): boolean {
  const s = source.toLowerCase()
  return AUTOMATED_EXACT.has(s) || s.endsWith('-verify') || s.endsWith('-eval')
}

/**
 * HARNESS DEBRIS — classified by the ID's SHAPE, not by its gateway.
 *
 * 46 of 173 live sessions carried hand-typed ids: `walk-narrow`, `floor-live-1`,
 * `telemetry-probe-2`, `expiry-probe-1`, `fmv-tilde-check`. They are scripted
 * probes, and they were interleaved with real conversations at equal weight.
 *
 * WHY NOT FILTER ON "Unlabelled". That chip means `gateway === 'unknown'`, which
 * means only "no colon in the id" — a property of how the id was MINTED, not of
 * whether the session is useful. It sweeps in 18 sessions whose ids are bare
 * UUIDs: a program generated those, plausibly a real API client that simply did
 * not declare an origin. Collapsing them would hide something we cannot show is
 * noise.
 *
 * WHY NOT MESSAGE COUNT. Checked against the live box and it does not separate
 * them: debris runs 1→10+ messages (`walk-wide` has 9, `expiry-probe-1` has 8)
 * and real desktop sessions include a 1-message one. Any threshold misclassifies
 * in both directions.
 *
 * THE SIGNAL IS STRUCTURAL, not statistical. Every shipped surface PREFIXES its
 * ids: Beacon declares its own gateway and receives `beacon:<uuid>` (its setup
 * smoke test declares `beacon-verify:<uuid>`); Telegram mints
 * `telegram:<chat_id>`; voice `voice:…`; the bakeoff harness `bakeoff:…`. A bare
 * literal can therefore only arise from a caller passing a hand-written string
 * straight to /api/chat/send — i.e. a script, by construction rather than by
 * heuristic.
 *
 * KNOWN RESIDUAL: a hand-written id that DOES carry a colon and names a novel
 * gateway (`foo:smoke`) mints a new, default-visible `Foo` chip. This check only
 * catches bare literals. Small, real, and deliberately not closed here.
 *
 * That claim is load-bearing, so it is PINNED: session-sources-smoke asserts
 * that no shipped surface's id shape classifies as harness, and fails loudly if
 * one ever does.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isHarnessId(sessionId: string): boolean {
  const id = (sessionId || '').trim()
  if (!id) return false // no id at all is not a claim about the id's shape
  if (id.includes(':')) return false // every shipped surface prefixes
  return !UUID_RE.test(id) // a bare UUID is a program's, not a person's
}

/** A session as the classifier needs to see it: the ID decides harness, the gateway decides the rest. */
export interface ClassifiableSession {
  id: string
  gateway?: string
}

/**
 * The ONE chip a session belongs to. Every visibility and filter decision routes
 * through this, so a session cannot be counted under one chip and filtered by
 * another — the drift that a separate count-map and filter-predicate invited.
 */
export function chipKeyFor(s: ClassifiableSession): string {
  const gw = (s.gateway || 'unknown').toLowerCase()
  // Gateway wins over id shape: `bakeoff:t01_…` is automated, not harness, even
  // though both are machine runs. Two chips, and a row belongs to exactly one.
  if (isAutomatedSource(gw)) return AUTOMATED_KEY
  if (isHarnessId(s.id)) return HARNESS_KEY
  return gw
}

/**
 * The raw gateway prefix of a session id (`telegram:123` → `telegram`). main derives the same thing
 * in presence.ts for notification titles; this is the renderer-side pure twin, so a surface that
 * only ever holds an id (a search hit carries no session row) can still name its source.
 */
export function sourceOfSessionId(sessionId: string): string {
  const i = sessionId.indexOf(':')
  return i > 0 ? sessionId.slice(0, i) : 'unknown'
}

/** Human-readable name for a raw gateway prefix. */
export function sourceLabel(source: string): string {
  const s = (source || 'unknown').toLowerCase()
  if (SOURCE_LABELS[s]) return SOURCE_LABELS[s]
  // `restore-verify` → `Restore Verify`; keeps unknown sources legible
  // instead of collapsing them to an ambiguous two-letter pair.
  return s
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

export interface SourceChip {
  /** Raw gateway value, or the synthetic '__automated__' bucket. */
  key: string
  label: string
  count: number
  automated: boolean
  /** Raw sources this chip selects (one, or all automated ones). */
  sources: string[]
}

export const AUTOMATED_KEY = '__automated__'
export const HARNESS_KEY = '__harness__'

/**
 * Build the chip row: conversational sources first (busiest first), then the two
 * machine chips — Automated, then Harness.
 *
 * TWO CHIPS, NOT ONE. Folding harness debris into Automated would make that chip
 * a bag of "not a conversation", and the two are separately interesting: bakeoff
 * runs are a benchmark audit trail, harness rows are this week's scripted
 * probes. You want to find one without the other.
 *
 * Takes SESSIONS, not a gateway→count map: harness is decided by the id, which a
 * count map has already thrown away.
 */
export function buildSourceChips(sessions: ClassifiableSession[]): SourceChip[] {
  const counts = new Map<string, number>()
  const rawSources = new Map<string, Set<string>>()
  for (const s of sessions) {
    const key = chipKeyFor(s)
    counts.set(key, (counts.get(key) ?? 0) + 1)
    const raw = (s.gateway || 'unknown').toLowerCase()
    if (!rawSources.has(key)) rawSources.set(key, new Set())
    rawSources.get(key)!.add(raw)
  }

  const convo: SourceChip[] = []
  const machine: SourceChip[] = []
  for (const [key, count] of counts) {
    const sources = [...(rawSources.get(key) ?? [])].sort()
    if (key === AUTOMATED_KEY) {
      machine.push({ key, label: 'Automated', count, automated: true, sources })
    } else if (key === HARNESS_KEY) {
      machine.push({ key, label: 'Harness', count, automated: true, sources })
    } else {
      convo.push({ key, label: sourceLabel(key), count, automated: false, sources: [key] })
    }
  }

  convo.sort((a, z) => z.count - a.count || a.label.localeCompare(z.label))
  machine.sort((a, z) => a.label.localeCompare(z.label)) // Automated, then Harness
  return [...convo, ...machine]
}

/** Does this session belong to the chip identified by `key`? */
export function matchesChip(key: string, session: ClassifiableSession): boolean {
  return chipKeyFor(session) === key
}

/**
 * Sessions shown when no chip is selected.
 *
 * Automated runs are excluded outright — 69 bakeoff rows buried every real
 * conversation, and they are one click away via their chip.
 *
 * HARNESS ROWS ARE NOT EXCLUDED. They stay in the default view and are collected
 * into a single collapsed group instead (see session-groups). Hiding them would
 * make 46 rows vanish with no explanation on first launch; a collapsed group
 * carrying its own count says what it is holding and opens in one click. Hide,
 * never delete — and preferably, do not hide silently either.
 */
export function isDefaultVisible(session: ClassifiableSession): boolean {
  return chipKeyFor(session) !== AUTOMATED_KEY
}

// ── `desktop` is a DEFAULT, not a surface ────────────────────────────────────

/**
 * The gateway the daemon stamps on a caller that did not declare one.
 *
 * `POST /api/sessions` defaults to `desktop`, so the label meant nothing more
 * than "created via that endpoint". Beacon's own `createSession` sent no body at
 * all and a probe script sent none either — indistinguishable by construction,
 * because the chip was labelled for a human and populated by everything.
 *
 * The live box: 30 `desktop` rows, of which 17 were agent-driven and 13 real. In
 * Today+Yesterday — the part of the list you actually read — it was 15 debris to
 * 1 real conversation.
 *
 * THE FIX IS THE CATEGORY, NOT THE INSTANCES. Beacon now declares `beacon`, so a
 * human typing into Beacon is distinguishable from anything that merely used the
 * API, and `desktop` becomes what it always was: the undeclared default. It is
 * still a conversational chip and still default-VISIBLE — the sidebar collects it
 * into one collapsed group carrying its count (see session-groups), the same
 * treatment Harness gets. Nothing is hidden and nothing is deleted.
 *
 * WHY NOT A PER-ID HIDDEN FLAG. That needs a list of 17 ids, a backfill, a place
 * to store it and a human to maintain it — and it needs doing again every time a
 * script forgets to declare. This keeps working for every future undeclared
 * caller with no list at all.
 *
 * WHY NOT RE-STAMP THE 30. Ids are immutable and `gateway` is parsed from the id
 * prefix, so the existing rows stay `desktop` permanently. That is the point:
 * no backfill, no rewrite, no migration.
 */
export const UNDECLARED_GATEWAY = 'desktop'

/**
 * What Beacon declares when it mints a session — a human typing into this app.
 * Conversational, its own chip, default-visible.
 */
export const BEACON_GATEWAY = 'beacon'

/**
 * What Beacon's FIRST-RUN SMOKE TEST declares.
 *
 * `SetupWizard.runSmoke()` mints a session, sends "this is the setup smoke test",
 * polls for the reply and never cleans up — a shipped surface manufacturing
 * exactly the debris this change clears. It gets a `-verify` gateway, which the
 * existing suffix rule in `isAutomatedSource` already folds into the Automated
 * chip. No new chip, no new rule.
 */
export const BEACON_SMOKE_GATEWAY = 'beacon-verify'

/** Was this session minted by an API caller that never named itself? */
export function isUndeclaredApiSession(session: ClassifiableSession): boolean {
  return (session.gateway || '').toLowerCase() === UNDECLARED_GATEWAY
}

/**
 * Toggle one source chip in a MULTI-SELECT filter.
 *
 * The filter used to be single-select — clicking Telegram replaced Voice rather than adding to it,
 * so "show me everything that is not Beacon" was three clicks and a memory test. Additive is what
 * the match spec asks for and what the count on the filter button means.
 *
 * Order is preserved on add (selection order, not chip order) so the set reads as a history of
 * what you chose. Never mutates.
 */
export function toggleSource(selected: readonly string[], key: string): string[] {
  return selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key]
}

/**
 * The sessions a multi-select filter shows.
 *
 * NOTHING selected is not "nothing matches" — it is the DEFAULT view (`isDefaultVisible`), which
 * hides automated runs. Treating an empty selection as an empty result would blank the panel the
 * moment the last chip was cleared, and clearing the last chip is how a person says "show me the
 * normal thing again".
 */
export function inSelectedSources<T extends ClassifiableSession>(sessions: readonly T[], selected: readonly string[]): T[] {
  if (selected.length === 0) return sessions.filter(isDefaultVisible)
  return sessions.filter((s) => selected.some((k) => matchesChip(k, s)))
}
