/**
 * quick-capture-smoke — the quick-capture window's pure model (@shared/quick-capture), headless.
 *
 *   1. the target list: a new conversation first, the one in use always listed, then the most
 *      recent by title, capped;
 *   2. the stored target a window starts on;
 *   3. when Enter sends;
 *   4. the screenshot list leaves out the asking window only when it is the quick-capture window;
 *   5. the blur rule and the hold;
 *   6. on the source: the hold and the shot are refused from any other window, the shot hides the
 *      window before it grabs, and the settings key is the one @shared/daemon-profiles classifies.
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
  hidesOnBlur,
  storedCaptureTarget
} from '@shared/quick-capture'

const MIN_CHECKS = 30
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
  } else console.log(`quick-capture smoke: PASS ✓ (${checks} checks: targets, stored target, send, sources, hold, wiring)`)
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
  const src = [{ id: 'screen:1:0' }, { id: 'window:42:0' }, { id: 'window:77:0' }]
  check(captureSources(src, 'window:42:0').map((s) => s.id).join(',') === 'screen:1:0,window:77:0', "the quick-capture window's own row is left out")
  check(captureSources(src, null).length === 3, 'any other window lists everything, itself included')
  check(captureSources(src, 'window:999:0').length === 3, 'an id that is not listed removes nothing')
  check(captureSources(src, null) !== src, 'the list handed back is a copy')
}

console.log('5. the blur rule')
check(hidesOnBlur(false) === true, 'it hides when it loses focus')
check(hidesOnBlur(true) === false, 'unless it is held')
check(CAPTURE_HOLD_MAX_MS >= 30_000 && CAPTURE_HOLD_MAX_MS <= 300_000, 'a hold ends by itself within a few minutes')

console.log('6. the wiring, on the source')
{
  const root = process.cwd()
  const main = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
  const hold = main.slice(main.indexOf('onFromShell(IPC.CAPTURE_HOLD'), main.indexOf('handleFromShell(IPC.CAPTURE_SHOT'))
  check(hold.length > 0 && /if \(fromCapture\(e\.sender\)\) holdCapture\(/.test(hold), 'a hold is taken only from the quick-capture window')
  const shot = main.slice(main.indexOf('handleFromShell(IPC.CAPTURE_SHOT'), main.indexOf('onFromShell(IPC.CAPTURE_OPEN_MAIN'))
  check(shot.length > 0 && /!fromCapture\(e\.sender\)\) return \{ ok: false/.test(shot), 'a shot is refused from any other window')
  check(shot.indexOf('win.hide()') > 0 && shot.indexOf('win.hide()') < shot.indexOf('grabSource('), 'the window hides before the grab, so it is not in the picture')
  check(/finally \{[\s\S]*win\.show\(\)/.test(shot), 'and comes back whether the grab worked or not')
  check(/win\.on\('blur', \(\) => \{\s*if \(hidesOnBlur\(captureHeld\(\)\)\) win\.hide\(\)/.test(main), "the window's blur handler asks the rule")
  check(/win\.on\('focus', \(\) => holdCapture\(false\)\)/.test(main), 'focus coming back ends the hold')
  const view = readFileSync(join(root, 'src/renderer/src/components/QuickCapture.tsx'), 'utf8')
  check(!/onDrop|onDragOver/.test(view), 'no drop target is offered (the window hides when another app is clicked)')
  check(/capture\.hold\(true\)\s*\n\s*fileInputRef\.current\?\.click\(\)/.test(view), 'the hold is asked for right before the file picker opens')
  check(classifiedScope(CAPTURE_TARGET_KEY) === 'prometheus', 'the last target is kept with its Prometheus')
}
