// Headless smoke for the mission-plan model (@shared/plan).
// ELECTRON_RUN_AS_NODE electron out/main/plan-smoke.js — no daemon, no React.
//
// THE POINT OF THIS FILE: "no plan" and "a plan with nothing tickable" must never render the same.
// Both fixtures are CAPTURED, not written — see their _header. The untickable one is the first real
// plan an agent produced under the documents instruction, and it has zero checkboxes; a fixture I
// invented would have had checkboxes, and the state that matters would never have been tested.

import { readFileSync } from 'node:fs'
import {
  PLAN_BANNERS,
  duplicateStoryIds,
  listHitCap,
  planFileFor,
  planFilename,
  planStateFrom,
  rollUpPlans,
  sumRatios,
  DOCS_LIST_CAP,
  PLAN_SUMMARY_READ_CAP
} from '@shared/plan'
import agentPlan from './fixtures/plan-capture-beacon-plan-panel-sprint.json'
import realTasks from './fixtures/plan-capture-demo-todo-tasks.json'

let failures = 0
let checks = 0
function check(name: string, cond: boolean): void {
  checks++
  if (cond) console.log(`  ✓ ${name}`)
  else {
    console.error(`  ✗ ${name}`)
    failures++
  }
}

const AGENT = (agentPlan as { content: string }).content
const TASKS = (realTasks as { content: string }).content

console.log('[fixtures] both captured, not written')
check('agent plan fixture is non-empty', AGENT.trim().length > 0)
check('real checklist fixture is non-empty', TASKS.trim().length > 0)

// ── state 1: no file ─────────────────────────────────────────────────────────
console.log('\n[state] no file -> no-plan')
{
  const r = planFileFor(['BC-9-other.md', 'notes.md'], 'BC-4')
  check('planFileFor finds nothing for an unmatched story', r.kind === 'none')
  const s = planStateFrom(r, null)
  check('state is no-plan', s.kind === 'no-plan')
}

// ── state 2: file, zero checkboxes — THE ONE THAT WOULD OTHERWISE READ AS STATE 1 ──
console.log('\n[state] file with no checkboxes -> untickable (NOT no-plan)')
{
  const r = planFileFor(['BC-4-beacon-plan-panel-sprint.md'], 'BC-4')
  check('planFileFor resolves one file', r.kind === 'one')
  const s = planStateFrom(r, AGENT)
  check('state is untickable', s.kind === 'untickable')
  check('untickable is NOT no-plan — the collapse this model exists to prevent', s.kind !== 'no-plan')
  check('untickable reports it HAS content, so the panel can say so', s.kind === 'untickable' && s.hasContent)
  check('the captured agent plan really has zero task lines', s.kind === 'untickable')
  check('the file path survives into the state, so the panel can link it',
    s.kind === 'untickable' && s.path === 'BC-4-beacon-plan-panel-sprint.md')
}

// ── state 3: file with checkboxes ────────────────────────────────────────────
console.log('\n[state] file with checkboxes -> checklist')
{
  const r = planFileFor(['BC-4-tasks.md'], 'BC-4')
  const s = planStateFrom(r, TASKS)
  check('state is checklist', s.kind === 'checklist')
  check('counts come from the REAL captured file: 1 of 4 done',
    s.kind === 'checklist' && s.done === 1 && s.total === 4)
  check('tasks carry their line index for byte-faithful write-back',
    s.kind === 'checklist' && s.tasks.every((t) => typeof t.lineIndex === 'number'))
}

// ── state 4: ambiguity — the story_id UNIQUE gap, guarded rather than tie-broken ──
console.log('\n[state] two files for one story -> ambiguous (never "pick the first")')
{
  const r = planFileFor(['BC-4-plan.md', 'BC-4-notes.md', 'BC-5-plan.md'], 'BC-4')
  check('planFileFor reports ambiguity', r.kind === 'ambiguous')
  check('it names every candidate, sorted', r.kind === 'ambiguous' && r.paths.join(',') === 'BC-4-notes.md,BC-4-plan.md')
  const s = planStateFrom(r, null)
  check('state is ambiguous, not no-plan and not a silent pick', s.kind === 'ambiguous')
}

// ── the other half of the UNIQUE gap: two STORIES sharing one id ─────────────
console.log('\n[guard] story_id has no UNIQUE constraint')
{
  const dup = duplicateStoryIds([
    { story_id: 'BC-4' }, { story_id: 'BC-5' }, { story_id: 'BC-4' }, { story_id: null }, { story_id: '' }
  ])
  check('duplicate story_ids are detected', dup.join(',') === 'BC-4')
  check('null/blank ids are not counted as duplicates', !dup.includes(''))
  check('no false positive when all ids are unique',
    duplicateStoryIds([{ story_id: 'A' }, { story_id: 'B' }]).length === 0)
}

// ── filename minting ─────────────────────────────────────────────────────────
console.log('\n[filename] the join is the prefix')
{
  check('slug is normalised', planFilename('BC-4', 'Plan Panel: Sprint!') === 'BC-4-plan-panel-sprint.md')
  check('a blank slug still yields a valid name', planFilename('BC-4', '   ') === 'BC-4-plan.md')
  check('minted names resolve back to their story',
    planFileFor([planFilename('BC-4', 'x')], 'BC-4').kind === 'one')
  check('a minted name does NOT resolve to a different story',
    planFileFor([planFilename('BC-4', 'x')], 'BC-5').kind === 'none')
  check('a prefix that is not a full id boundary does not match',
    planFileFor(['BC-44-plan.md'], 'BC-4').kind === 'none')
  check('non-markdown is ignored', planFileFor(['BC-4-plan.txt'], 'BC-4').kind === 'none')
}

// ── the hyphen-boundary collision: a CONFIDENT WRONG ANSWER, which is worse than ambiguity ──
// Shipped in #158 and caught by survey: `startsWith('US-')` let story US claim US-001's plan and
// return kind:'one' — a single confident plan, from the one module whose whole job is to refuse
// exactly that. Numeric siblings were never affected; only a hyphen boundary.
console.log('\n[boundary] a story id that prefixes a LONGER story id must not claim its plan')
{
  const r = planFileFor(['US-001-plan.md'], 'US')
  check('story US does NOT claim US-001-plan.md', r.kind === 'none')
  check('and the near miss is NAMED, not silently dropped',
    r.kind === 'none' && r.nearMisses.join(',') === 'US-001-plan.md')
  check('the near miss survives into the rendered state',
    planStateFrom(r, null).kind === 'no-plan' &&
    (planStateFrom(r, null) as { kind: 'no-plan'; nearMisses: string[] }).nearMisses.length === 1)
  check('the longer story DOES claim its own plan', planFileFor(['US-001-plan.md'], 'US-001').kind === 'one')
  check('regression pin: BC-1 never matched BC-10 (the digit case was always safe)',
    planFileFor(['BC-10-beta.md'], 'BC-1').kind === 'none')
  check('BC-10 still resolves its own', planFileFor(['BC-10-beta.md'], 'BC-10').kind === 'one')
}

// ── case-insensitive id, to match the extension test that already was ────────
console.log('\n[case] the id match is case-insensitive, like the .md test beside it')
{
  const lower = planFileFor(['bc-4-plan.md'], 'BC-4')
  check('a lowercase filename resolves for an uppercase story id', lower.kind === 'one')
  check('the ON-DISK spelling is returned, not a normalised one',
    lower.kind === 'one' && lower.path === 'bc-4-plan.md')
  check('and the reverse: uppercase file, lowercase story id',
    planFileFor(['BC-4-PLAN.MD'], 'bc-4').kind === 'one')
}

// ── the daemon's silent listing ceiling ──────────────────────────────────────
console.log('\n[cap] a truncated listing must not read as "no plan"')
{
  check('under the cap is quiet', listHitCap(DOCS_LIST_CAP - 1) === false)
  check('exactly on the cap warns — the only signal the daemon gives', listHitCap(DOCS_LIST_CAP) === true)
  check('over the cap warns', listHitCap(DOCS_LIST_CAP + 1) === true)
}

// ── the read cap: ticking a truncated file would delete the rest of it ───────
console.log('\n[truncated] a capped read is read-only, and says so')
{
  const r = planFileFor(['BC-4-tasks.md'], 'BC-4')
  const capped = planStateFrom(r, TASKS, true)
  check('truncated rides into the checklist state', capped.kind === 'checklist' && capped.truncated)
  check('it defaults to false, so an ordinary read stays tickable',
    (planStateFrom(r, TASKS).kind === 'checklist') &&
    !(planStateFrom(r, TASKS) as { truncated: boolean }).truncated)
  check('an untickable file reports truncation too',
    planStateFrom(planFileFor(['BC-4-x.md'], 'BC-4'), AGENT, true).kind === 'untickable' &&
    (planStateFrom(planFileFor(['BC-4-x.md'], 'BC-4'), AGENT, true) as { truncated: boolean }).truncated)
}

// ── the Mission rollup: read-only, and its counts must not be the capped subset ──
console.log('\n[rollup] the Mission summary card counts every story, reads only a few')
{
  const files = [
    'BC-1-plan.md',        // BC-1: one
    'BC-2-a.md', 'BC-2-b.md', // BC-2: ambiguous
    'BC-3-001-draft.md',   // BC-3: near miss (slug opens numeric)
    'US-001-plan.md'       // belongs to US-001, and US must not claim it
  ]
  const stories = [
    { story_id: 'BC-1', title: 'One' },
    { story_id: 'BC-2', title: 'Two' },
    { story_id: 'BC-3', title: 'Three' },
    { story_id: 'BC-4', title: 'Four' },   // nothing at all
    { story_id: 'US', title: 'Prefix' },   // near miss via US-001-plan.md
    { story_id: '   ', title: 'Blank id' } // unkeyable
  ]
  const r = rollUpPlans(stories, files)
  check('one plan is counted as withPlan', r.withPlan === 1)
  check('two candidates count as ambiguous, not as a plan', r.ambiguous === 1)
  check('a numeric-opening slug counts as a near miss, not as no-plan', r.nearMiss === 2)
  check('a story with nothing counts as noPlan', r.noPlan === 1)
  check('a blank story_id is COUNTED as unkeyable, not silently skipped', r.unkeyable === 1)
  check('every category is accounted for — no story falls through',
    r.withPlan + r.ambiguous + r.nearMiss + r.noPlan + r.unkeyable === stories.length)
  check('rows exclude the unkeyable story, because it has no id to render',
    r.rows.length === stories.length - 1)
  check('rows carry the title through for the card', r.rows[0].title === 'One')
}

console.log('\n[rollup] ratios sum only over what was actually read')
{
  check('empty sums to 0/0, never to a fabricated denominator',
    sumRatios([]).done === 0 && sumRatios([]).total === 0)
  const t = sumRatios([{ done: 1, total: 4 }, { done: 3, total: 3 }])
  check('ratios add up across plans', t.done === 4 && t.total === 7)
  check('the read cap is a real positive bound',
    Number.isInteger(PLAN_SUMMARY_READ_CAP) && PLAN_SUMMARY_READ_CAP > 0)
}

// ── the banner copy: one definition, and a gate that proves it ──────────────────────────────
console.log('\n[banners] the same fact must not be worded two ways')
{
  check('the stories-read failure says UNREAD, not empty',
    PLAN_BANNERS.storiesUnread('boom').includes('boom') &&
    PLAN_BANNERS.storiesUnread('boom').includes('it is unread'))
  check('the listing failure says a plan READS as absent until it clears',
    PLAN_BANNERS.listFailed('boom').includes('reads as having none'))
  check('the fresh-install line names the folder — the actionable part Mission had dropped',
    PLAN_BANNERS.noneSavedYet('loops').includes('loops/'))
  check('the cap line carries the NUMBER — the part Mission had dropped',
    PLAN_BANNERS.listingCapped(2000).includes('2000-entry'))
  check('the duplicate line lists the ids', PLAN_BANNERS.duplicateIds(['BC-4', 'BC-7']).includes('BC-4, BC-7'))
}

// STRUCTURAL: the surfaces must render the shared copy, not their own prose. An absence assertion
// is worthless without proof the search CAN find the thing, so each fragment is checked present in
// the shared module first — that pair is the whole gate.
console.log('\n[banners] no surface keeps a private copy of the prose')
{
  const shared = readFileSync(new URL('../../src/shared/plan.ts', import.meta.url), 'utf8')
  const board = readFileSync(new URL('../../src/renderer/src/components/BoardPanel.tsx', import.meta.url), 'utf8')
  const mission = readFileSync(new URL('../../src/renderer/src/components/MissionControl.tsx', import.meta.url), 'utf8')
  const FRAGMENTS = ['it is unread', 'reads as having none', 'folder appears the first time', '-entry ceiling']
  check('CONTROL: every fragment is findable in the shared module',
    FRAGMENTS.every((f) => shared.includes(f)))
  check('the Board keeps none of the prose', FRAGMENTS.every((f) => !board.includes(f)))
  check('Mission keeps none of the prose', FRAGMENTS.every((f) => !mission.includes(f)))
  check('and both actually call the shared copy',
    board.includes('PLAN_BANNERS.') && mission.includes('PLAN_BANNERS.'))
}

// A count guard, because a smoke that only counts FAILURES cannot tell "all passed" from "that
// section never ran" — panels-smoke has exactly that hole and it is the file pinning NAV_VIEWS.
const EXPECTED = 61
check(`count guard: ${checks + 1} checks ran (expected ${EXPECTED})`, checks + 1 === EXPECTED)

console.log(failures === 0 ? '\n[plan-smoke] PASS' : `\n[plan-smoke] FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
