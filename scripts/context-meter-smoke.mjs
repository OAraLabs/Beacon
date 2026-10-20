#!/usr/bin/env node
// Context-meter contract. Beacon has no DOM test framework (same approach as
// selection-smoke.mjs / check-tokens.mjs), so the LOGIC lives in @shared and is asserted here.
//
// THE INVARIANT: an unresolved context window renders as UNKNOWN, never as 0%.
//
// The daemon was taught not to fabricate a denominator — /api/lcm answers
// `limit: null, limit_source: "unknown"` when nothing resolves, and `assembled: false` when it
// skipped assembly (the zeros are then placeholders, not measurements). `tokenPct` returns 0 for
// a missing limit, which paints an EMPTY BAR — visually identical to "plenty of headroom".
// Rendering that would reintroduce the fabricated denominator one layer up, in the client.
//
// Both directions are asserted: the unknown cases must NOT be 'known', and a real reading must
// still come through as 'known' with the right percentage — a helper that returned unknown for
// everything would satisfy the first half alone.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import ts from 'typescript'

// Transpile the REAL module with the REAL compiler rather than stripping types by regex —
// daemon-api.ts imports nothing, so it stands alone. (A hand-rolled stripper was tried first
// and broke on the very first return-type annotation, which is the argument for this.)
const srcPath = join(process.cwd(), 'src/shared/daemon-api.ts')
const js = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText
const out = join(mkdtempSync(join(tmpdir(), 'beacon-ctx-')), 'daemon-api.mjs')
writeFileSync(out, js)
const { contextUsage, fmtTokens, segmentsAreLegible } = await import(out)

let failures = 0
const check = (name, cond) => {
  if (cond) console.log(`  ✓ ${name}`)
  else { console.error(`  ✗ ${name}`); failures++ }
}

// ── unknown must survive as unknown ───────────────────────────────────────
check('null limit -> unknown (NOT 0%)',
  contextUsage({ total_tokens: 2209, limit: null, limit_source: 'unknown' }).kind === 'unknown')
check('null limit carries the source as the reason',
  contextUsage({ limit: null, limit_source: 'unknown' }).reason === 'unknown')
check('zero limit -> unknown',
  contextUsage({ total_tokens: 10, limit: 0 }).kind === 'unknown')
check('assembled:false -> unknown even WITH a limit',
  contextUsage({ total_tokens: 0, limit: 32768, assembled: false, reason: 'lcm_engine_unwired' }).kind === 'unknown')
check('assembled:false surfaces the daemon reason',
  contextUsage({ limit: 32768, assembled: false, reason: 'context_limit_unknown' }).reason === 'context_limit_unknown')
check('no payload at all -> unknown',
  contextUsage(null).kind === 'unknown')

// ── ...and known must still work (the control) ────────────────────────────
const live = contextUsage({ total_tokens: 2209, limit: 32768, limit_source: 'detected', assembled: true })
check('a real reading is known', live.kind === 'known')
check('percentage is right (2209/32768 = 7%)', live.pct === 7)
check('source is carried through', live.source === 'detected')
check('older daemon without `assembled` is still treated as measured',
  contextUsage({ total_tokens: 2209, limit: 32768 }).kind === 'known')
check('pct is clamped to 0..100 when over budget',
  contextUsage({ total_tokens: 99999, limit: 1000 }).pct === 100)

// ── compact formatting for a 66px rail ────────────────────────────────────
check('fmtTokens 2209 -> 2.2k', fmtTokens(2209) === '2.2k')
check('fmtTokens 32768 -> 33k', fmtTokens(32768) === '33k')
check('fmtTokens 604300 -> 604k', fmtTokens(604300) === '604k')
check('fmtTokens 1000000 -> 1.0M', fmtTokens(1000000) === '1.0M')
check('fmtTokens 999 stays exact', fmtTokens(999) === '999')

// ── segmentation: drawable only when it reconstructs the total ────────────
const seg = (o) => contextUsage({ limit: 32768, limit_source: 'detected', assembled: true, ...o })

check('a coherent split is drawable',
  seg({ total_tokens: 350, fresh_tokens: 250, summary_tokens: 100 }).segments !== null)
check('segments are % OF THE WINDOW, not of the total',
  Math.abs(seg({ total_tokens: 32768, fresh_tokens: 24576, summary_tokens: 8192 }).segments.freshPct - 75) < 0.001)
check('the two segments together equal the overall fill',
  (() => { const u = seg({ total_tokens: 3277, fresh_tokens: 2000, summary_tokens: 1277 })
           return Math.abs((u.segments.freshPct + u.segments.summaryPct) - (u.total / u.limit) * 100) < 0.001 })())

check('missing split -> no segments (unsegmented fill, not zeros)',
  seg({ total_tokens: 350 }).segments === null)
check('null split -> no segments',
  seg({ total_tokens: 350, fresh_tokens: null, summary_tokens: null }).segments === null)
check('a split that does NOT reconstruct the total is refused',
  seg({ total_tokens: 350, fresh_tokens: 10, summary_tokens: 10 }).segments === null)
check('a negative half is refused',
  seg({ total_tokens: 350, fresh_tokens: 400, summary_tokens: -50 }).segments === null)
check('a coherent empty context still segments (0/0 against 0)',
  seg({ total_tokens: 0, fresh_tokens: 0, summary_tokens: 0 }).segments !== null)
check('unknown window has no segments to draw',
  contextUsage({ limit: null, fresh_tokens: 5, summary_tokens: 5, total_tokens: 10 }).kind === 'unknown')
check('token counts are carried for the tooltip',
  seg({ total_tokens: 350, fresh_tokens: 250, summary_tokens: 100 }).segments.summaryTokens === 100)

// ── legibility: never claim a segment the browser will not paint ──────────
// The live case that exposed this: 373 fresh + 1836 summarised in a 32768 window, drawn in
// the 58px rail. Fresh is 0.66px — invisible — so the bar read as entirely summarised.
const liveSplit = seg({ total_tokens: 2209, fresh_tokens: 373, summary_tokens: 1836 }).segments

check('the real sub-pixel case is refused on the 58px rail',
  segmentsAreLegible(liveSplit, 58) === false)
check('the SAME split is legible on StatusPanel\'s wider bar',
  segmentsAreLegible(liveSplit, 240) === true)
check('a balanced split is legible even on the rail',
  segmentsAreLegible(seg({ total_tokens: 16384, fresh_tokens: 8192, summary_tokens: 8192 }).segments, 58) === true)
check('a genuinely absent half does not block segmentation',
  segmentsAreLegible(seg({ total_tokens: 8192, fresh_tokens: 8192, summary_tokens: 0 }).segments, 58) === true)
check('exactly at the 1.5px floor is legible',
  segmentsAreLegible({ summaryPct: 50, freshPct: (1.5 / 58) * 100, summaryTokens: 0, freshTokens: 0 }, 58) === true)
check('just under the floor is not',
  segmentsAreLegible({ summaryPct: 50, freshPct: (1.4 / 58) * 100, summaryTokens: 0, freshTokens: 0 }, 58) === false)

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1) }
console.log('\ncontext-meter contract OK')
