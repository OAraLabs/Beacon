/**
 * Contrast audit — every informational color pair, in every plate, measured.
 *
 * WHY THIS EXISTS. The Skin Codex grew to nine plates by deriving each new one from a plate that
 * already worked. That method has a failure mode the design handoff (2026-09-03) names exactly:
 * a hex map can be COMPLETE and still WRONG, because three relationships INVERT between a dark
 * plate and a light one.
 *
 *   1. `--idle` carries TEXT ("stale", "queued", an unreachable host), so on a light plate it has
 *      to move DARKER, like the ink ladder. Porting a dark plate's `--idle` to a light one lands
 *      around 2.7:1 while looking, in the diff, like a faithful translation.
 *   2. `--ink4` is the informational FLOOR, and it has to clear that floor on the DARKEST surface
 *      it appears on — not just on `--paper`. The pair that matters is the session panel, because
 *      that is where the timestamp column lives.
 *   3. A mid-tone accent glyph on a 12–16% tint OF ITSELF (the VO / TG / BN identifier chips, an
 *      active pill's label) works on dark paper and collapses on light.
 *
 * None of those are catchable by eye in a swatch, and none are catchable by `check-tokens.mjs`,
 * which proves only that a component asks for a token rather than a hex. This asks the harder
 * question: once the cascade resolves, is the text readable?
 *
 * WHAT IT CHECKS. Every pair below is a real rule in styles.css or a component's inline style —
 * a foreground token on the surface it actually lands on, including tints composited over that
 * surface. Anything a user has to READ must clear FLOOR_AA. Decorative pairs (hairlines, Armilla
 * strokes, glow washes) are deliberately absent: they are not text and gating them would make
 * this noise.
 *
 * FAIL-CLOSED. A parse that finds no plates, too few tokens, or a pair naming a token that does
 * not exist is a FAILURE, not a silent pass — the way this guard would otherwise rot is by
 * quietly measuring nothing. The self-test at the top proves the math against known values AND
 * proves the gate actually rejects the historical bug (RVBEDO's ported `--idle`) before any real
 * plate is measured. A guard that cannot demonstrate it would have caught the original defect is
 * a comment, not a gate.
 *
 *   npm run lint:contrast            # gate: exit 1 on any informational pair under the floor
 *   npm run lint:contrast -- --all   # the full table, including pairs that pass
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const TOKENS = join(REPO, 'src/renderer/src/theme/tokens.css')

/** WCAG 2.1 AA for normal-size text. The Codex's own R8 floor (`--ink4`) is pitched at this. */
const FLOOR_AA = 4.5
/** Large/bold text (≥18.66px bold or ≥24px) may sit here. Used only where a pair is genuinely large. */
const FLOOR_LARGE = 3.0

// ── color math ───────────────────────────────────────────────────────────────────────────────
function parseColor(v) {
  const s = String(v).trim()
  let m = s.match(/^#([0-9a-f]{3})$/i)
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16)).concat(1)
  m = s.match(/^#([0-9a-f]{6})$/i)
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat(1)
  m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/i)
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])]
  return null
}
/** Source-over: a translucent layer on an opaque one. This is what the browser paints. */
function composite(fg, bg) {
  const a = fg[3]
  return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a)).concat(1)
}
function relLuminance([r, g, b]) {
  const f = (c) => {
    const x = c / 255
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
function contrast(fg, bg) {
  const [a, b] = [relLuminance(fg), relLuminance(bg)].sort((x, y) => y - x)
  return (a + 0.05) / (b + 0.05)
}

// ── tokens.css → { plateKey: { token: value } } ───────────────────────────────────────────────
function parseTokens(rawCss) {
  // Strip comments FIRST. Without this, splitting a block on ';' leaves the next declaration
  // trailing a `/* … */`, the anchored decl regex misses it, and the parse silently loses every
  // token that happens to follow a commented one — a "found nothing, reported nothing" bug of
  // exactly the kind the fail-closed counts below exist to catch.
  const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '')
  const plates = {}
  // `:root { … }` is NOX; every `[data-theme='x'] { … }` is a plate's overrides on top of it.
  const blockRe = /(:root|\[data-theme='([a-z]+)'\])\s*\{([^}]*)\}/g
  let m
  while ((m = blockRe.exec(css)) !== null) {
    const key = m[2] ?? 'dark'
    const decls = {}
    for (const d of m[3].split(';')) {
      const dm = d.match(/^\s*(--[a-z0-9-]+)\s*:\s*([\s\S]+?)\s*$/i)
      if (dm) decls[dm[1]] = dm[2]
    }
    plates[key] = { ...(plates[key] ?? {}), ...decls }
  }
  const base = plates.dark ?? {}
  const out = {}
  for (const [key, decls] of Object.entries(plates)) out[key] = key === 'dark' ? { ...decls } : { ...base, ...decls }
  return out
}

/** Resolve a token to rgba, following one level of `var(--x)` aliasing. */
function resolve(tokens, name, seen = 0) {
  const raw = tokens[name]
  if (raw === undefined) throw new Error(`token ${name} is not defined in this plate`)
  const varMatch = raw.match(/^var\((--[a-z0-9-]+)\)$/i)
  if (varMatch) {
    if (seen > 4) throw new Error(`token ${name} aliases in a cycle`)
    return resolve(tokens, varMatch[1], seen + 1)
  }
  const c = parseColor(raw)
  if (!c) throw new Error(`token ${name} is not a color this script can read: ${raw}`)
  return c
}
/** A foreground token over a stack of surfaces: ['--node', '--sang-soft'] = the tint over the card. */
function stackColor(tokens, stack) {
  let out = resolve(tokens, stack[0])
  for (const layer of stack.slice(1)) out = composite(resolve(tokens, layer), out)
  return out
}

// ── the pairs. Each one is a real rule; `where` names it so a failure is actionable. ──────────
// floor: FLOOR_AA unless the text is genuinely large (a 20px+ display title, a 22px stat).
const PAIRS = [
  // primary + body copy
  { fg: '--ink', on: ['--paper'], what: 'page + surface titles', where: '.subnav-title, .thread-name' },
  { fg: '--ink', on: ['--node'], what: 'primary text in a card', where: 'MissionControl cards, dock panes' },
  { fg: '--ink-soft', on: ['--node'], what: 'message body + inline code', where: '.msg-body, .msg-body code' },
  { fg: '--ink5', on: ['--node'], what: 'session row resting title', where: '.session-row' },
  { fg: '--ink5', on: ['--paper'], what: 'list/nav resting text', where: 'MissionControl rows' },
  // secondary
  { fg: '--ink2', on: ['--node'], what: 'secondary text', where: '.side-panel-tab, card sentences' },
  { fg: '--ink2', on: ['--paper'], what: 'secondary text on the page', where: '.armilla-legend dd' },
  // mono caps labels
  { fg: '--ink3', on: ['--node'], what: 'mono caps label in a card', where: 'cardTitle, groupHead' },
  { fg: '--ink3', on: ['--paper'], what: 'mono caps label on the page', where: '.armilla-head, .session-group-head' },
  // THE FLOOR (R8) — timestamps, counts, durations, placeholders, key hints
  { fg: '--ink4', on: ['--paper'], what: 'timestamps/counts on the page', where: '.thread-sub' },
  { fg: '--ink4', on: ['--node'], what: 'timestamps in the session panel + cards', where: '.session-time, .ctx-footer-row — the darkest surface --ink4 lands on' },
  // status scale — every one of these carries TEXT, so it is the -text variant that is measured.
  // The raw --idle / --online / --lapis / --sang stay unmeasured HERE on purpose: as dots, fills
  // and borders they are not text, and gating them would force a fill to be legible as a word.
  { fg: '--idle-text', on: ['--node'], what: '"stale" / "queued" text', where: 'BackendTable fresh cell, stateChip' },
  { fg: '--idle-text', on: ['--paper'], what: '"stale" / "queued" text on the page', where: 'stateChip on a surface' },
  { fg: '--online-text', on: ['--node'], what: '"up" / "healthy" text', where: 'stateChip, BackendTable state cell' },
  // Symmetry with --idle-text below, which was already measured on both surfaces. Health text on
  // bare --paper is rare on desktop (status chips live in cards) but the omission was an oversight,
  // not a decision — and a sibling client asked, which is how a hole like this surfaces.
  { fg: '--online-text', on: ['--paper'], what: '"up" / "healthy" text on the page', where: 'stateChip on a surface' },
  { fg: '--lapis-text', on: ['--node'], what: 'secondary links + pending permission', where: 'linkBtn, "13 failed →"' },
  { fg: '--lapis-text', on: ['--paper'], what: 'secondary link on the page', where: 'MissionControl "Open Activity →"' },
  { fg: '--sang-text', on: ['--node'], what: 'error text, "due now", inline code', where: 'MissionControl scheduled row, MessageRenderer inline pill' },
  { fg: '--on-sang', on: ['--sang'], what: 'text on a filled primary button', where: '.send-btn, primaryBtn' },
  // tint-of-itself: a mid-tone accent glyph on a 12–16% wash of the same accent
  { fg: '--sang-text', on: ['--node', '--sang-soft'], what: 'active chip label on its own tint', where: '.scope-chip.is-active' },
  { fg: '--sang-text', on: ['--paper', '--sang-soft'], what: 'active pill label on its own tint', where: '.pill.is-active' },
  { fg: '--sang-text', on: ['--node', '--sang-soft'], what: 'active dock segment glyph', where: '.dock-seg.is-active' },
  { fg: '--online-text', on: ['--node', '--online-soft'], what: 'health label on its own tint', where: 'stateChip ok' },
  { fg: '--lapis-text', on: ['--node', '--lapis-soft'], what: 'permission label on its own tint', where: 'summaryBar' },
  // identifier chips + inactive pills: a glyph on a neutral hairline wash
  { fg: '--ink3', on: ['--node', '--line3'], what: 'session source tag (BN/TG/VO)', where: '.gw' },
  // …and the same tag on the SELECTED row, which adds the selection tint UNDER the chip's wash.
  // One row is always selected, so this stack is always on screen. The painted-pixel walk found
  // it; the flat "chip on a card" pair above cannot see it.
  { fg: '--ink3', on: ['--node', '--sang-soft', '--line3'], what: 'source tag on the selected row', where: '.session-row.is-active .gw' },
  { fg: '--online-text', on: ['--node', '--sang-soft', '--line3'], what: 'Beacon source tag on the selected row', where: '.session-row.is-active .gw-beacon' },
  { fg: '--sang-text', on: ['--node', '--sang-soft', '--line3'], what: 'Telegram source tag on the selected row', where: '.session-row.is-active .gw-telegram' },
  { fg: '--idle-text', on: ['--node', '--sang-soft', '--line3'], what: 'Slack source tag on the selected row', where: '.session-row.is-active .gw-slack' },
  { fg: '--ink5', on: ['--node', '--sang-soft'], what: 'selected session title', where: '.session-row.is-active' },
  { fg: '--ink4', on: ['--node', '--sang-soft'], what: 'timestamp on the selected row', where: '.session-row.is-active .session-time' },
  { fg: '--ink2', on: ['--node', '--line3'], what: 'inactive scope chip', where: '.scope-chip' },
  { fg: '--ink2', on: ['--paper', '--line3'], what: 'inactive sub-nav pill', where: '.pill' },
  { fg: '--ink4', on: ['--node', '--line3'], what: 'count inside a chip', where: '.scope-n, .pill-n, countChip' },
  { fg: '--ink4', on: ['--paper', '--line3'], what: 'count inside a pill on the page', where: '.pill-n' },
  { fg: '--ink3', on: ['--paper', '--line3'], what: 'mono label inside a chip on the page', where: 'countChip' },
  { fg: '--sang-text', on: ['--paper'], what: 'error text on the page', where: 'MissionControl "due now"' }
]

// ── self-test: the math, and the gate's teeth, before a single plate is measured ──────────────
function selfTest() {
  const fails = []
  const eq = (label, got, want, tol = 0.02) => {
    if (Math.abs(got - want) > tol) fails.push(`${label}: got ${got.toFixed(3)}, expected ~${want}`)
  }
  eq('black on white is 21:1', contrast([0, 0, 0], [255, 255, 255]), 21)
  eq('white on white is 1:1', contrast([255, 255, 255], [255, 255, 255]), 1)
  eq('#767676 on white is the AA hairline', contrast(parseColor('#767676'), parseColor('#fff')), 4.54, 0.05)
  // compositing: 50% black over white is #808080-ish by alpha, not by hex
  const half = composite(parseColor('rgba(0,0,0,0.5)'), parseColor('#ffffff'))
  eq('50% black over white composites to 127.5', half[0], 127.5, 0.5)
  if (parseColor('#abc')[0] !== 0xaa) fails.push('3-digit hex expansion is wrong')
  if (parseColor('rgba(1, 2, 3, .4)')[3] !== 0.4) fails.push('rgba alpha parse is wrong')
  if (parseColor('not-a-color') !== null) fails.push('a non-color must parse as null, not a guess')

  // THE MUTATION TEST — the historical bug this gate exists for. RVBEDO shipped a light plate
  // whose `--idle` was ported across from a dark one; it carries "stale"/"queued" TEXT and landed
  // near 2.7:1. Feed the gate that exact pair: if it does not reject it, the gate is decorative.
  const ported = contrast(parseColor('#96705a'), parseColor('#fffdfc')) // RVBEDO's own --idle on its --node
  if (ported >= FLOOR_AA) fails.push(`the ported --idle should measure under the floor, got ${ported.toFixed(2)}`)
  if (!(ported > 1)) fails.push('the ported --idle measurement is degenerate')
  // …and the corrected value must pass, or the gate is simply "reject everything".
  const fixed = contrast(parseColor('#6b7263'), parseColor('#f4f5f3')) // GLAVCVM's --idle on its --node
  if (fixed < FLOOR_AA) fails.push(`the corrected --idle should clear the floor, got ${fixed.toFixed(2)}`)

  if (fails.length) {
    console.error('✗ lint:contrast SELF-TEST FAILED — refusing to report on any plate:')
    for (const f of fails) console.error(`   ${f}`)
    process.exit(1)
  }
}

// ── run ──────────────────────────────────────────────────────────────────────────────────────
selfTest()

const css = readFileSync(TOKENS, 'utf8')
const plates = parseTokens(css)
const keys = Object.keys(plates)

// Fail-closed: a parse that found nothing must not report "no failures".
const MIN_PLATES = 9
const MIN_TOKENS = 25
if (keys.length < MIN_PLATES) {
  console.error(`✗ lint:contrast — parsed ${keys.length} plates from tokens.css, expected at least ${MIN_PLATES}. Refusing to vacuously pass.`)
  process.exit(1)
}
for (const k of keys) {
  const n = Object.keys(plates[k]).length
  if (n < MIN_TOKENS) {
    console.error(`✗ lint:contrast — plate '${k}' resolved only ${n} tokens (expected ≥ ${MIN_TOKENS}). Refusing to vacuously pass.`)
    process.exit(1)
  }
}

// ── the audit must not be fiction ────────────────────────────────────────────────────────────
// Measuring `--sang-text` proves nothing if no rule ever asks for it. Every token this script
// gates has to be REACHABLE from the renderer — directly, or through one of the legacy --c-*
// aliases that map onto it. Without this, deleting a usage would leave a green audit describing
// a UI that no longer exists, which is the exact shape of a guard that gates nothing.
const ALIAS = {
  '--sang-text': ['--c-arc-text', '--c-err-text'],
  '--lapis-text': ['--c-amber-text'],
  '--online-text': ['--c-ok-text'],
  '--idle-text': ['--c-warn-text']
}
// tokens.css is where these tokens are DEFINED (and where the legacy --c-*-text aliases point at
// them). Counting that file as "usage" makes the check vacuous — it was, until a mutation test
// removed every real usage and this still passed. The definition file is excluded by name.
const DEFINITION_FILE = 'tokens.css'
function sourceText(dir) {
  let out = ''
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out += sourceText(full)
    else if (/\.(tsx?|css)$/.test(name) && name !== DEFINITION_FILE) out += readFileSync(full, 'utf8')
  }
  return out
}
const rendererSrc = sourceText(join(REPO, 'src/renderer/src'))
if (!rendererSrc.includes('var(--ink4)')) {
  console.error('✗ lint:contrast — the renderer scan found no token usage at all; the scan path is wrong. Refusing to vacuously pass.')
  process.exit(1)
}
const unused = []
for (const token of new Set(PAIRS.map((p) => p.fg).filter((t) => t.endsWith('-text')))) {
  const names = [token, ...(ALIAS[token] ?? [])]
  if (!names.some((n) => rendererSrc.includes(`var(${n})`))) unused.push(`${token} (or ${(ALIAS[token] ?? []).join(', ')})`)
}
if (unused.length) {
  console.error('✗ lint:contrast — these tokens are measured but never used by the renderer, so the audit describes nothing:')
  for (const u of unused) console.error(`   ${u}`)
  process.exit(1)
}

const showAll = process.argv.includes('--all')
// Per-pair worst/best across every plate. This exists because of a real mistake: the report was
// nine per-plate blocks and nothing else, so someone (me) read a TRUNCATED view showing six of
// the nine, quoted its lowest value as the pair's worst case, and was wrong by 0.80. A tool that
// cannot state its own worst case invites exactly the error it exists to prevent — so the range
// is computed here and always available, and the tightest pair is printed even on a passing run.
const ranges = new Map()
const failures = []
let measured = 0
for (const key of keys) {
  const tokens = plates[key]
  const rows = []
  for (const p of PAIRS) {
    let ratio
    try {
      ratio = contrast(stackColor(tokens, [p.fg]), stackColor(tokens, p.on))
    } catch (e) {
      console.error(`✗ lint:contrast — plate '${key}', pair ${p.fg} on ${p.on.join(' over ')}: ${e.message}`)
      process.exit(1)
    }
    measured++
    const floor = p.floor ?? FLOOR_AA
    const ok = ratio >= floor
    if (!ok) failures.push({ key, ...p, ratio, floor })
    if (showAll || !ok) rows.push({ ok, ratio, floor, p })
    const rk = `${p.fg}|${p.on.join('|')}`
    const seen = ranges.get(rk)
    if (!seen) ranges.set(rk, { p, floor, min: ratio, minPlate: key, max: ratio, maxPlate: key })
    else {
      if (ratio < seen.min) { seen.min = ratio; seen.minPlate = key }
      if (ratio > seen.max) { seen.max = ratio; seen.maxPlate = key }
    }
  }
  if (rows.length) {
    console.log(`\n${key}`)
    for (const r of rows) {
      const stack = r.p.on.join(' over ')
      console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.ratio.toFixed(2).padStart(5)}:1  (floor ${r.floor})  ${r.p.fg} on ${stack}  — ${r.p.what}  [${r.p.where}]`)
    }
  }
}

// The per-pair range, worst first. Under --all this replaces reading nine blocks and doing the
// min in your head — the thing that produced a confidently wrong quote. Each line names the plate
// that holds the worst case, because "which plate is carrying this pair" is the actionable half.
const ordered = [...ranges.values()].sort((a, b) => a.min - b.min)
if (showAll) {
  console.log(`\nper pair, worst → best across all ${keys.length} plates:`)
  for (const r of ordered) {
    const stack = r.p.on.join(' over ')
    console.log(
      `  ${r.min.toFixed(2).padStart(5)} ${r.minPlate.padEnd(8)} → ${r.max.toFixed(2).padStart(5)} ${r.maxPlate.padEnd(8)}  ${r.p.fg} on ${stack}  — ${r.p.what}`
    )
  }
}

console.log(`\nmeasured ${measured} pairs across ${keys.length} plates (${PAIRS.length} pairs each)`)
if (failures.length) {
  console.error(`✗ lint:contrast — ${failures.length} informational pair(s) under the floor. Every one of these is text a user has to read.`)
  process.exit(1)
}
// Printed on a PASSING run too: "everything passes" hides how close it came, and the margin is
// what tells you whether the next plate has room. Run with --all for the whole table.
const tightest = ordered[0]
console.log(`✓ lint:contrast — every informational pair clears ${FLOOR_AA}:1 in all ${keys.length} plates`)
console.log(`  every -text token is reachable from the renderer (the audit describes real rules)`)
console.log(
  `  tightest pair ${tightest.min.toFixed(2)}:1 (floor ${tightest.floor}) — ${tightest.p.fg} on ${tightest.p.on.join(' over ')}, worst in ${tightest.minPlate}`
)
console.log(`  (${FLOOR_LARGE}:1 is the large-text allowance; no pair here claims it. --all prints every pair's range.)`)
