// Approving a phone (the phone-onboarding plan, desktop item 2): an approval is always chat-only (Prometheus makes every approved device
// an ordinary, scoped one); owner powers come only from an owner code, minted on the computer Prometheus runs on with
// `oara pair --owner`. And when a device asks to join while Beacon isn't in front, a notification says so, in words of Beacon's own: a
// requester picks its device name, so the name is never put in a system notification.
//
//   npm run build && npm run smoke:join-notice
import { OWNER_COPY } from '@shared/owner-strings'
import { joinNotice, ownerSteps, OWNER_COMMAND } from '@shared/join-notice'
import type { WaitingRequest } from '@shared/join-owner'

let failures = 0
function assert(cond: boolean, label: string, extra?: unknown): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && extra !== undefined ? ` — ${JSON.stringify(extra)}` : ''}`)
  if (!cond) failures++
}
const req = (id: string, deviceName = 'Apple Security: approve now'): WaitingRequest => ({ requestId: id, deviceName, platform: 'iPhone or iPad', sourceIp: '192.0.2.7', deadlineMs: 9e15, createdAt: 1 })

console.log('\n[smoke] === the approval is chat-only, and says so ===')
assert(OWNER_COPY.approve === 'Approve as chat-only', 'the button says what it grants', OWNER_COPY.approve)
assert(/Make it an owner/.test(OWNER_COPY.makeOwner ?? ''), 'and "Make it an owner…" is offered beside it', OWNER_COPY.makeOwner)

console.log('\n[smoke] === owner: the exact command, on the right computer ===')
{
  assert(OWNER_COMMAND === 'oara pair --owner', 'the command, exactly')
  const here = ownerSteps({ thisMac: true, instance: 'Laptop' })
  const there = ownerSteps({ thisMac: false, instance: 'Home mini' })
  assert(here.command === OWNER_COMMAND && there.command === OWNER_COMMAND, 'both carry it')
  assert(/Terminal on this Mac/.test(here.where) && /Home mini/.test(there.where) && !/this Mac/.test(there.where), 'where to run it: this Mac, or the computer that Prometheus runs on', [here.where, there.where])
  assert(/chat-only/.test(here.steps[0]) && here.steps.some((s) => /eight digits/.test(s)) && here.steps.some((s) => /phone/.test(s)), 'approve it as chat-only first, then type the eight digits into the phone', here.steps)
  assert(here.steps.every((s) => !/HTTP|token/i.test(s)), 'in plain words')
}

console.log("\n[smoke] === the notification: new requests only, Beacon's own words ===")
{
  let known: ReadonlySet<string> = new Set()
  const a = joinNotice(known, [req('r1')], { focused: false, instance: 'Home mini' })
  assert(!!a.notice && /join/.test(a.notice.title + a.notice.body) && /Home mini/.test(a.notice.body), 'a new request, Beacon not in front: a notification naming the Prometheus', a.notice)
  assert(!!a.notice && !/Apple Security|192\.0\.2\.7|iPhone/.test(JSON.stringify(a.notice)), "the requester's own name and address are never in it")
  known = a.known
  assert(joinNotice(known, [req('r1')], { focused: false, instance: 'Home mini' }).notice === null, 'the same request again (a backfilled frame): nothing')
  const f = joinNotice(known, [req('r1'), req('r2')], { focused: true, instance: 'Home mini' })
  assert(f.notice === null && f.known.has('r2'), 'Beacon in front: no notification (the prompt shows), and the request is remembered')
  assert(joinNotice(f.known, [req('r1'), req('r2')], { focused: false, instance: 'Home mini' }).notice === null, 'so going to the background later does not notify it late')
  const two = joinNotice(new Set(), [req('r3'), req('r4')], { focused: false, instance: null })
  assert(!!two.notice && /2 devices/.test(two.notice.body + two.notice.title), 'two at once: one notification that says two', two.notice)
  assert(joinNotice(new Set(['gone']), [], { focused: false, instance: null }).known.size === 0, 'requests that ended are forgotten')
}

if (failures) {
  console.log(`\n[smoke] FAIL — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\n[smoke] ALL PASS')
