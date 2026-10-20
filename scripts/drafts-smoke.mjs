#!/usr/bin/env node
// Composer-draft contract. Beacon has no DOM test framework (the context-meter-smoke.mjs /
// selection-smoke.mjs idiom), so the LOGIC lives in @shared/drafts and is asserted here — including
// the in-memory map, which is module state and therefore directly exercisable headless.
//
// THE INVARIANTS, and why each is here rather than argued in a comment:
//
//   1. A draft survives a session switch. That is the whole feature; ChatShell is remounted per
//      session (key={active}) so the memory copy is what actually brings the text back.
//   2. The durable copy is what survives a RELAUNCH, and clearing must WRITE '' rather than skip —
//      a skipped write leaves the previous draft on disk and resurrects deleted text.
//   3. A forgotten session must not have its draft row resurrected. main deletes the row; the
//      renderer's unmount flush runs afterwards and would write it straight back. `null` from
//      draftStoreValue means "do not write at all" and is a DIFFERENT answer from `''` — collapsing
//      the two is exactly how the leak comes back.
//   4. The tombstone is not permanent. A forgotten session that speaks again is revived, and text
//      typed after that is a new draft that deserves to persist like any other.
//
// Both directions are asserted where a one-sided test would pass on a stub: recall of an unseen
// session must be `undefined` (fall through to the store), not `''` (known-empty, never ask).
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import ts from 'typescript'

// Transpile the REAL module with the REAL compiler rather than stripping types by regex — the same
// argument context-meter-smoke makes: a hand-rolled stripper breaks on the first return-type
// annotation. @shared/drafts imports nothing, so it stands alone.
const srcPath = join(process.cwd(), 'src/shared/drafts.ts')
const js = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText
const out = join(mkdtempSync(join(tmpdir(), 'beacon-drafts-')), 'drafts.mjs')
writeFileSync(out, js)
const {
  DRAFT_PREFIX,
  DRAFT_STORE_MAX,
  DRAFT_WRITE_DEBOUNCE_MS,
  draftKey,
  persistableDraft,
  restorableDraft,
  rememberDraft,
  recallDraft,
  forgetDraft,
  isDraftForgotten,
  draftStoreValue,
  rememberedDraftCount,
  clearRememberedDrafts
} = await import(out)

let failures = 0
function assert(cond, what) {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${what}`)
  if (!cond) failures++
}

const A = 'beacon:1001'
const B = 'telegram:5521'

// ── keys and bounds ──────────────────────────────────────────────────────────
assert(DRAFT_PREFIX === 'draft:', 'the prefix is draft: — it must match CacheRepo.SESSION_SETTING_PREFIXES or forget-hygiene misses it')
assert(draftKey(A) === `draft:${A}`, 'draftKey is the prefix + the raw session id (no encoding: settings keys are opaque)')
assert(draftKey(A) !== draftKey(B), 'two sessions get two keys')
assert(DRAFT_STORE_MAX === 64 * 1024, 'the durable bound is 64 KiB')
assert(DRAFT_WRITE_DEBOUNCE_MS > 0 && DRAFT_WRITE_DEBOUNCE_MS < 1000, 'the debounce is sub-second — long enough to coalesce a word, short enough that a kill loses a fraction of a sentence')

// ── persistableDraft: what the durable store gets ────────────────────────────
assert(persistableDraft('half a thought') === 'half a thought', 'ordinary text is stored verbatim')
assert(persistableDraft('') === '', 'empty text stores as empty, which CLEARS the row')
assert(persistableDraft('x'.repeat(DRAFT_STORE_MAX)) === 'x'.repeat(DRAFT_STORE_MAX), 'exactly at the bound is still stored (the bound is inclusive)')
assert(persistableDraft('x'.repeat(DRAFT_STORE_MAX + 1)) === '', 'over the bound stores NOTHING rather than a prefix — half a message reads as all of it')
assert(persistableDraft('line one\nline two') === 'line one\nline two', 'newlines survive: a multi-line draft is the common case, not an edge')

// ── restorableDraft: what a read-back becomes ────────────────────────────────
assert(restorableDraft('kept text') === 'kept text', 'a stored draft restores to itself')
assert(restorableDraft(null) === '', 'no row (null) means no draft')
assert(restorableDraft(undefined) === '', 'an undefined read means no draft')
assert(restorableDraft('') === '', "a cleared row ('') means no draft — this repo's own empty-value convention")

// round trip through both halves, which is what actually happens across a relaunch
assert(restorableDraft(persistableDraft('typed, then relaunched')) === 'typed, then relaunched', 'write then read is the identity for real text')
assert(restorableDraft(persistableDraft('x'.repeat(DRAFT_STORE_MAX + 1))) === '', 'an over-bound draft round-trips to nothing, not to a fragment')

// ── the in-memory fast path ──────────────────────────────────────────────────
clearRememberedDrafts()
assert(recallDraft(A) === undefined, 'an unseen session recalls undefined — "ask the store", NOT "" ("known empty, never ask")')
assert(recallDraft(A) !== '', 'undefined and "" are different answers and must stay different')
assert(rememberedDraftCount() === 0, 'nothing is remembered before anything is typed')

rememberDraft(A, 'half a thought')
assert(recallDraft(A) === 'half a thought', 'a draft is recoverable the instant it is written — synchronous, no round trip, which is what closes the gap')
assert(rememberedDraftCount() === 1, 'one session remembered')
rememberDraft(B, 'a different conversation')
assert(recallDraft(A) === 'half a thought' && recallDraft(B) === 'a different conversation', 'drafts are per-session, not one global field')
assert(rememberedDraftCount() === 2, 'two sessions remembered')

rememberDraft(A, 'half a thought, finished')
assert(recallDraft(A) === 'half a thought, finished', 'typing on overwrites rather than appending')
assert(rememberedDraftCount() === 2, 'overwriting does not add a second entry')

rememberDraft(A, '')
assert(recallDraft(A) === undefined, 'sending clears the memory entry — so the next mount falls through to the store instead of re-seeding deleted text')
assert(rememberedDraftCount() === 1, 'an emptied draft leaves the map rather than holding a blank row per session ever visited')

// ── draftStoreValue: the one decision point both write paths share ───────────
clearRememberedDrafts()
assert(draftStoreValue(A, 'still typing') === 'still typing', 'a live session writes its draft')
assert(draftStoreValue(A, '') === '', 'a live session with an empty draft writes "" — it CLEARS the row')
assert(draftStoreValue(A, 'x'.repeat(DRAFT_STORE_MAX + 1)) === '', 'an over-bound draft clears rather than truncating')

// ── the tombstone ────────────────────────────────────────────────────────────
rememberDraft(A, 'text in the field when forget ran')
forgetDraft(A)
assert(recallDraft(A) === undefined, 'forget drops the in-memory draft — memory and the store have to agree or the forget is half a forget')
assert(isDraftForgotten(A), 'forget tombstones the session')
assert(draftStoreValue(A, 'text in the field when forget ran') === null, 'the unmount flush after a forget writes NOTHING: main already deleted the row and writing it back would undo the forget')
assert(draftStoreValue(A, '') === null, 'a forgotten session skips the write even when the value would have been a clear — there is no row left to clear')
assert(draftStoreValue(B, 'unaffected') === 'unaffected', 'the tombstone is per-session: forgetting A does not stop B persisting')

// THE DISTINCTION THE WHOLE GUARD RESTS ON. If null and '' ever collapse, either the flush
// resurrects a deleted row or a legitimate clear stops clearing.
assert(draftStoreValue(A, 'x') !== '', 'null (skip) is NOT "" (clear) — collapsing them is how the leak comes back')
assert(draftStoreValue(B, '') !== null, '"" (clear) is NOT null (skip) — a live session must still be able to empty its row')

// ── revival lifts the tombstone ──────────────────────────────────────────────
// A forgotten session that speaks again is revived rather than buried. Text typed into a live
// conversation after that point is a new draft, not the deleted one coming back.
rememberDraft(A, 'typed after the session came back')
assert(!isDraftForgotten(A), 'new text lifts the tombstone — it is not a permanent ban on the session')
assert(draftStoreValue(A, 'typed after the session came back') === 'typed after the session came back', 'a revived session persists its new draft like any other')
assert(recallDraft(A) === 'typed after the session came back', 'and the revived draft is recoverable in memory too')

rememberDraft(A, '')
forgetDraft(A)
assert(draftStoreValue(A, '') === null, 'forgetting again re-tombstones (an empty remember does not lift it, only real text does)')

// ── reset ────────────────────────────────────────────────────────────────────
clearRememberedDrafts()
assert(rememberedDraftCount() === 0, 'the test reset empties the map')
assert(!isDraftForgotten(A), 'and clears the tombstones, so cases cannot leak into each other')

console.log(failures === 0 ? '\n[smoke] drafts: all assertions passed' : `\n[smoke] drafts: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
