/**
 * Nav reach + collision + persistence smoke (headless / ELECTRON_RUN_AS_NODE) — IA refinement.
 *
 * Proves the data-layer contracts the grouped rail rides on, at the views.ts registry where they
 * would actually break:
 *   1. REACH — every view that exists is reachable through NAV_TREE exactly once (no orphan/dup/
 *      phantom), and resolveView still round-trips + guards garbage.
 *   2. COLLISION (the headline of this sprint) — no group header shares a label with one of its own
 *      children (the "Coding > Coding" / "Activity > Activity" bug), and no two children in a group
 *      share a label. Group labels are mutually unique.
 *   3. STRUCTURE — the confirmed grouping decisions are a tested contract (regressing one fails here).
 *   4. R1/R2 (design handoff 2026-09-03) — the rail holds six or fewer destinations and never
 *      expands: a group entry lands on its first child, lights for any child, and every group with
 *      a second level is exactly what SubNav renders as pills. Nothing that is a pane is in it.
 *
 * It does NOT (and cannot, headless) assert DOM click/expand/active-state — that's the macOS eyes-on
 * walk. Reachability + the pure helpers are the bar here.
 *
 * FAIL-LOUD: every check increments `checks`; at the end we verify `checks === expected` (computed
 * from registry/group sizes) so a silently-skipped section FAILS instead of false-passing. Routes are
 * enumerated programmatically from NAV_VIEWS — never a hardcoded subset. A thrown error exits non-zero.
 */
import {
  NAV_VIEWS,
  NAV_TREE,
  DEFAULT_VIEW,
  RAIL_MAX,
  resolveView,
  flattenNavTree,
  groupForView,
  railDestination,
  railEntryActive,
  subNavForView,
  usesPillRow
} from '@shared/views'

let failures = 0
let checks = 0
function assert(cond: boolean, label: string): void {
  checks++
  console.log(`[nav-smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}

// Required-dependency guard: error (don't skip) if the registry/helpers aren't wired. An empty
// registry or a missing export would let every enumeration "pass" vacuously — refuse that outright.
if (
  typeof flattenNavTree !== 'function' ||
  typeof groupForView !== 'function' ||
  typeof resolveView !== 'function' ||
  typeof railDestination !== 'function' ||
  typeof railEntryActive !== 'function' ||
  typeof subNavForView !== 'function' ||
  typeof usesPillRow !== 'function' ||
  !Array.isArray(NAV_VIEWS) ||
  !Array.isArray(NAV_TREE)
) {
  console.error(
    '[nav-smoke] FAIL — required views.ts exports missing (NAV_VIEWS/NAV_TREE/flattenNavTree/groupForView/railDestination/railEntryActive/subNavForView). Refusing to vacuously pass.'
  )
  process.exit(1)
}

// Bump these if you add/remove a check (the count guard fails loud and reminds you).
const FIXED = 41
const PER_VIEW = 2
const PER_GROUP = 4

function main(): void {
  const validIds = new Set<string>(NAV_VIEWS.map((v) => v.id))
  const flat = flattenNavTree()
  const groups = NAV_TREE.flatMap((e) => (e.kind === 'group' ? [e.group] : []))
  const LABEL = Object.fromEntries(NAV_VIEWS.map((v) => [v.id, v.label])) as Record<string, string>

  // ── A. registry/tree present (guards against vacuous pass) ── [3 fixed]
  assert(NAV_VIEWS.length > 0, `registry non-empty (${NAV_VIEWS.length} views)`)
  assert(NAV_TREE.length > 0, `tree non-empty (${NAV_TREE.length} entries, ${groups.length} groups)`)
  assert(flat.length > 0, `flattenNavTree non-empty (${flat.length} leaves)`)

  // ── every view is reachable + round-trips resolveView ── [PER_VIEW each]
  const reached = new Set<string>()
  for (const v of NAV_VIEWS) {
    const isReachable = flat.includes(v.id)
    if (isReachable) reached.add(v.id)
    assert(isReachable, `reachable through the rail: ${v.id}`)
    assert(resolveView(v.id) === v.id, `resolveView round-trips: ${v.id}`)
  }

  // ── every group is a real, well-formed, NON-COLLIDING section ── [PER_GROUP each]
  for (const g of groups) {
    const childLabels = g.children.map((id) => LABEL[id])
    assert(g.children.length > 0, `group ${g.id} has children (no dead-end parent)`)
    assert(g.label.trim().length > 0, `group ${g.id} has a label ("${g.label}")`)
    // The bug this sprint kills: a header must never repeat one of its own children's names.
    assert(!childLabels.includes(g.label), `group "${g.label}" shares NO name with its children [${childLabels.join(', ')}]`)
    assert(new Set(childLabels).size === childLabels.length, `group "${g.label}" has no two same-named children`)
  }

  // ── B. set-equality: no orphan, no phantom, no double-path ── [4 fixed]
  assert(reached.size === NAV_VIEWS.length, `no orphan — every registry view reachable (${reached.size}/${NAV_VIEWS.length})`)
  assert(flat.length === NAV_VIEWS.length, `tree covers exactly the registry by count (${flat.length} === ${NAV_VIEWS.length})`)
  assert(new Set(flat).size === flat.length, `no duplicate — no view reachable via two paths`)
  assert(flat.every((id) => validIds.has(id)), `no phantom — every tree leaf is a real ViewId`)

  // ── C. the normalizer still guards persisted/garbage ids ── [3 fixed]
  assert(resolveView('__does_not_exist__') === DEFAULT_VIEW, `resolveView falls back to DEFAULT_VIEW for unknown id`)
  assert(resolveView('') === DEFAULT_VIEW, `resolveView falls back for empty id`)
  assert(flat.includes(DEFAULT_VIEW), `DEFAULT_VIEW (${DEFAULT_VIEW}) is itself reachable`)

  // ── D. registry order/count contract (mirrors panels-smoke so a divergence fails in both) ── [5 fixed]
  assert(NAV_VIEWS[0].id === 'chat' && DEFAULT_VIEW === 'mission', `chat is first in the registry; Mission is the default landing`)
  assert(NAV_VIEWS[1].id === 'mission', `mission slots second (registry order contract intact)`)
  assert(NAV_VIEWS.length === 17, `seventeen views registered (Terminal is a dock pane; Devices is a Config tab — neither is a rail destination)`)
  assert(resolveView('terminal') === DEFAULT_VIEW, `Terminal is NOT a rail destination (it is a side-panel pane; a stale persisted id falls back)`)
  assert(groupForView('checkpoints')?.id === 'grp:workspace', `Checkpoints lives under Workspace, beside Files`)
  assert(!NAV_VIEWS.some((v) => (v.id as string) === 'devices') && resolveView('devices') === DEFAULT_VIEW, `Devices is NOT a rail destination (it is a Config tab; a stale persisted id falls back)`)

  // ── E. confirmed IA decisions are a tested contract ── [8 fixed]
  assert(groupForView('board')?.id === 'grp:workspace', `Board lives under Workspace`)
  assert(groupForView('board')?.id !== 'grp:coding', `Board is NOT under Coding`)
  assert(groupForView('loop-manager')?.id === 'grp:coding', `Loop Manager lives under Coding`)
  assert(groupForView('coding')?.id === 'grp:coding', `Run (coding) lives under Coding`)
  assert(groupForView('mission') === null, `Mission is a top-level leaf (promoted out of Activity to the landing)`)
  assert(groupForView('chat')?.id === 'grp:conversations', `Chat lives under Chats`)
  assert(groupForView('sessions')?.id === 'grp:conversations', `Sessions is a reachable leaf under Chats (not folded away)`)
  assert(groupForView('config') === null, `Config is a standalone top-level leaf (no parent group)`)

  // ── F. the collision-fix labels + group-label uniqueness ── [4 fixed]
  assert(LABEL['coding'] === 'Run', `coding leaf relabeled to "Run"`)
  assert(LABEL['coding'] !== 'Coding', `coding leaf no longer equals its group "Coding"`)
  assert(LABEL['activity'] !== 'Activity', `activity leaf no longer equals its group "Activity" (now "${LABEL['activity']}")`)
  assert(new Set(groups.map((g) => g.label)).size === groups.length, `group labels are mutually unique`)

  // ── G. Config + Mission are the standalone top-level leaves — every other view has a parent group ──
  assert(
    NAV_VIEWS.every((v) => (v.id === 'config' || v.id === 'mission' ? groupForView(v.id) === null : groupForView(v.id) !== null)),
    `Config and Mission are top-level leaves; every other view sits inside exactly one group`
  )

  // ── H. R1: the rail is where you are — six or fewer, never expands, destinations only ── [9 fixed]
  assert(NAV_TREE.length <= RAIL_MAX, `rail holds ${NAV_TREE.length} entries (R1: at most ${RAIL_MAX})`)
  assert(RAIL_MAX === 6, `RAIL_MAX is still six — Integrations was considered for a rail entry of its own and kept as a Workspace pill instead`)
  assert(
    NAV_TREE.map((e) => (e.kind === 'view' ? LABEL[e.id] : e.group.label)).join(' · ') === 'Mission · Chats · Coding · Workspace · Activity · Config',
    `rail reads Mission · Chats · Coding · Workspace · Activity · Config`
  )
  const chats = NAV_TREE.find((e) => e.kind === 'group' && e.group.id === 'grp:conversations')!
  assert(railDestination(chats) === 'chat', `the Chats entry lands on the thread (children[0] = chat)`)
  assert(railDestination(NAV_TREE[0]) === 'mission' && railDestination(NAV_TREE[NAV_TREE.length - 1]) === 'config', `standalone entries land on themselves`)
  assert(railEntryActive(chats, 'sessions') && railEntryActive(chats, 'chat') && !railEntryActive(chats, 'coding'), `a group entry is active for ANY of its children and no other view`)
  assert(!NAV_TREE.some((e) => e.kind === 'view' && (['browser', 'terminal', 'inspector'] as string[]).includes(e.id)), `no pane is a rail entry (R3)`)
  // ── R2: the pill row is exactly the group's children; a standalone view has no second level ──
  assert(subNavForView('mission') === null && subNavForView('config') === null, `Mission and Config have no pill row`)
  // Presentation is a property of the GROUP, not of the renderer guessing: Coding draws its second
  // level as a left drill-down (two altitudes on one engine, and the list must stay visible while a
  // run is going), everything else uses R2's pill row. Both are still the same `children`.
  assert(usesPillRow('files') && usesPillRow('toolfeed') && usesPillRow('sessions'), `Workspace / Activity / Chats draw their second level as R2 pills`)
  assert(!usesPillRow('coding') && !usesPillRow('loop-manager'), `Coding draws its second level as a left column, not pills`)
  assert(subNavForView('coding')?.children.join(',') === 'coding,loop-manager', `…and it is still the SAME second level — a column is presentation, not a different model`)
  assert(
    subNavForView('files')?.children.join(',') === 'files,artifacts,board,documents,wiki,checkpoints,skills,integrations' &&
      subNavForView('toolfeed')?.children.join(',') === 'activity,toolfeed,status' &&
      subNavForView('loop-manager')?.children.join(',') === 'coding,loop-manager' &&
      subNavForView('sessions')?.children.join(',') === 'chat,sessions',
    `Workspace / Activity / Coding / Chats pill rows carry exactly the sub-views the old rail tree held`
  )

  // ── fail-loud count guard (plain code, not an assert — avoids self-counting) ──
  const expected = FIXED + PER_VIEW * NAV_VIEWS.length + PER_GROUP * groups.length
  if (checks !== expected) {
    console.error(
      `[nav-smoke] FAIL — ran ${checks} checks but expected ${expected} (a section was skipped, or a check was added without bumping FIXED/PER_VIEW/PER_GROUP). This guard exists so a partial run can't false-pass.`
    )
    failures++
  }

  console.log('\n[nav-smoke] ===================== RESULT =====================')
  console.log(`[nav-smoke] checks=${checks} expected=${expected} failures=${failures}`)
  console.log(
    `[nav-smoke] outcome: ${
      failures === 0
        ? 'PASS ✓ (every view reachable once, no parent/child name collision, IA decisions held, rail ≤ 6 and never expands)'
        : `FAIL ✗ (${failures})`
    }`
  )
  console.log('[nav-smoke] ===================================================')
  process.exit(failures === 0 ? 0 : 1)
}

try {
  main()
} catch (err) {
  console.error('[nav-smoke] FAILED (threw before completing — loud, not a silent skip):', err)
  process.exit(1)
}
