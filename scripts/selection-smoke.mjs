#!/usr/bin/env node
// Cross-bubble text-selection contract (static CSS assertion — Beacon has no DOM test
// framework, same approach as check-tokens.mjs). Proves the chat message list is block-flow
// so a selection range can span multiple .msg bubbles, that the user-right / assistant-left
// alignment is preserved under block, and that only message BODIES are selectable while the
// role labels (USER / ASSISTANT) and chrome stay non-selectable — so a multi-message copy
// yields clean text. Run: npm run smoke:selection
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Strip comments first so their prose (and braces, if any) never pollute a prelude or body.
const css = readFileSync(join(process.cwd(), 'src/renderer/src/styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

// Flat-rule tokenizer (innermost `prelude { body }`); the rules we assert are all top-level.
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  prelude: m[1].trim().replace(/\s+/g, ' '),
  body: m[2]
}))

// A selector may have several rule blocks (e.g. .msg-body base + the selection override).
const blocks = (sel) => rules.filter((r) => r.prelude === sel)
const declares = (sel, re) => blocks(sel).some((r) => re.test(r.body))
const lacks = (sel, re) => blocks(sel).length > 0 && !blocks(sel).some((r) => re.test(r.body))
const noneGroup = rules.find((r) => /user-select:\s*none/.test(r.body))

let failures = 0
const check = (name, cond) => {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    console.error(`  ✗ ${name}`)
    failures++
  }
}

// 1. Block flow — the load-bearing change that lets a selection span bubbles.
check('.messages exists', blocks('.messages').length > 0)
check('.messages is block-flow (display: block)', declares('.messages', /display:\s*block/))
check('.messages is NOT flex (the bug)', lacks('.messages', /display:\s*flex/))

// 2. Alignment and spacing preserved under block flow (was flex `align-self` + `gap`).
//    2026-09-03: the MECHANISM changed and these assertions moved with it rather than being
//    deleted. Screen 1 caps the turn at a 720px measure and CENTRES it, so `.msg` is now
//    `margin: 0 auto <gap>` (auto side margins do the centring, the third value the spacing) and
//    the user's bubble right-aligns INSIDE that measure with its own flex row — `margin-left:auto`
//    would have pushed it to the window edge instead. What is being pinned is unchanged: the list
//    stays block-flow so a drag can span bubbles, rows keep vertical separation, and the user's
//    message sits right.
check('.msg is centred on the measure (auto side margins)', declares('.msg', /margin:\s*0\s+auto/))
check('.msg keeps vertical spacing (the third margin value replaced the flex gap)', declares('.msg', /margin:\s*0\s+auto\s+\d/))
check('.msg is capped to the thread measure', declares('.msg', /max-width:\s*var\(--measure\)/))
check('.messages defines that measure', declares('.messages', /--measure:\s*720px/))
check('.msg-user right-aligns its bubble within the measure', declares('.msg-user', /justify-content:\s*flex-end/))
check('.msg-user no longer uses align-self (flex-only on the OLD container)', lacks('.msg-user', /align-self/))

// 3. Message bodies are selectable.
check('.msg-body is selectable (user-select: text)', declares('.msg-body', /user-select:\s*text/))

// 4. Labels + chrome are excluded from the selection range.
check('a user-select: none group exists', !!noneGroup)
for (const sel of [
  '.msg-role', // USER / ASSISTANT labels excluded from copied range
  '.topbar',
  "nav[aria-label='Views']", // the nav rail (inline-styled <nav>)
  '.session-list',
  '.composer-controls',
  'button'
]) {
  check(`chrome non-selectable: ${sel} in the user-select:none group`, !!noneGroup && noneGroup.prelude.includes(sel))
}

// 5. Regression guard: the empty state + "show earlier" stayed centered after dropping flex.
check('.messages:has(.empty) keeps the empty state centered', declares('.messages:has(.empty)', /justify-content:\s*center/))
check('.show-earlier re-centered under block (margin-inline: auto)', declares('.show-earlier', /margin-inline:\s*auto/))

const expected = 16
console.log('\n[selection-smoke] ===================== RESULT =====================')
console.log(`[selection-smoke] checks=${expected} failures=${failures}`)
console.log(
  `[selection-smoke] outcome: ${failures === 0 ? 'PASS ✓ (block-flow selection spans bubbles; alignment preserved; labels + chrome excluded)' : 'FAIL ✗'}`
)
console.log('[selection-smoke] ===================================================')
process.exit(failures === 0 ? 0 : 1)
