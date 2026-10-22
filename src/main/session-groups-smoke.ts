/**
 * session-groups-smoke — recency bucketing for the sidebar.
 *
 * The interesting cases are the calendar boundaries. An "hours since" rule
 * looks right in the afternoon and is wrong every night: at 00:20, something
 * from 23:50 is 30 minutes old but belongs under "Yesterday", not "Today".
 *
 * Run: npm run smoke:session-groups
 */
import {
  bucketOf,
  defaultCollapse,
  PINNED_BUCKET,
  DESKTOP_BUCKET,
  groupByRecency,
  groupSessions,
  HARNESS_BUCKET,
  parseCollapse,
  PSEUDO_BUCKETS,
  resolveCollapse,
  serializeCollapse,
  sidebarPseudoBuckets,
  type PseudoBucket
} from '@shared/session-groups'

let failures = 0
function check(cond: boolean, label: string): void {
  if (cond) console.log(`  ok   ${label}`)
  else {
    console.error(`  FAIL ${label}`)
    failures += 1
  }
}

const day = 86_400_000
// A fixed "now": 2026-07-30 00:20 local — deliberately just after midnight.
const now = new Date(2026, 6, 30, 0, 20, 0)
const startOfToday = new Date(2026, 6, 30, 0, 0, 0).getTime()

console.log('\n=== session recency buckets ===')

check(bucketOf(now.getTime(), now) === 'Today', 'right now → Today')
check(bucketOf(startOfToday, now) === 'Today', 'exactly midnight → Today (boundary is inclusive)')

// The case an elapsed-hours rule gets wrong.
const lastNight = startOfToday - 10 * 60_000 // 23:50 yesterday, 30 min ago
check(bucketOf(lastNight, now) === 'Yesterday', '30 minutes ago but before midnight → Yesterday')

check(bucketOf(startOfToday - day, now) === 'Yesterday', 'start of yesterday → Yesterday')
check(bucketOf(startOfToday - day - 1, now) === 'Earlier this week', 'just before that → Earlier this week')
check(bucketOf(startOfToday - 6 * day, now) === 'Earlier this week', '6 days back → Earlier this week')
check(bucketOf(startOfToday - 8 * day, now) === 'Older', '8 days back → Older')
check(bucketOf(undefined, now) === 'Older', 'missing lastActive → Older (never crashes)')

console.log('\n=== grouping ===')
const rows = [
  { id: 'a', lastActive: now.getTime() },
  { id: 'b', lastActive: startOfToday - 3 * day },
  { id: 'c', lastActive: lastNight },
  { id: 'd', lastActive: startOfToday - 40 * day },
  { id: 'e', lastActive: now.getTime() - 60_000 }
]
const groups = groupByRecency(rows, now)
check(
  groups.map((g) => g.bucket).join(' | ') === 'Today | Yesterday | Earlier this week | Older',
  'buckets come back in fixed order regardless of input order'
)
check(groups[0].rows.map((r) => r.id).join(',') === 'a,e', 'within a bucket, input order is preserved')
check(groups.every((g) => g.rows.length > 0), 'empty buckets are omitted')
check(
  groups.reduce((n, g) => n + g.rows.length, 0) === rows.length,
  'every row lands in exactly one bucket (nothing dropped or duplicated)'
)
check(groupByRecency([], now).length === 0, 'empty input → no groups')

// ── Harness: pulled OUT of recency, appended as one trailing group ───────────
console.log('\n=== harness grouping ===')
const mixed = [
  { id: 'desktop:a', lastActive: now.getTime() - 60_000 },
  { id: 'walk-narrow', lastActive: now.getTime() - 61_000 }, // dated TODAY — would interleave
  { id: 'desktop:b', lastActive: lastNight },
  { id: 'floor-live-1', lastActive: startOfToday - 3 * day }, // dated EARLIER — would interleave
  { id: 'probe-2', lastActive: now.getTime() - 62_000 }
]
type Row = { id: string; lastActive?: number; gateway?: string }
const harnessOnly: Array<PseudoBucket<Row>> = [
  { name: HARNESS_BUCKET, match: (r) => !r.id.includes(':') }
]
const g2 = groupSessions(mixed, harnessOnly, now)

check(g2[g2.length - 1].bucket === HARNESS_BUCKET, 'Harness is ALWAYS last — the group you scroll past')
check(g2[g2.length - 1].pseudo === true, 'the harness group is flagged so the UI can default it collapsed')
check(g2[g2.length - 1].rows.length === 3, 'all three probes collect into it regardless of their dates')
check(
  g2.filter((g) => !g.pseudo).every((g) => g.rows.every((r) => r.id.includes(':'))),
  'no harness row survives inside a recency bucket — that interleaving is the whole defect'
)
check(
  g2.reduce((n, g) => n + g.rows.length, 0) === mixed.length,
  'nothing is dropped: hide, never delete'
)
check(
  groupSessions(mixed, [{ name: HARNESS_BUCKET, match: () => false }], now).every((g) => !g.pseudo),
  'no harness rows → no Harness group at all (not an empty one)'
)
check(groupSessions([], harnessOnly, now).length === 0, 'empty input → no groups')

// ── A LIST of pseudo-buckets, not one hardcoded group ────────────────────────
//
// `desktop` turned out to be the daemon's default for any API caller that did
// not declare itself, so it needs the same treatment Harness got. One group was
// hardcoded; two means the mechanism has to be real.
console.log('\n=== multiple pseudo-buckets ===')
const twoAxes: Row[] = [
  { id: 'beacon:real-1', gateway: 'beacon', lastActive: now.getTime() - 60_000 },
  { id: 'desktop:probe-a', gateway: 'desktop', lastActive: now.getTime() - 61_000 }, // dated TODAY
  { id: 'walk-narrow', lastActive: now.getTime() - 62_000 }, // dated TODAY
  { id: 'telegram:8139235390', gateway: 'telegram', lastActive: lastNight },
  { id: 'desktop:s4-2332364.1786774889602', gateway: 'desktop', lastActive: startOfToday - 3 * day },
  { id: 'floor-live-1', lastActive: startOfToday - 40 * day }
]
const g3 = groupSessions(twoAxes, sidebarPseudoBuckets<Row>(), now)
const names = g3.map((g) => g.bucket)

check(
  names.slice(-2).join(' | ') === `${DESKTOP_BUCKET} | ${HARNESS_BUCKET}`,
  'both pseudo-buckets land last, in PSEUDO_BUCKETS order (Desktop above Harness)'
)
check(
  g3.find((g) => g.bucket === DESKTOP_BUCKET)?.rows.length === 2,
  'both desktop rows collect regardless of their dates — one Today, one Earlier'
)
check(
  g3.find((g) => g.bucket === HARNESS_BUCKET)?.rows.length === 2,
  'and the hand-typed ids collect separately'
)
check(
  g3.filter((g) => !g.pseudo).flatMap((g) => g.rows).map((r) => r.id).sort().join(',') ===
    'beacon:real-1,telegram:8139235390',
  'ONLY the real conversations remain on the recency axis — this is the whole point'
)
check(
  g3.reduce((n, g) => n + g.rows.length, 0) === twoAxes.length,
  'nothing dropped or duplicated across six rows and two pseudo-buckets'
)
check(
  g3.every((g) => g.rows.length > 0),
  'no empty groups rendered'
)
check(
  g3.filter((g) => g.pseudo).every((g) => typeof g.hint === 'string' && g.hint.length > 0),
  'each pseudo-bucket carries its own header copy, so the sidebar needs no per-group ternary'
)

// Order must come from the bucket list, not from whichever row happened to arrive
// first — otherwise the sidebar reshuffles as sessions update.
const g3rev = groupSessions([...twoAxes].reverse(), sidebarPseudoBuckets<Row>(), now)
check(
  g3rev.map((g) => g.bucket).slice(-2).join(' | ') === `${DESKTOP_BUCKET} | ${HARNESS_BUCKET}`,
  'group order is independent of row order'
)

// Precedence is DEFINED, not incidental. The shipped predicates are disjoint, so
// force an overlap and pin which one wins.
const overlapping: Array<PseudoBucket<Row>> = [
  { name: DESKTOP_BUCKET, match: () => true },
  { name: HARNESS_BUCKET, match: () => true }
]
const g4 = groupSessions(twoAxes, overlapping, now)
check(
  g4.length === 1 && g4[0].bucket === DESKTOP_BUCKET && g4[0].rows.length === twoAxes.length,
  'first match wins — a row cannot appear in two groups'
)

// A real Beacon session must never be swept up by either predicate.
const realOnly = groupSessions(
  [{ id: 'beacon:real-1', gateway: 'beacon', lastActive: now.getTime() }],
  sidebarPseudoBuckets<Row>(),
  now
)
check(
  realOnly.length === 1 && realOnly[0].bucket === 'Today' && !realOnly[0].pseudo,
  "Beacon's own chat sits in Today like any conversation — not in Desktop, not in Harness"
)

// ── Collapse persistence ────────────────────────────────────────────────────
console.log('\n=== collapse persistence ===')
check(defaultCollapse().Older === true, 'Older starts collapsed (unchanged)')
check(defaultCollapse().Today !== true, 'recent buckets start open')

// THE DRIFT GUARD. Iterating PSEUDO_BUCKETS rather than naming groups by hand is
// what makes registration and collapse-default one fact: a new trailing group
// cannot be introduced without this loop covering it, so none can start life
// expanded and silently bury rows in an open group nobody scrolls to.
for (const name of PSEUDO_BUCKETS) {
  check(defaultCollapse()[name] === true, `${name} starts collapsed, with its count showing in the header`)
}
check(
  PSEUDO_BUCKETS.includes(DESKTOP_BUCKET) && PSEUDO_BUCKETS.includes(HARNESS_BUCKET),
  'both shipped pseudo-buckets are registered — the loop above is not vacuously true'
)
check(PSEUDO_BUCKETS.length === 2, 'exactly two, so a third arriving unnoticed trips this')

const roundTrip = resolveCollapse(
  parseCollapse(serializeCollapse({ Older: false, [HARNESS_BUCKET]: false, [DESKTOP_BUCKET]: false }))
)
check(
  roundTrip.Older === false && roundTrip[HARNESS_BUCKET] === false && roundTrip[DESKTOP_BUCKET] === false,
  'an operator who expands all three groups still has them expanded after a restart — this was useState and did not survive one'
)
check(resolveCollapse(parseCollapse('not json')).Older === true, 'garbage persisted value falls back to defaults')
check(resolveCollapse(parseCollapse(null)).Older === true, 'absent persisted value falls back to defaults')
check(
  resolveCollapse(parseCollapse('{"Older":"yes"}')).Older === true,
  'a non-boolean value is dropped rather than coerced into a collapse state'
)
check(
  resolveCollapse({ Today: true }).Today === true && resolveCollapse({ Today: true }).Older === true,
  'persisted keys layer OVER defaults without erasing the ones they omit'
)

// ── The Pinned group: an explicit pin leads, whatever the session's age ─────
{
  const pinnedSet = new Set(['desktop:pinme', 'harness-probe-1'])
  const rows = [
    { id: 'desktop:pinme', lastActive: now.getTime() - 30 * 86_400_000 }, // old — would be 'Older'
    { id: 'harness-probe-1', lastActive: now.getTime() }, // harness-shaped AND pinned
    { id: 'beacon:normal', lastActive: now.getTime() }
  ]
  const pinnedFn = (r: { id: string }): boolean => pinnedSet.has(r.id)
  const pg = groupSessions(rows, sidebarPseudoBuckets(), now, pinnedFn)
  check(pg[0].bucket === PINNED_BUCKET, 'the Pinned group leads')
  check(pg[0].rows.length === 2, 'both pinned rows land there — including the month-old one')
  check(
    pg[0].rows.some((r) => r.id === 'harness-probe-1') && !pg.some((g) => g.bucket === HARNESS_BUCKET),
    'a pin BEATS the harness classification — the operator said so'
  )
  check(pg[0].pseudo === false, 'Pinned is not a pseudo-bucket (it never defaults collapsed)')
  check(!(PINNED_BUCKET in defaultCollapse()), 'defaultCollapse never collapses Pinned')
  const none = groupSessions(rows, sidebarPseudoBuckets(), now, () => false)
  check(none.every((g) => g.bucket !== PINNED_BUCKET), 'no pins → no empty Pinned header')
  const noFn = groupSessions(rows, sidebarPseudoBuckets(), now)
  check(noFn.every((g) => g.bucket !== PINNED_BUCKET), 'omitting the predicate keeps the old contract byte-for-byte')
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}\n`)
process.exit(failures === 0 ? 0 : 1)
