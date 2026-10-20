/**
 * approval-card-probe — the approval card, PAINTED, in the real built app.
 *
 * WHY A PROBE AND NOT ANOTHER SMOKE. approval-disclosure-smoke reads the card's SOURCE and proves
 * the JSX is written; it cannot prove the JSX renders. That distinction has bitten this repo — an
 * explanation that existed only inside a drawer its own state could not open passed a source check
 * and was invisible to every operator. So this drives Electron over CDP, reads the LIVE DOM, and
 * measures geometry.
 *
 * ── HOW THE ROWS GET IN, AND WHY IT IS NOT A STUB ────────────────────────────────────────────
 *
 * A FAKE GATEWAY serves the captured daemon bytes on the REST port, and the app is pointed at it
 * with BEACON_GATEWAY_HOST / BEACON_GATEWAY_API_PORT (the dev override that also skips first-run
 * setup). So the payload travels the REAL path: fetch → rest.ts listApprovals() → IPC →
 * MainView → ExecApprovalCard → CSS. The mapper is exercised, not bypassed.
 *
 * The first draft stubbed `window.beacon.approvals.list` from CDP instead, and the stub SILENTLY
 * DID NOTHING — a contextBridge object is frozen, so the assignment was ignored while the probe's
 * own "stubbed" check reported success. It is recorded here because the failure mode (a probe
 * confidently measuring a payload it never delivered) is worse than no probe.
 *
 * WHAT IT DOES NOT PROVE: the WS push path, which has no HTTP surface to fake. That half is
 * approval-push-smoke's, which pins the same captured payload through rawToApproval.
 *
 * Run: npm run probe:approval-card     (needs a free REST port; nothing else)
 */
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'

const PORT = 8765
const UD = `/tmp/beacon-approval-probe-ud`

// ── THE CAPTURE ──────────────────────────────────────────────────────────────────────────────
// Produced by running Prometheus bf4e1fe's OWN redact_arguments + ApprovalQueue.serialize_pending
// on 2026-09-19 (worktree of feat/computer-use-m1). snake_case, exactly as the daemon serves it —
// the point of the fake gateway is that these bytes meet the real mapper.
const now = Math.floor(Date.now() / 1000)
const PAYLOAD = [
  {
    request_id: 'probe-typed',
    tool_name: 'computer_type_text',
    description:
      'computer_type_text acts on the desktop: Prometheus may type text in firefox, in the background ' +
      "(without raising the window) — no lasting grant is offered: the value of text cannot be part of a " +
      "remembered grant, so remembering this would mean 'type text in firefox' — approve it once instead, each time",
    created_at: now - 4,
    expires_at: now + 1796,
    extents: {},
    arguments: { app: 'firefox', delivery: 'background', text: 'transfer 500 to account 9' }
  },
  {
    request_id: 'probe-write',
    tool_name: 'write_file',
    description: 'write /home/demo/notes.txt',
    created_at: now - 2,
    expires_at: now + 1798,
    extents: {
      'until-restart': 'write_file on exactly /home/demo/notes.txt — until the daemon restarts',
      always: 'write_file on exactly /home/demo/notes.txt — permanently, until revoked'
    },
    arguments: null
  }
]

let served = 0
const gateway = createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  if (req.url?.startsWith('/api/approvals')) {
    served += 1
    res.end(JSON.stringify(PAYLOAD))
    return
  }
  res.statusCode = 404
  res.end('[]')
})
await new Promise((r) => gateway.listen(PORT, '127.0.0.1', r))
console.log(`[probe] fake gateway on 127.0.0.1:${PORT}`)

// The app inherits these: env gateway → connect, no first-run wizard. The installed Beacon holds
// the shared userData single-instance lock, so the probe takes its own.
process.env.BEACON_GATEWAY_HOST = '127.0.0.1'
process.env.BEACON_GATEWAY_API_PORT = String(PORT)
process.env.BEACON_GATEWAY_WS_PORT = '59999' // dead on purpose: this probe is the REST path
process.env.BEACON_CDP_ARGS = `${process.env.BEACON_CDP_ARGS ?? ''} --user-data-dir=${UD}`.trim()

const { evaluate, sleep, send, mainLog } = await import('./cdp-harness.mjs')

let failures = 0
let checks = 0
function check(cond, label, detail = '') {
  checks += 1
  if (cond) console.log(`  ok   ${label}`)
  else {
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
    failures += 1
  }
}

// ── wait for the card to actually arrive, rather than guessing a sleep ───────────────────────
let dom = null
for (let i = 0; i < 40; i++) {
  await sleep(700)
  dom = await evaluate(`(() => {
    // ONE ELEMENT PER CARD. Matching every div that CONTAINS an approve button also matches the
    // overlay and every wrapper between, so the first draft found 4 "cards" for 2 requests and
    // then read one card's disclosure as the other's. Climb from each approve button to the
    // highest ancestor still holding exactly one of them — that is the card root.
    const cards = [...document.querySelectorAll('.approval-btn-approve')].map((btn) => {
      let el = btn
      while (
        el.parentElement &&
        el.parentElement.querySelectorAll('.approval-btn-approve').length === 1
      ) el = el.parentElement
      return el
    })
    const typed = cards.find((c) => c.textContent.includes('computer_type_text'))
    const write = cards.find((c) => c.textContent.includes('write_file'))
    if (!typed) return { ready: false, shell: !!document.querySelector('.shell'), cards: cards.length }
    const dl = typed.querySelector('dl')
    const approve = typed.querySelector('.approval-btn-approve')
    const args = dl && dl.getBoundingClientRect()
    const btn = approve && approve.getBoundingClientRect()
    const noteOf = (card) => {
      if (!card) return null
      const el = [...card.querySelectorAll('div')].find(
        (d) => d.children.length === 0 && /no lasting grant is on offer/.test(d.textContent || '')
      )
      if (!el) return null
      const cs = getComputedStyle(el)
      return { text: el.textContent.trim(), h: el.offsetHeight, display: cs.display, visibility: cs.visibility }
    }
    const valEl = dl && [...dl.querySelectorAll('dd')].find((d) => /transfer 500/.test(d.textContent))
    return {
      ready: true,
      cardCount: cards.length,
      rows: dl ? [...dl.children].map((el) => [el.tagName, el.textContent]) : [],
      argsBottom: args ? args.bottom : null,
      btnTop: btn ? btn.top : null,
      withLabel: /With/.test(typed.textContent),
      typedNote: noteOf(typed),
      writeNote: noteOf(write),
      typedHasDisclosure: !!typed.querySelector('.approval-disclosure-head'),
      writeHasDisclosure: !!(write && write.querySelector('.approval-disclosure-head')),
      writeHasArgs: !!(write && write.querySelector('dl')),
      valClipped: valEl ? valEl.scrollWidth > valEl.clientWidth + 1 : null,
      // CONTAINMENT. The card sets overflow:hidden, so anything that overflows is CLIPPED, not
      // scrolled — a note painted past the bottom edge would be invisible while still passing
      // every "is it in the DOM / does it have height" check above.
      cardRect: (() => { const r = typed.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width } })(),
      noteRect: (() => {
        const el = [...typed.querySelectorAll('div')].find(
          (d) => d.children.length === 0 && /no lasting grant is on offer/.test(d.textContent || '')
        )
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }
      })()
    }
  })()`)
  if (dom?.ready) break
}

console.log(`\n[probe] /api/approvals served ${served} time(s)`)
check(served > 0, 'the app actually fetched the fake gateway — the payload travelled the real REST path')
if (!dom?.ready) {
  console.error(`  FATAL: the card never appeared. last=${JSON.stringify(dom)}`)
  console.error(mainLog.join('').slice(-1200))
  gateway.close()
  process.exit(1)
}

console.log('\n=== the arguments PAINT ===')
check(dom.cardCount === 2, `both cards rendered (got ${dom.cardCount})`)
check(dom.withLabel, 'the "With" label is on the card — the daemon\'s own word for this block')
check(dom.rows.length === 6, `three key/value pairs rendered as dt/dd (got ${dom.rows.length} elements)`)
const flat = dom.rows.map(([, t]) => t).join('|')
for (const want of ['app', 'firefox', 'delivery', 'background', 'text', 'transfer 500 to account 9']) {
  check(flat.includes(want), `"${want}" is present in the rendered rows`)
}
check(dom.valClipped === false, 'the payload value is not clipped — an argument the card hides is one approved unread')
check(!dom.writeHasArgs, 'the card whose arguments were null renders NO block — never an empty "With" heading')

console.log('\n=== …ABOVE the answer options, in MEASURED pixels ===')
check(
  typeof dom.argsBottom === 'number' && typeof dom.btnTop === 'number' && dom.argsBottom <= dom.btnTop,
  'the arguments block ends above the Approve button begins',
  `args bottom ${dom.argsBottom}, button top ${dom.btnTop}`
)

console.log('\n=== `{}` paints a RULING, not a blank ===')
check(dom.typedNote !== null, 'the no-grant sentence is in the DOM of the empty-extents card')
check(dom.typedNote && dom.typedNote.h > 0, `it has height — rendered, not display:none (h=${dom.typedNote?.h})`)
check(dom.typedNote && dom.typedNote.visibility !== 'hidden', 'it is visible')
check(!dom.typedHasDisclosure, 'and NO "Remember this decision" control sits on that card')
check(dom.writeHasDisclosure, 'the card that DOES offer grants still shows its disclosure')
check(dom.writeNote === null, 'the sentence is ABSENT where a grant IS on offer — the two never contradict')

console.log('\n=== …and it is INSIDE the card, not clipped by its overflow:hidden ===')
check(
  dom.noteRect && dom.cardRect && dom.noteRect.bottom <= dom.cardRect.bottom + 0.5,
  'the note ends within the card — overflow:hidden would silently swallow anything past the edge',
  `note bottom ${dom.noteRect?.bottom}, card bottom ${dom.cardRect?.bottom}`
)
check(
  dom.noteRect && dom.cardRect && dom.noteRect.right <= dom.cardRect.right + 0.5 && dom.noteRect.left >= dom.cardRect.left - 0.5,
  'the note stays within the card horizontally',
  `note ${dom.noteRect?.left}..${dom.noteRect?.right}, card ${dom.cardRect?.left}..${dom.cardRect?.right}`
)
console.log(`  [probe] card is ${dom.cardRect?.width?.toFixed(0)}px wide (MainView asks for min(560px, 90vw))`)

const shot = await send('Page.captureScreenshot', { format: 'png' })
if (shot?.result?.data) {
  writeFileSync('/tmp/approval-card-probe.png', Buffer.from(shot.result.data, 'base64'))
  console.log('\n[probe] screenshot: /tmp/approval-card-probe.png')
}

const MIN_CHECKS = 21
if (checks < MIN_CHECKS) {
  console.error(`  FAIL only ${checks} checks ran, expected at least ${MIN_CHECKS}`)
  failures += 1
}
gateway.close()
console.log(`\n${failures === 0 ? `PASS (${checks} checks)` : `FAIL (${failures})`}\n`)
process.exit(failures === 0 ? 0 : 1)
