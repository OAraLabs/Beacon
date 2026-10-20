/**
 * Headless smoke for launch-at-login (@shared/login-item).
 *
 * Proves the MODEL exhaustively — which platforms/builds can honour the switch, the win32 readback
 * rule (executableWillLaunchAtLogin over openAtLogin, which is the load-bearing one), the two
 * "on but silently won't launch" states, and that a null/hostile OS report degrades to off rather
 * than throwing. Then proves main WIRES it and GATES the OS call the same way (the defect a pure
 * model can't catch — a correct model wired to nothing, or wired without the isPackaged gate so a dev
 * build registers the raw electron binary).
 *
 * WHAT THIS CANNOT PROVE, honestly: that app.setLoginItemSettings actually registers with the OS.
 * That API is @platform darwin,win32 — a silent no-op on this Linux CI — so the real registration is
 * a Mac/Windows step (named in the PR). The source half below asserts main calls it behind the SAME
 * gate the model decides, which is the most headless Linux can verify.
 *
 *   npm run build && npm run smoke:login-item
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  UNSUPPORTED_PLATFORM_REASON,
  UNPACKAGED_REASON,
  describeLoginItem,
  loginItemNote,
  platformSupported,
  unavailableReason
} from '@shared/login-item'

let failures = 0
function assert(cond: boolean, what: string, detail = ''): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${what}${detail && !cond ? `\n        ${detail}` : ''}`)
  if (!cond) failures++
}

/** A macOS report shaped exactly as Electron 44 builds it (browser_mac.mm:390, v44.4.1). */
function electronMacReport(status: string): { openAtLogin: boolean; status: string } {
  return { openAtLogin: status === 'enabled', status }
}
const approvalState = (): ReturnType<typeof describeLoginItem> => describeLoginItem('darwin', true, electronMacReport('requires-approval'))

console.log('[smoke] === which platforms can honour the switch ===')
assert(platformSupported('darwin') === true, 'macOS is supported (SMAppService / login items)')
assert(platformSupported('win32') === true, 'Windows is supported (run key)')
assert(platformSupported('linux') === false, 'Linux is NOT — app.setLoginItemSettings is @platform darwin,win32; on Linux it is a silent no-op, so a toggle there would be a dead control')

console.log('\n[smoke] === the reason a switch is unavailable ===')
assert(unavailableReason('linux', true) === UNSUPPORTED_PLATFORM_REASON, 'Linux packaged → the platform reason')
assert(unavailableReason('linux', false) === UNSUPPORTED_PLATFORM_REASON, 'Linux UNPACKAGED → still the platform reason: platform outranks packaging, because it is the more fundamental cause and the one a reinstall cannot fix')
assert(unavailableReason('darwin', false) === UNPACKAGED_REASON, 'macOS dev build → packaged-builds-only (registering the raw electron binary as a startup item would be a lie)')
assert(unavailableReason('darwin', true) === null, 'macOS packaged → available, no reason')
assert(unavailableReason('win32', true) === null, 'Windows packaged → available')

console.log('\n[smoke] === describeLoginItem: unsupported builds never trust an OS report ===')
{
  const linux = describeLoginItem('linux', true, { openAtLogin: true })
  assert(linux.supported === false && linux.enabled === false, 'Linux with a truthy report → supported:false, enabled:false — we never trust a no-op platform\'s report')
  assert(linux.reason === UNSUPPORTED_PLATFORM_REASON, 'and carries the platform reason for the UI')
  const dev = describeLoginItem('darwin', false, { openAtLogin: true })
  assert(dev.supported === false && dev.reason === UNPACKAGED_REASON, 'a dev build → unsupported with the packaged-only reason, even if the OS somehow reported a registration')
}

console.log('\n[smoke] === macOS readback ===')
{
  const on = describeLoginItem('darwin', true, { openAtLogin: true, status: 'enabled' })
  assert(on.supported && on.enabled, 'openAtLogin:true → enabled')
  assert(on.needsApproval === false && on.deactivated === false, 'a healthy registration flags neither problem')
  const off = describeLoginItem('darwin', true, { openAtLogin: false, status: 'not-registered' })
  assert(off.enabled === false, 'openAtLogin:false → disabled')
  // The report as Electron 44 actually builds it: shell/browser/browser_mac.mm:390 (v44.4.1) sets
  // `settings.open_at_login = status == "enabled"`, so requires-approval ALWAYS arrives with
  // openAtLogin:false. (This smoke used to pass {openAtLogin:true, status:'requires-approval'}, a
  // shape Electron cannot emit, which is how the UI below shipped an unchecked box saying "On".)
  const approval = describeLoginItem('darwin', true, electronMacReport('requires-approval'))
  assert(approval.needsApproval === true, 'status:requires-approval → needsApproval surfaced — the "I turned it on and nothing happens" trap')
  assert(approval.enabled === true, 'and the switch reads ON: requires-approval means REGISTERED, waiting on the user, so unticking unregisters (ticking an unticked box would only re-register into the same state)')
  assert(approval.deactivated === false, 'and that is a macOS flag, not the Windows deactivated one')
  assert(describeLoginItem('darwin', true, electronMacReport('not-registered')).enabled === false, "Electron's not-registered → off")
  assert(describeLoginItem('darwin', true, electronMacReport('not-found')).enabled === false, "Electron's not-found → off")
  assert(describeLoginItem('darwin', true, electronMacReport('enabled')).enabled === true, "Electron's enabled → on")
}

console.log('\n[smoke] === the switch and its note never disagree ===')
{
  // Every report Electron can hand us, on every platform/build, and the note each one renders.
  const reports: Array<[string, ReturnType<typeof describeLoginItem>]> = []
  for (const status of ['enabled', 'not-registered', 'requires-approval', 'not-found'])
    reports.push([`darwin ${status}`, describeLoginItem('darwin', true, electronMacReport(status))])
  for (const open of [true, false])
    for (const will of [true, false, undefined])
      reports.push([`win32 open=${open} will=${will}`, describeLoginItem('win32', true, { openAtLogin: open, ...(will === undefined ? {} : { executableWillLaunchAtLogin: will }) })])
  reports.push(['darwin dev build', describeLoginItem('darwin', false, null)], ['linux', describeLoginItem('linux', true, null)])
  for (const [label, st] of reports) {
    const note = loginItemNote(st)
    assert(!/^On\b/.test(note) || st.enabled, `${label}: a note saying "On" sits beside a TICKED box (enabled=${st.enabled}, note ${JSON.stringify(note.slice(0, 40))})`)
  }
  assert(/approve/i.test(loginItemNote(approvalState())), 'the requires-approval note still says what to do')
  const settingsSrc = readFileSync(join(process.cwd(), 'src/renderer/src/components/ConnectionSettings.tsx'), 'utf8')
  assert(/const note = loginItemNote\(st\)/.test(settingsSrc), 'the Settings section renders loginItemNote — the note the check above holds against the switch')
}

console.log('\n[smoke] === Windows readback: executableWillLaunchAtLogin is the honest one ===')
{
  // The load-bearing rule. openAtLogin on win32 is true only if the exe AND args match what we'd
  // write, so it can read FALSE while the app really launches. executableWillLaunchAtLogin ignores
  // args and is the truth. Getting this backwards shows the switch off for a user who has it on.
  const willLaunch = describeLoginItem('win32', true, { openAtLogin: false, executableWillLaunchAtLogin: true })
  assert(willLaunch.enabled === true, 'openAtLogin:false BUT executableWillLaunchAtLogin:true → ENABLED — the args-agnostic readback wins, so the switch reflects reality')
  const bothTrue = describeLoginItem('win32', true, { openAtLogin: true, executableWillLaunchAtLogin: true })
  assert(bothTrue.enabled === true, 'both true → enabled')
  const deactivated = describeLoginItem('win32', true, { openAtLogin: true, executableWillLaunchAtLogin: false })
  assert(deactivated.enabled === false, 'openAtLogin:true but the run key is deactivated → NOT enabled (it will not launch)')
  assert(deactivated.deactivated === true, 'and that reads as the deactivated trap, not a plain off')
  // Fallback when the honest field is absent (malformed report) → openAtLogin, never a crash.
  const fallback = describeLoginItem('win32', true, { openAtLogin: true })
  assert(fallback.enabled === true && fallback.deactivated === false, 'executableWillLaunchAtLogin absent → fall back to openAtLogin (a malformed report degrades, it does not throw)')
  const fallbackOff = describeLoginItem('win32', true, { openAtLogin: false })
  assert(fallbackOff.enabled === false, 'fallback with openAtLogin:false → disabled')
}

console.log('\n[smoke] === a missing or hostile OS report degrades to OFF, never throws ===')
{
  const nullReport = describeLoginItem('darwin', true, null)
  assert(nullReport.supported === true && nullReport.enabled === false, 'null report on a supported platform → enabled:false (off is the safe default; the user can turn it on)')
  assert(nullReport.reason === null, 'and it is NOT flagged unsupported — a null report is not an unsupported platform')
  const empty = describeLoginItem('darwin', true, {})
  assert(empty.enabled === false && empty.needsApproval === false, 'an empty report → all-off, no flags')
  const junk = describeLoginItem('win32', true, { openAtLogin: 'yes' as unknown as boolean, executableWillLaunchAtLogin: null as unknown as boolean })
  assert(junk.enabled === false, 'wrong-typed win32 fields → enabled:false, not a crash (typeof guard rejects the non-boolean)')
  const statusJunk = describeLoginItem('darwin', true, { status: 'enabled' })
  assert(statusJunk.enabled === false && statusJunk.needsApproval === false, 'a status with no openAtLogin → off, needsApproval only fires on the exact requires-approval string')
}

console.log('\n[smoke] === main wires the model AND gates the OS call identically ===')
{
  const mainSrc = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
  assert(mainSrc.includes('describeLoginItem('), 'main folds the OS report through describeLoginItem — one home for the readback rule')
  assert(mainSrc.includes('IPC.LOGIN_ITEM_GET') && mainSrc.includes('IPC.LOGIN_ITEM_SET'), 'both login-item channels are handled')
  // The SET must write only when supported, and must return the OS readback (loginItemState()), not
  // the value we asked for. Assert the gate wraps the setLoginItemSettings call.
  const setHandlerStart = mainSrc.indexOf('IPC.LOGIN_ITEM_SET')
  const setHandler = mainSrc.slice(setHandlerStart, setHandlerStart + 500)
  assert(setHandler.includes('app.setLoginItemSettings('), 'SET calls the real OS API')
  assert(/loginItemState\(\)\.supported/.test(setHandler) && setHandler.indexOf('.supported') < setHandler.indexOf('setLoginItemSettings'), 'and the OS write is GATED on supported — a Linux/dev build never calls setLoginItemSettings (silent no-op on Linux; registers the raw electron binary in dev)')
  assert(/return loginItemState\(\)/.test(setHandler), 'SET returns the OS READBACK (loginItemState()), not the requested value — what the OS kept, matching notify prefs')
  // GET must read live, never a cached row.
  const getHandler = mainSrc.slice(mainSrc.indexOf('IPC.LOGIN_ITEM_GET'), mainSrc.indexOf('IPC.LOGIN_ITEM_GET') + 120)
  assert(/loginItemState\(\)/.test(getHandler), 'GET returns a live loginItemState() read')
  assert(mainSrc.includes('app.getLoginItemSettings()'), 'main reads the OS via getLoginItemSettings (live, so a flip in System Settings / Task Manager is reflected)')
  assert(mainSrc.includes('app.isPackaged') && mainSrc.includes('describeLoginItem(platform, app.isPackaged'), 'the packaged gate is passed INTO the model, so GET and SET agree — not two copies of an isPackaged check that could drift')
  assert(!/getSetting\(['"]login/.test(mainSrc) && !/setSetting\(['"]login/.test(mainSrc), 'no login-item settings ROW is persisted — the OS is the source of truth; caching it here is exactly the drift this avoids')
}

console.log(`\n[smoke] outcome: ${failures === 0 ? 'PASS ✓' : `FAIL ✗ (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
