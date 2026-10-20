/**
 * Headless smoke for renderer recovery: the POLICY (@shared/renderer-recovery) and the durable
 * RECORD (@main/crash-record). Both are Electron-free and imported directly — they are built by
 * electron-vite like every other smoke here, so this runs under ELECTRON_RUN_AS_NODE with no display
 * and no daemon.
 *
 *   npm run build && npm run smoke:recovery
 *
 * THE INVARIANTS, and why each is asserted rather than trusted:
 *
 *   1. A crash reloads — recovery is the point.
 *   2. A crash LOOP stops. Reloading a renderer that dies deterministically is not recovery; it makes
 *      the crash continuous and burns CPU with nothing on screen to explain it.
 *   3. The threshold counts the CURRENT crash. Off-by-one here means the fourth crash stops rather
 *      than the third, or the third reloads rather than stopping.
 *   4. The window bounds the count: three crashes spread over an hour are not a loop.
 *   5. Quitting wins over reloading — a closing app must not resurrect a window.
 *   6. A clean exit is not a crash.
 *   7. The pop-outs are not the shell's business.
 *   8. The durable record tolerates a missing, non-array, or half-written file instead of throwing —
 *      the likeliest way for it to be corrupt is a crash DURING its own write, and a reader that
 *      threw would take down the recovery it exists to support.
 *
 * WHAT THIS CANNOT PROVE, and does not claim to: that main actually RELOADS the window when the
 * policy says reload. That is a consequence, not a decision, and needs
 * webContents.forcefullyCrashRenderer() against the built app — scripts/renderer-recovery-probe.mjs.
 * This smoke pins the decision; that probe pins what main does about it.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  CRASH_LOOP_THRESHOLD,
  CRASH_LOOP_WINDOW_MS,
  CRASH_RECORD_MAX,
  appendCrashRecord,
  crashDecision,
  crashLoopNotice,
  pruneCrashTimes,
  type CrashRecord
} from '@shared/renderer-recovery'
import { crashRecordPath, isCrashRecord, readCrashRecords, recordCrash } from './crash-record'

let failures = 0
function assert(cond: boolean, what: string, detail = ''): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${what}${detail && !cond ? `\n        ${detail}` : ''}`)
  if (!cond) failures++
}

const NOW = 1_700_000_000_000
const base = { reason: 'crashed', isQuitting: false, isMainWindow: true, now: NOW }

console.log('[smoke] === the constants the policy is built on ===')
assert(CRASH_LOOP_THRESHOLD === 3, 'the loop threshold is 3 crashes')
assert(CRASH_LOOP_WINDOW_MS === 60_000, 'the loop window is 60s')

console.log('\n[smoke] === 1. a single crash reloads ===')
{
  const d = crashDecision({ ...base, crashTimes: [NOW] })
  assert(d.kind === 'reload', 'the FIRST crash reloads — recovery is the whole point', JSON.stringify(d))
  assert(d.kind === 'reload' && d.crashesInWindow === 1, 'and counts itself as 1 crash in the window')
}

console.log('\n[smoke] === 2/3. the threshold, with the current crash counted ===')
{
  const d = crashDecision({ ...base, crashTimes: [NOW - 5000, NOW - 2000, NOW] })
  assert(d.kind === 'stop', 'the THIRD crash in a window STOPS reloading — a deterministic crash would otherwise loop forever', JSON.stringify(d))
  assert(d.kind === 'stop' && d.crashesInWindow === 3, 'and reports 3, counting the current one (not off by one)')

  const d2 = crashDecision({ ...base, crashTimes: [NOW - 5000, NOW] })
  assert(d2.kind === 'reload', 'TWO crashes in a window still reload — the threshold is not off by one the other way', JSON.stringify(d2))
}

console.log('\n[smoke] === 4. the window bounds the count ===')
{
  const old = NOW - CRASH_LOOP_WINDOW_MS - 1000
  const d = crashDecision({ ...base, crashTimes: [old, old - 1000, NOW] })
  assert(d.kind === 'reload', 'three crashes SPREAD past the window are not a loop — only the recent one counts', JSON.stringify(d))

  const edge = NOW - CRASH_LOOP_WINDOW_MS
  const d2 = crashDecision({ ...base, crashTimes: [edge, edge, NOW] })
  assert(d2.kind === 'stop', 'crashes exactly at the window edge count (the bound is inclusive)', JSON.stringify(d2))
}

console.log('\n[smoke] === 5/6/7. the three ignore branches ===')
{
  const d = crashDecision({ ...base, isQuitting: true, crashTimes: [NOW] })
  assert(d.kind === 'ignore' && d.why === 'quitting', 'a crash DURING QUIT is ignored — reloading would fight app.quit() and resurrect a closing window', JSON.stringify(d))
  const d2 = crashDecision({ ...base, isQuitting: true, crashTimes: [NOW - 1000, NOW - 500, NOW] })
  assert(d2.kind === 'ignore', 'quitting is ignored even mid-loop — teardown is not recovery', JSON.stringify(d2))

  const d3 = crashDecision({ ...base, reason: 'clean-exit', crashTimes: [NOW] })
  assert(d3.kind === 'ignore' && d3.why === 'clean-exit', 'clean-exit is ignored — a deliberate end, and reloading would resurrect a renderer meant to go', JSON.stringify(d3))

  const d4 = crashDecision({ ...base, isMainWindow: false, crashTimes: [NOW] })
  assert(d4.kind === 'ignore' && d4.why === 'not-the-main-window', "a pop-out crash is not the shell's to reload", JSON.stringify(d4))
}

console.log('\n[smoke] === 8. oom is a real crash reason and behaves like one ===')
{
  const d = crashDecision({ ...base, reason: 'oom', crashTimes: [NOW - 1000, NOW - 500, NOW] })
  assert(d.kind === 'stop' && d.reason === 'oom', 'an OOM loop stops AND carries its reason, so the notice can name it', JSON.stringify(d))
}

console.log('\n[smoke] === pruneCrashTimes ===')
{
  const pruned = pruneCrashTimes([NOW - 120_000, NOW - 30_000, NOW], NOW)
  assert(pruned.length === 2 && !pruned.includes(NOW - 120_000), 'prune drops timestamps older than the window')
  assert(pruneCrashTimes([NOW + 1000], NOW).length === 0, 'prune drops a FUTURE timestamp — a clock jump must not inflate the count')
}

console.log('\n[smoke] === the notice is actionable, not decorative ===')
{
  const n = crashLoopNotice('oom', 3)
  assert(/stopped/i.test(n.message), 'it says recovery STOPPED — a dead window and a paused one must not look the same')
  assert(/3/.test(n.message), 'it carries the crash COUNT, the evidence')
  assert(/oom/.test(n.message), 'it names the REASON')
  assert(/quit|reopen/i.test(n.body), 'it says quitting is the way out — the dialog is the only surface left when the renderer is dead')
  // macOS drops `title` and renders `message` as the bold headline, so the headline must stand alone:
  // short, and naming Beacon rather than opening on a pronoun ("Its window…") with nothing to refer to.
  assert(n.message.length <= 120 && /^Beacon\b/.test(n.message), 'the headline stands alone (macOS shows no title): one short sentence that names Beacon')
  assert(!/\n/.test(n.message), 'the headline is one line — the explanation belongs in the body, which macOS renders as the detail')
  assert(n.title.length > 0, 'it has a title')
  // The copy may promise only what is true. Conversations are on the daemon and in the cache; UNSENT
  // text is not guaranteed (the new-chat box is not saved at all, and a dead renderer takes the
  // in-memory draft tier and the last debounce window with it). #172's crash surface shipped this
  // same overclaim once already.
  assert(!/nothing is lost|drafts (are|and)[^.]*safe|drafts are on/i.test(n.message + ' ' + n.body), 'it does not promise unsent text survived — only conversations are guaranteed')
}

console.log('\n[smoke] === appendCrashRecord is bounded and newest-first ===')
{
  // The fixture MUST be newest-first, which is the convention appendCrashRecord assumes and the
  // file documents. It drops the TAIL, and the tail is the oldest only under that convention — an
  // ascending fixture here would make the code look wrong when the fixture was. (It did, and the
  // first run of this smoke caught the fixture rather than a bug, which is the assertion working.)
  const seed: CrashRecord[] = Array.from({ length: CRASH_RECORD_MAX }, (_, i) => ({
    at: NOW - i * 1000, // descending: index 0 newest, last index oldest
    reason: 'crashed',
    appVersion: '0.2.0'
  }))
  const oldest = seed[seed.length - 1]
  const secondOldest = seed[seed.length - 2]
  const next = appendCrashRecord(seed, { at: NOW + 1000, reason: 'oom', appVersion: '0.2.0' })

  assert(next.length === CRASH_RECORD_MAX, `the record is capped at ${CRASH_RECORD_MAX} — an unbounded diagnostic is a disk-fill`)
  assert(next[0].at === NOW + 1000 && next[0].reason === 'oom', 'the newest crash is FIRST, with its own reason (not just its timestamp)')
  // Named-element assertions, not index arithmetic: the OLDEST is gone and the second-oldest is
  // still there. A cap that dropped from the wrong end would pass a length check and fail these.
  assert(!next.some((r) => r.at === oldest.at), 'the OLDEST record is the one dropped — the cap takes from the wrong end otherwise')
  assert(next.some((r) => r.at === secondOldest.at), 'the second-oldest SURVIVES — exactly one row was dropped, not a run of them')
  assert(next[next.length - 1].at === secondOldest.at, 'and the survivor is now the tail, so the list is still newest-first end to end')
}

console.log('\n[smoke] === the durable record: real functions, real files ===')
{
  const dir = mkdtempSync(join(tmpdir(), 'beacon-recovery-fs-'))
  const file = crashRecordPath(dir)
  assert(file.endsWith('renderer-crashes.json'), 'crashRecordPath names the record file')

  // A missing file reads as empty rather than throwing.
  assert(readCrashRecords(dir).length === 0, 'a MISSING record file reads as [] — the first crash on any machine')

  // Round-trip through the REAL writer and reader.
  const written = recordCrash(dir, { at: NOW, reason: 'oom', exitCode: 1, appVersion: '0.2.0' })
  assert(written.length === 1, 'recordCrash returns the record it wrote')
  const back = readCrashRecords(dir)
  assert(back.length === 1 && back[0].reason === 'oom' && back[0].exitCode === 1, 'a written crash reads back with its reason and exitCode')

  // Accumulates across launches (a read-then-append, not a truncate).
  recordCrash(dir, { at: NOW + 1000, reason: 'crashed', appVersion: '0.2.0' })
  const two = readCrashRecords(dir)
  assert(two.length === 2, 'a second crash ACCUMULATES rather than replacing the first')
  assert(two[0].at === NOW + 1000, 'newest-first, as the file documents')

  // Capped on disk, not just in the returned array.
  for (let i = 0; i < CRASH_RECORD_MAX + 5; i++) recordCrash(dir, { at: NOW + 2000 + i, reason: 'crashed', appVersion: '0.2.0' })
  assert(readCrashRecords(dir).length === CRASH_RECORD_MAX, `the FILE is capped at ${CRASH_RECORD_MAX} rows, not only the in-memory result`)

  // Corruption tolerance — each shape a crash can actually leave behind.
  writeFileSync(file, '{"not":"an array"}', 'utf8')
  assert(readCrashRecords(dir).length === 0, 'a non-array body reads as [] rather than throwing')
  writeFileSync(file, '{ half-written', 'utf8')
  assert(readCrashRecords(dir).length === 0, 'a HALF-WRITTEN file reads as [] — the likeliest corruption, since this is written from a crash handler')
  writeFileSync(file, JSON.stringify([{ at: 'not-a-number', reason: 'oom', appVersion: '0' }, null, 'a string', { at: NOW }]), 'utf8')
  assert(readCrashRecords(dir).length === 0, 'malformed ROWS are dropped rather than passed through to a caller that expects numbers')
  writeFileSync(file, JSON.stringify([{ at: NOW, reason: 'oom', appVersion: '0.2.0' }, { at: 'bad' }]), 'utf8')
  assert(readCrashRecords(dir).length === 1, 'a good row survives beside a bad one — one corrupt row does not cost the record')

  // isCrashRecord is the predicate behind that, asserted directly so the filter cannot silently
  // become permissive while the file tests above keep passing on luck.
  assert(isCrashRecord({ at: NOW, reason: 'oom', appVersion: '0' }), 'a complete row is valid')
  assert(!isCrashRecord({ at: 'nope', reason: 'oom', appVersion: '0' }), 'a non-numeric at is invalid')
  assert(!isCrashRecord({ at: NOW, appVersion: '0' }), 'a missing reason is invalid')
  assert(!isCrashRecord({ at: NOW, reason: 'oom' }), 'a missing appVersion is invalid — it is what makes "did this start after the update?" answerable')
  assert(!isCrashRecord(null) && !isCrashRecord('x'), 'null and a bare string are invalid')

  // The file is real JSON a person can read, not a binary blob.
  recordCrash(dir, { at: NOW, reason: 'oom', appVersion: '0.2.0' })
  const raw = readFileSync(file, 'utf8')
  assert(raw.includes('\n  '), 'the record is pretty-printed — it is meant to be read by a person after a bad day')
  assert(Array.isArray(JSON.parse(raw)), 'and is valid JSON')

  rmSync(dir, { recursive: true, force: true })
}

console.log('\n[smoke] ========================= RESULT =========================')
console.log(`[smoke] outcome: ${failures === 0 ? 'PASS ✓ (policy decides, record survives corruption)' : `FAIL ✗ (${failures})`}`)
console.log('[smoke] ===========================================================')
process.exit(failures === 0 ? 0 : 1)
