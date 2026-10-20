#!/usr/bin/env node
// Opacity lint: no partial `opacity` without a stated reason.
//
// WHY THIS GATE EXISTS. `lint:contrast` measures TOKENS — it reads the declared colour and the
// declared ground. The compositor applies `opacity` to the whole painted subtree afterwards, and
// `getComputedStyle().color` never reports it. So a rule like
//
//     .count { color: var(--ink4); opacity: 0.55; }
//
// passes the contrast gate at 4.6:1 while the glyph on screen sits at ~3.2:1. That has now bitten
// this codebase three times: the gateway chips' counts, the status bar's `--ink4` at 0.85, and the
// model menu's unreachable rows. Every one measured as passing.
//
// The rule: if the thing is INFORMATIONAL TEXT, change the colour — there is a `-text` token for
// every accent, and `--ink4` is the floor. Opacity is for things that are not text you must read:
// a decorative dot, a hover reveal, a fading overlay, a disabled control (WCAG 1.4.3 exempts
// inactive components).
//
// So this does not try to guess which rules paint text — a static guess would be wrong in both
// directions. It requires the AUTHOR to say. Any `opacity` strictly between 0 and 1 needs
//
//     /* opacity-ok: <reason> */
//
// on the same line or the line above. `opacity: 0` and `opacity: 1` are exempt: 0 is a visibility
// pattern (hidden until hover), 1 is the absence of dimming.
//
// Run: npm run lint:opacity
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(process.cwd(), 'src', 'renderer', 'src')
// A REASON, not just a token. `\S` matched the `*` of a bare `/* opacity-ok: */`, so an empty
// pragma passed — caught by this file's own self-test, which is what it is for.
const PRAGMA = /opacity-ok:\s*[A-Za-z0-9]/

/** `opacity: .55` / `opacity: 0.55` / `opacity: 0.55,` (a JSX style object) — but NOT the value
 *  inside a `transition:` or `animation:` shorthand, which names the property, never sets it. */
const DECL = /(^|[;{,\s])opacity\s*:\s*(0?\.\d+|0\.\d+)\s*[;,}]?/

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* walk(p)
    else if (/\.(tsx?|css)$/.test(name)) yield p
  }
}

/** Offending lines in one file's text. Exported shape so the self-test can drive it directly. */
export function scan(text) {
  const lines = text.split('\n')
  const out = []
  lines.forEach((line, i) => {
    if (/\b(transition|animation)\s*:/.test(line)) return // names the property, does not set it
    const m = DECL.exec(line)
    if (!m) return
    const value = Number(m[2])
    if (!(value > 0 && value < 1)) return
    const justified = PRAGMA.test(line) || PRAGMA.test(lines[i - 1] ?? '')
    if (!justified) out.push({ line: i + 1, text: line.trim(), value })
  })
  return out
}

// ── fail-closed self-test ────────────────────────────────────────────────────
// A lint that silently matches nothing reports a clean tree forever. These run on every
// invocation: if the detector stops detecting, the gate says so instead of passing.
const SELF = [
  ['  opacity: 0.55;', 1, 'catches a partial opacity'],
  ['  opacity: .5;', 1, 'catches the leading-dot spelling'],
  ['  opacity: 0.55; /* opacity-ok: a decorative dot */', 0, 'a stated reason exempts it'],
  ['  /* opacity-ok: hover reveal */\n  opacity: 0.4;', 0, 'the reason may sit on the line above'],
  ['  opacity: 0;', 0, 'zero is a visibility pattern, not dimming'],
  ['  opacity: 1;', 0, 'one is the absence of dimming'],
  ['  transition: opacity 0.2s ease;', 0, 'a transition names the property, it does not set it'],
  ['  opacity: 0.55; /* opacity-ok: */', 1, 'a pragma with NO reason does not count']
]
let selfFail = 0
for (const [src, want, what] of SELF) {
  const got = scan(src).length
  if (got !== want) {
    console.error(`✗ lint:opacity SELF-TEST failed — ${what} (expected ${want}, got ${got})`)
    selfFail++
  }
}
if (selfFail > 0) {
  console.error('  the detector is broken; a clean report from it would mean nothing.')
  process.exit(2)
}

const offenders = []
for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file).replace(/\\/g, '/')
  for (const o of scan(readFileSync(file, 'utf8'))) offenders.push(`${rel}:${o.line}  ${o.text}`)
}

if (offenders.length > 0) {
  console.error(
    `✗ lint:opacity — ${offenders.length} partial opacity declaration(s) with no stated reason.\n` +
      `  If it is informational TEXT: change the colour (--ink4 is the floor; every accent has a -text token).\n` +
      `  If it is not: say so — /* opacity-ok: a decorative dot */\n  ` +
      offenders.join('\n  ')
  )
  process.exit(1)
}
console.log(`✓ lint:opacity — every partial opacity states why it is not informational text (${SELF.length} self-tests passed)`)
