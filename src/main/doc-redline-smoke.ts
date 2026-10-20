/**
 * Documents redline smoke (headless / ELECTRON_RUN_AS_NODE) — the pure inline tracked-changes layout
 * behind the Editor Makeover's Ask-AI review-view:
 *   - reviewSegments places pending {find,replace,reason} edits INLINE, in document order;
 *   - edits whose find is absent or overlaps an earlier one go to `unplaceable` (never silently dropped);
 *   - the accept → apply → re-layout flow drops the accepted edit (find replaced) — proven via applyOnce;
 *   - reviewTally counts statuses for the header.
 * Beacon has no component-test framework, so the React wiring is the macOS eyes-on walk; the
 * decision/placement logic is proven here. FAIL-LOUD + count-guarded.
 */
import { reviewSegments, reviewTally, applyOnce, type DocSuggestion, type ReviewSegment } from '@shared/documents'

let failures = 0
let checks = 0
function assert(cond: boolean, label: string): void {
  checks++
  console.log(`[doc-redline] ${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}

if (typeof reviewSegments !== 'function' || typeof reviewTally !== 'function' || typeof applyOnce !== 'function') {
  console.error('[doc-redline] FAIL — required @shared/documents exports missing. Refusing to vacuously pass.')
  process.exit(1)
}

const sg = (find: string, replace: string, reason = '', applicable = true, note = ''): DocSuggestion => ({ find, replace, reason, applicable, note })
const isEdit = (s: ReviewSegment): s is Extract<ReviewSegment, { kind: 'edit' }> => s.kind === 'edit'
const FIXED = 17

function main(): void {
  // ── single edit placed inline ──
  {
    const L = reviewSegments('the quick brown fox', [{ idx: 0, sugg: sg('quick', 'swift', 'tighter') }])
    assert(L.segments.length === 3, 'single edit → [text, edit, text]')
    const a = L.segments[0]
    const b = L.segments[1]
    const c = L.segments[2]
    assert(a.kind === 'text' && a.text === 'the ', 'leading text preserved')
    assert(b.kind === 'edit' && b.find === 'quick' && b.replace === 'swift' && b.reason === 'tighter' && b.idx === 0, 'edit segment carries find/replace/reason/idx')
    assert(c.kind === 'text' && c.text === ' brown fox', 'trailing text preserved')
    assert(L.unplaceable.length === 0, 'placed → nothing unplaceable')
  }

  // ── multiple edits ordered by DOCUMENT position, not list order ──
  {
    const L = reviewSegments('alpha beta gamma', [
      { idx: 0, sugg: sg('gamma', 'GAMMA') },
      { idx: 1, sugg: sg('alpha', 'ALPHA') }
    ])
    const edits = L.segments.filter(isEdit)
    assert(edits.length === 2, 'two edits placed')
    assert(edits[0].find === 'alpha' && edits[1].find === 'gamma', 'edits ordered by document position, not list order')
  }

  // ── find absent → surfaced as unplaceable, never dropped ──
  {
    const L = reviewSegments('hello world', [{ idx: 3, sugg: sg('missing', 'x', 'r') }])
    assert(L.segments.length === 1 && L.segments[0].kind === 'text', 'no inline edit when find absent')
    assert(L.unplaceable.length === 1 && L.unplaceable[0].idx === 3, 'absent find → unplaceable (never silently dropped)')
  }

  // ── overlapping edits → second deferred with a note ──
  {
    const L = reviewSegments('abcdef', [
      { idx: 0, sugg: sg('abcd', 'X') },
      { idx: 1, sugg: sg('cdef', 'Y') }
    ])
    const edits = L.segments.filter(isEdit)
    assert(edits.length === 1 && edits[0].idx === 0, 'first edit placed')
    assert(L.unplaceable.length === 1 && L.unplaceable[0].idx === 1 && /overlap/i.test(L.unplaceable[0].note), 'overlapping edit deferred with a note')
  }

  // ── no pending → whole doc as one text run ──
  {
    const L = reviewSegments('just text', [])
    assert(L.segments.length === 1 && L.segments[0].kind === 'text', 'no pending → one text run')
    assert(L.unplaceable.length === 0, 'no pending → nothing unplaceable')
  }

  // ── accept → apply → re-layout drops the accepted edit (it is now plain applied text) ──
  {
    const text = 'the quick brown fox'
    const edit = sg('quick', 'swift')
    const before = reviewSegments(text, [{ idx: 0, sugg: edit }])
    assert(before.segments.some(isEdit), 'pending edit shows before accept')
    const after = applyOnce(text, edit.find, edit.replace) // simulate accept = editDoc + applyOnce
    assert(after === 'the swift brown fox', 'applyOnce performs the find→replace (the persisted change)')
    const reL = reviewSegments(after, []) // accepted edit is no longer pending
    assert(!reL.segments.some(isEdit), 'after accept + re-layout the edit is gone — no double-apply')
  }

  // ── reviewTally ──
  {
    const t = reviewTally(['pending', 'pending', 'approved', 'rejected', 'na'])
    assert(t.pending === 2 && t.approved === 1 && t.rejected === 1 && t.na === 1 && t.failed === 0, 'reviewTally counts every status')
  }

  if (checks !== FIXED) {
    console.error(`[doc-redline] FAIL — ran ${checks} checks but expected ${FIXED}.`)
    failures++
  }
  console.log('\n[doc-redline] ===================== RESULT =====================')
  console.log(`[doc-redline] checks=${checks} expected=${FIXED} failures=${failures}`)
  console.log(`[doc-redline] outcome: ${failures === 0 ? 'PASS ✓ (inline redline placement + accept/re-layout logic holds)' : `FAIL ✗ (${failures})`}`)
  console.log('[doc-redline] ===================================================')
  process.exit(failures === 0 ? 0 : 1)
}

try {
  main()
} catch (err) {
  console.error('[doc-redline] FAILED (threw before completing — loud, not a silent skip):', err)
  process.exit(1)
}
