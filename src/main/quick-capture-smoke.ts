/**
 * quick-capture-smoke — the quick-capture window's pure model (@shared/quick-capture), headless.
 *
 *   1. the target list: a new conversation first, the one in use always listed, then the most
 *      recent by title, capped;
 *   2. the stored target a window starts on;
 *   3. when Enter sends;
 *   4. the screenshot list leaves out the asking window only when it is the quick-capture window;
 *   5. who counts as the quick-capture window, and the hold as a state machine;
 *   6. what goes back in the box after a send that did not all go out, and Esc during a send;
 *   7. on the source: main and the window USE those rules (the rules themselves are tested above;
 *      this part only pins that the call sites go through them, and the probe drives the result).
 *
 * Run: npm run build && npm run smoke:quick-capture
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { classifiedScope } from '@shared/daemon-profiles'
import {
  CAPTURE_DEFAULT_TARGET,
  CAPTURE_HOLD_MAX_MS,
  CAPTURE_NEW_TARGET,
  CAPTURE_TARGETS_MAX,
  CAPTURE_TARGET_KEY,
  captureCanSend,
  captureSources,
  captureTargets,
  escClosesBox,
  hidesOnBlur,
  hidesOnHoldTimeout,
  holdAfter,
  isCaptureSender,
  restoreAfterFailedSend,
  storedCaptureTarget,
  toggleAllowed,
  type HoldEvent
} from '@shared/quick-capture'

const MIN_CHECKS = 70
let checks = 0
let failures = 0
function check(cond: boolean, name: string, detail = ''): void {
  checks++
  if (cond) console.log(`  ✓ ${name}`)
  else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}
process.on('exit', () => {
  console.log('===================== RESULT =====================')
  if (failures === 0 && checks < MIN_CHECKS) {
    console.error(`quick-capture smoke: FAIL ✗ (only ${checks} of at least ${MIN_CHECKS} checks ran)`)
    process.exitCode = 1
  } else if (failures > 0) {
    console.error(`quick-capture smoke: FAIL ✗ (${failures} of ${checks})`)
    process.exitCode = 1
  } else console.log(`quick-capture smoke: PASS ✓ (${checks} checks: targets, stored target, send, sources, sender and hold, restore, wiring)`)
})

console.log('1. the target list')
{
  const sessions = [
    { id: 'beacon:a', title: 'Trip to Lisbon', lastActive: 300 },
    { id: 'beacon:b', title: '', lastActive: 500 },
    { id: 'beacon:c', title: '  Tax papers  ', lastActive: 100 },
    { id: 'beacon:d', lastActive: 400 }
  ]
  const t = captureTargets(sessions, 'beacon:c')
  check(t[0].value === CAPTURE_NEW_TARGET && t[0].label === 'New conversation', 'a new conversation is the first choice')
  check(t[1].value === 'beacon:c' && t[1].label === 'Tax papers', 'the one in use is next, by its title, trimmed')
  check(t.slice(2).map((x) => x.value).join(',') === 'beacon:b,beacon:d,beacon:a', 'then the rest, most recently active first', t.map((x) => x.value).join(','))
  check(t.find((x) => x.value === 'beacon:b')?.label === 'beacon:b', 'a conversation with no title shows its id')
  check(new Set(t.map((x) => x.value)).size === t.length, 'nothing is listed twice')
  const d = captureTargets(sessions, CAPTURE_DEFAULT_TARGET)
  check(d[1].value === CAPTURE_DEFAULT_TARGET && d[1].label === 'Quick capture', 'the standing conversation is listed before it exists, as Quick capture')
  const n = captureTargets(sessions, CAPTURE_NEW_TARGET)
  check(n.filter((x) => x.value === CAPTURE_NEW_TARGET).length === 1 && n.length === 5, 'with New conversation chosen it is listed once')
  const s = captureTargets(sessions, 'beacon:new-1', undefined, 'beacon:new-1')
  check(s[1].label === 'The conversation you just started', 'one this window just started has words, not an id')
  check(captureTargets([...sessions, { id: 'beacon:new-1', title: 'Named since', lastActive: 900 }], 'beacon:new-1', undefined, 'beacon:new-1')[1].label === 'Named since', 'and its title once it has one')
  check(captureTargets(sessions, 'beacon:gone')[1].label === 'beacon:gone', 'an unknown one in use is still listed, by id')
  const long = captureTargets([{ id: 'x', title: 'y'.repeat(80), lastActive: 1 }], 'x')[1].label
  check(long.length === 48 && long.endsWith('…'), 'a long title is cut with an ellipsis')
  const many = Array.from({ length: 80 }, (_, i) => ({ id: `s-${i}`, title: `T ${i}`, lastActive: i }))
  const m = captureTargets(many, 's-0')
  check(m.length === CAPTURE_TARGETS_MAX + 1, `the list stops at ${CAPTURE_TARGETS_MAX} conversations plus New conversation`, String(m.length))
  check(m[1].value === 's-0' && m[2].value === 's-79', 'the cap keeps the one in use and the newest')
  check(captureTargets([], CAPTURE_DEFAULT_TARGET).length === 2, 'no conversations at all still offers New conversation and Quick capture')
}

console.log('2. the stored target')
check(storedCaptureTarget(null) === CAPTURE_DEFAULT_TARGET && storedCaptureTarget('') === CAPTURE_DEFAULT_TARGET && storedCaptureTarget('  ') === CAPTURE_DEFAULT_TARGET, 'nothing stored means the standing conversation')
check(storedCaptureTarget('beacon:a') === 'beacon:a', 'a stored conversation is used')
check(storedCaptureTarget(CAPTURE_NEW_TARGET) === CAPTURE_DEFAULT_TARGET, 'a stored "new" is never a conversation id')
check(!/^[\w:.-]+$/.test(CAPTURE_NEW_TARGET), 'the "new" value cannot be mistaken for a real session id')

console.log('3. when Enter sends')
check(captureCanSend('hi', 0, false), 'text sends')
check(captureCanSend('', 1, false) && captureCanSend('   ', 2, false), 'a file with no text sends')
check(!captureCanSend('', 0, false) && !captureCanSend(' \n ', 0, false), 'nothing to send does not')
check(!captureCanSend('hi', 1, true), 'nothing sends while a send is going out')

console.log('4. the screenshot list')
{
  const src = [
    { id: 'screen:1:0', name: 'Screen 1' },
    { id: 'window:42:0', name: 'Beacon' },
    { id: 'window:77:0', name: 'Beacon' }
  ]
  const ids = (l: { id: string }[]): string => l.map((s) => s.id).join(',')
  check(ids(captureSources(src, 'window:42:0')) === 'screen:1:0,window:77:0', "the quick-capture window's own row is left out, by id")
  check(captureSources(src, 'window:42:0').some((s) => s.name === 'Beacon'), 'another window with the same title (the main window) stays listed')
  check(captureSources(src, null).length === 3, 'any other window lists everything, itself included')
  check(captureSources(src, 'window:999:0').length === 3, 'an id that is not listed removes nothing')
  check(captureSources(src, null) !== src, 'the list handed back is a copy')
}

console.log('5. who is the quick-capture window, and the hold')
{
  check(isCaptureSender(7, { id: 7, destroyed: false }), 'the quick-capture window is itself')
  check(!isCaptureSender(8, { id: 7, destroyed: false }), 'any other window is not')
  check(!isCaptureSender(7, { id: 7, destroyed: true }), 'a destroyed window is not, even with the same id')
  check(!isCaptureSender(7, null), 'with no quick-capture window, nothing is')

  check(hidesOnBlur(false) === true && hidesOnBlur(true) === false, 'it hides when it loses focus, unless held')
  check(holdAfter(false, 'ask-on') === true, 'the picker opening takes the hold')
  for (const ev of ['ask-off', 'focus', 'hide', 'closed', 'timeout'] as HoldEvent[]) {
    check(holdAfter(true, ev) === false, `"${ev}" ends a hold`)
    check(holdAfter(false, ev) === false, `"${ev}" never starts one`)
  }
  check(holdAfter(false, 'shot-returned-unfocused') === true, 'a window back from a shot without focus goes on the clock')
  // The picker story, start to end: held while it is open, then the window behaves as before.
  let held = false
  held = holdAfter(held, 'ask-on')
  check(!hidesOnBlur(held), 'picker open: the blur it causes does not hide the window')
  held = holdAfter(held, 'ask-off')
  check(hidesOnBlur(held), 'picker answered: the next blur hides it, with no focus event needed')
  check(hidesOnHoldTimeout(true, false) && !hidesOnHoldTimeout(true, true) && !hidesOnHoldTimeout(false, false), 'a hold that times out hides the window only if it is up without focus')
  check(CAPTURE_HOLD_MAX_MS >= 30_000 && CAPTURE_HOLD_MAX_MS <= 300_000, 'a hold ends by itself within a few minutes')
  check(toggleAllowed(false) && !toggleAllowed(true), 'the toggle does nothing during a screenshot')
}

console.log('6. after a send that did not all go out')
{
  const files = ['a.png', 'b.pdf', 'c.txt']
  const none = restoreAfterFailedSend('caption', files, 0, { draft: '', files: [] })
  check(none.draft === 'caption' && none.files.join() === 'a.png,b.pdf,c.txt', 'nothing went: the text and every file come back')
  const one = restoreAfterFailedSend('caption', files, 1, { draft: '', files: [] })
  check(one.files.join() === 'b.pdf,c.txt', 'one went: it is not offered again (a retry would send it twice)')
  check(one.draft === 'caption', 'the text rides on the last file, so it comes back with the rest')
  const typed = restoreAfterFailedSend('caption', files, 2, { draft: 'next thought', files: ['new.jpg'] })
  check(typed.draft === 'caption\nnext thought', 'what was typed while it was sending is kept, after the text put back')
  check(typed.files.join() === 'c.txt,new.jpg', 'and a file attached meanwhile is kept, after the unsent one')
  check(restoreAfterFailedSend('', files, 0, { draft: 'kept', files: [] }).draft === 'kept', 'no text was sent: the new draft is left as it is')
  check(restoreAfterFailedSend('only text', [], 0, { draft: '   ', files: [] }).draft === 'only text', 'a blank draft is replaced, not prefixed')
  check(restoreAfterFailedSend('t', files, 99, { draft: '', files: [] }).files.length === 0 && restoreAfterFailedSend('t', files, -3, { draft: '', files: [] }).files.length === 3, 'a count out of range is clamped')
  check(escClosesBox(false) && !escClosesBox(true), 'Esc closes the box, but not while a send is going out')
}

console.log('7. the call sites go through the rules')
{
  const root = process.cwd()
  const main = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
  const fn = main.slice(main.indexOf('function fromCaptureWindow('), main.indexOf('function toggleCaptureWindow('))
  check(/return isCaptureSender\(sender\.id,/.test(fn), 'main decides the sender with isCaptureSender')
  const hold = main.slice(main.indexOf('onFromShell(IPC.CAPTURE_HOLD'), main.indexOf('handleFromShell(IPC.CAPTURE_SHOT'))
  check(/if \(fromCaptureWindow\(e\.sender\)\) holdCapture\(on === true \? 'ask-on' : 'ask-off'\)/.test(hold), 'a hold is taken, and given back, only by the quick-capture window')
  const shot = main.slice(main.indexOf('handleFromShell(IPC.CAPTURE_SHOT'), main.indexOf('onFromShell(IPC.CAPTURE_OPEN_MAIN'))
  check(/!fromCaptureWindow\(e\.sender\)\) return \{ ok: false/.test(shot), 'a shot is refused from any other window')
  check(/if \(captureShooting\) return \{ ok: false/.test(shot), 'and while another shot is being taken')
  const at = (needle: string): number => shot.indexOf(needle)
  check(at('captureShooting = true') > 0 && at('captureShooting = true') < at('win.hide()') && at('win.hide()') < at('grabSource('), 'the window is marked, then hidden, then the grab runs')
  check(/finally \{\s*captureShooting = false[\s\S]*win\.show\(\)/.test(shot), 'and it comes back, unmarked, whether the grab worked or not')
  check(/if \(!win\.isFocused\(\)\) holdCapture\('shot-returned-unfocused'\)/.test(shot), 'a window that came back without focus is put on the clock')
  const toggle = main.slice(main.indexOf('function toggleCaptureWindow('), main.indexOf('function toggleCaptureWindow(') + 400)
  check(/if \(!toggleAllowed\(captureShooting\)\) return/.test(toggle), 'the toggle asks the rule before it shows the box')
  check(/win\.on\('blur', \(\) => \{\s*if \(hidesOnBlur\(captureHeld\(\)\)\) win\.hide\(\)/.test(main), "the window's blur handler asks the rule")
  check(/holdAfter\(captureHeld\(\), ev\)/.test(main) && /hidesOnHoldTimeout\(win\.isVisible\(\), win\.isFocused\(\)\)/.test(main), 'the hold itself is the state machine above')
  const view = readFileSync(join(root, 'src/renderer/src/components/QuickCapture.tsx'), 'utf8')
  check(!/onDrop|onDragOver/.test(view), 'no drop target is offered (the window hides when another app is clicked)')
  check(/capture\.hold\(true\)\s*\n\s*fileInputRef\.current\?\.click\(\)/.test(view), 'the hold is asked for right before the file picker opens')
  check(/addEventListener\('cancel', release\)/.test(view) && /addEventListener\('change', release\)/.test(view) && /capture\.hold\(false\)/.test(view), 'and given back when the picker answers, either way')
  check((view.match(/restoreAfterFailedSend\(/g) ?? []).length === 2 && /err instanceof UploadError \? err\.sent : 0/.test(view), 'a failed send puts back through the rule, with how many files went')
  check(/if \(!escClosesBox\(sending\)\) return/.test(view), 'Esc asks the rule before closing')
  check(/res\.status === 'not-connected'/.test(view), "a text send's answer is read, not assumed")
  const io = readFileSync(join(root, 'src/renderer/src/attachments-io.ts'), 'utf8')
  check(/throw new UploadError\('not connected', i\)/.test(io), 'the upload loop says how many files went before it failed')
  check(classifiedScope(CAPTURE_TARGET_KEY) === 'prometheus', 'the last target is kept with its Prometheus')
}
