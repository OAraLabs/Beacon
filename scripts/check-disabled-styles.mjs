// Guard for the two defect classes closed in 0c67fc0 (disabled-affordance drift):
//
//   1. A JSX element carrying a `disabled` prop must not take `style={bareIdentifier}` — a bare
//      identifier has no literal to carry the disabled affordance, so the prop and the look drift
//      apart (the Enrol-looks-live bug). `style` must be a call, or an object literal.
//   2. `{ ...X, … }` where THIS FILE defines X as a function is a violation ANYWHERE, disabled or
//      not: spreading a function contributes nothing, the styles silently vanish, and typecheck
//      stays green (the IntegrationsPanel regression the fix itself minted and caught).
//
// DELIBERATELY NOT the stricter "every spread must be a call": ConnectionSettings' token input
// spreads a static object and carries the affordance in the literal (`opacity: cond ? …`) —
// correct code the strict rule would nag forever. className-based buttons are ignored entirely;
// their :disabled rules live in styles.css.
//
// Heuristic parser, self-tested below — a guard that cannot detect the bug it exists for is a
// note, not a guard.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'src/renderer/src'

/** Every JSX opening tag's raw text, brace/string-aware so `=>` and `>` inside attribute braces
 *  do not end the tag early. Heuristic: comments inside attribute braces are not handled. */
function jsxTags(src) {
  const tags = []
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== '<' || !/[A-Za-z]/.test(src[i + 1] ?? '')) continue
    let j = i + 1
    let depth = 0
    let str = null
    while (j < src.length) {
      const c = src[j]
      if (str) {
        if (c === str && src[j - 1] !== '\\') str = null
      } else if (c === '"' || c === "'" || c === '`') str = c
      else if (c === '{') depth++
      else if (c === '}') depth--
      else if (c === '>' && depth === 0) break
      j++
    }
    tags.push({ text: src.slice(i, j + 1), index: i })
    i = j
  }
  return tags
}

/** The balanced-brace value of an attribute like `style={…}`, or null. */
function attrValue(tag, name) {
  const at = tag.indexOf(`${name}={`)
  if (at < 0) return null
  let j = at + name.length + 1
  let depth = 0
  let str = null
  const start = j + 1
  while (j < tag.length) {
    const c = tag[j]
    if (str) {
      if (c === str && tag[j - 1] !== '\\') str = null
    } else if (c === '"' || c === "'" || c === '`') str = c
    else if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return tag.slice(start, j).trim()
    }
    j++
  }
  return null
}

/** Identifiers this source defines as FUNCTIONS. The arrow (or `function`) is required — a
 * parenthesized initializer like `const kept = (prev ?? []).filter(…)` is an object, and the
 * first live scan flagged exactly that. Params are matched non-nested (the common case); the
 * optional return annotation excludes `>` so `=>` still terminates it. Residual known limit:
 * a callback param shadowing an outer same-named arrow would still false-positive — none exist
 * in-tree, and the self-test documents the accepted shapes. */
function functionNames(src) {
  const names = new Set()
  for (const m of src.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=\n]+)?=\s*(?:async\s*)?\([^()]*\)\s*(?::\s*[^=>\n]+)?=>/g)) names.add(m[1])
  for (const m of src.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1])
  return names
}

function lineOf(src, index) {
  return src.slice(0, index).split('\n').length
}

export function violations(src) {
  const out = []
  const fns = functionNames(src)

  // Rule 2: function spread — anywhere, not just disabled sites.
  for (const m of src.matchAll(/\.\.\.\s*([A-Za-z_$][\w$]*)\b/g)) {
    const after = src.slice(m.index + m[0].length).match(/^\s*(.)/)
    const called = after?.[1] === '('
    if (!called && fns.has(m[1]))
      out.push({ line: lineOf(src, m.index), rule: 'function-spread', detail: `{ ...${m[1]} } spreads a FUNCTION — contributes nothing; call it: { ...${m[1]}() }` })
  }

  // Rule 1: disabled + bare-identifier style.
  for (const t of jsxTags(src)) {
    if (!t.text.includes('disabled={')) continue
    const style = attrValue(t.text, 'style')
    if (style && /^[A-Za-z_$][\w$.]*$/.test(style))
      out.push({ line: lineOf(src, t.index), rule: 'disabled-affordance', detail: `disabled element takes style={${style}} — a bare identifier cannot carry the disabled look; make it a call or a literal` })
  }
  return out
}

// ── self-test: the guard must catch the bugs it exists for ───────────────────
const CASES = [
  ['<button style={btn} disabled={x}>go</button>\nconst btn = { a: 1 }', 1, 'the original Enrol bug'],
  ['const btn = (d = false) => ({})\nconst s = { ...btn, padding: 1 }', 1, 'the function-spread regression'],
  ['const btn = (d = false) => ({})\n<button style={btn(dis)} disabled={dis}/>', 0, 'a call is fine'],
  ['const btn = (d = false) => ({})\n<button style={{ ...btn(), padding: 1 }} disabled={x}/>', 0, 'a called spread is fine'],
  ['const field = { a: 1 }\n<input style={{ ...field, opacity: c ? 0.5 : 1 }} disabled={c}/>', 0, 'a static-object spread with the affordance in the literal is fine'],
  ['<button style={btn} onClick={f}>x</button>', 0, 'no disabled prop → rule 1 does not apply'],
  ['<button className="send-btn" disabled={x}/>', 0, 'className buttons are styles.css territory'],
  ['<button disabled={x} style={btn(a)} onClick={() => go(1 > 0)}>x</button>', 0, 'braces with => and > parse'],
  // The two false-positive mechanisms the first live scan hit — pinned out of existence:
  ['const kept = (prev ?? []).filter(x => x)\nconst all = [...kept, ...found]', 0, 'a parenthesized initializer is not a function'],
  ['setPins((m) => ({ ...m, [name]: v }))', 0, 'a callback param spread is not a function spread'],
  ['const btn = (c: string, disabled = false): CSSProperties => ({})\nconst s = { ...btn, x: 1 }', 1, 'typed multi-param arrows are still detected'],
]
for (const [fixture, expect, why] of CASES) {
  const got = violations(fixture).length
  if (got !== expect) {
    console.error(`✗ self-test failed (${why}): expected ${expect} violation(s), got ${got}`)
    process.exit(2)
  }
}

// ── scan ─────────────────────────────────────────────────────────────────────
const files = []
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const full = join(d, e.name)
    if (e.isDirectory()) walk(full)
    else if (e.name.endsWith('.tsx') || e.name.endsWith('.ts')) files.push(full)
  }
}
walk(ROOT)

let bad = 0
for (const f of files) {
  const src = readFileSync(f, 'utf8')
  for (const v of violations(src)) {
    console.error(`  ${f}:${v.line}  [${v.rule}] ${v.detail}`)
    bad++
  }
}
if (bad > 0) {
  console.error(`✗ ${bad} disabled-affordance violation(s) — see 0c67fc0 for the idiom`)
  process.exit(1)
}
console.log('✓ lint:disabled — disabled buttons style from the same flag; no function spreads')
