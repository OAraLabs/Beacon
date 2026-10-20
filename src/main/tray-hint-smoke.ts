/**
 * Headless smoke for the close-to-tray decision (@shared/tray-hint).
 *
 * Proves the MODEL — the full truth table of planClose (quitting outranks the setting; the setting
 * decides hide-vs-quit; the hint fires exactly once, only on a hide) — and the copy that teaches it.
 * Then proves main WIRES it: the close handler consults planClose rather than the old inline
 * `if (!isQuitting) hide()`, the hint is persisted only after it is shown, and the close-mode setting
 * round-trips through the IPC handlers. Source-regex half, same limits and same reasoning as
 * badge-smoke and notification-prefs-smoke.
 *
 *   npm run build && npm run smoke:tray-hint
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { planClose, trayHintNotification } from '@shared/tray-hint'

let failures = 0
function assert(cond: boolean, what: string, detail = ''): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${what}${detail && !cond ? `\n        ${detail}` : ''}`)
  if (!cond) failures++
}

console.log('[smoke] === the truth table: default user, first close ===')
{
  const d = planClose({ isQuitting: false, closeToTray: true, hintShown: false })
  assert(d.action === 'hide', '✕ hides to tray (today\'s behavior preserved)')
  assert(d.showHint === true, '...and TEACHES it the first time — the silent vanish was the bug')
}

console.log('\n[smoke] === the hint fires exactly once ===')
{
  const second = planClose({ isQuitting: false, closeToTray: true, hintShown: true })
  assert(second.action === 'hide' && second.showHint === false, 'every close after the first hides SILENTLY — a hint on every ✕ becomes the new thing to hate')
}

console.log('\n[smoke] === quitting outranks everything ===')
{
  const q1 = planClose({ isQuitting: true, closeToTray: true, hintShown: false })
  assert(q1.action === 'quit' && q1.showHint === false, 'tray Quit / ⌘Q mid-first-run: no hint on the way out the door')
  const q2 = planClose({ isQuitting: true, closeToTray: false, hintShown: false })
  assert(q2.action === 'quit' && q2.showHint === false, 'quitting with close-mode=quit: same, no hint')
}

console.log('\n[smoke] === the ✕-means-quit user is respected plainly ===')
{
  const x1 = planClose({ isQuitting: false, closeToTray: false, hintShown: false })
  assert(x1.action === 'quit' && x1.showHint === false, 'close-mode=quit → ✕ really quits — a tray apologist would still hide here, which is the surprise the setting exists to remove')
  const x2 = planClose({ isQuitting: false, closeToTray: false, hintShown: true })
  assert(x2.action === 'quit', 'and keeps quitting after a switch back (hintShown is irrelevant on the quit path)')
}

console.log('\n[smoke] === the coach copy does its whole job ===')
{
  const hint = trayHintNotification()
  assert(hint.title.length > 0 && hint.body.length > 0, 'non-empty title and body')
  assert(/still running/i.test(hint.title), 'the title answers the panic ("did it crash?") — it says STILL RUNNING')
  assert(/tray/i.test(hint.body), 'the body says WHERE it went')
  assert(/quit/i.test(hint.body), 'and HOW to actually leave — an escape hatch in the same sentence, so the hint cannot read as a trap')
  assert(hint.body.length <= 250, 'the body fits a native notification (macOS truncates ~250 chars)')
}

console.log('\n[smoke] === main wires the model ===')
{
  const mainSrc = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
  assert(/planClose\(\{/.test(mainSrc), 'the close handler consults planClose — the truth table lives in the model, not inline')
  assert(mainSrc.includes("decision.action === 'hide'"), 'main acts on the decision: the hide branch is the one that preventDefaults, everything else falls through to quit')
  assert(mainSrc.includes('decision.showHint'), 'and on showHint')
  assert(mainSrc.includes('trayHintNotification()'), 'the coach copy comes from the model — one home for the wording')
  // The persistence must be INSIDE the showHint branch and inside the isSupported() block, so where no
  // notification can be raised the row stays unset and the next hide tries again. (macOS gives no
  // failure signal for a denied permission, so there the one shot is spent — that is not asserted as a
  // retry.) Assert by position: guard, then isSupported(), then the raise, then setSetting.
  // Slice to the handler's real end (the next win.on registration), not a fixed width — the quit path
  // made it longer than any constant I'd pick, and a truncating slice silently drops the assertions on
  // its tail, which is how a check passes for the wrong reason.
  const handlerStart = mainSrc.indexOf("win.on('close'")
  const handlerEnd = mainSrc.indexOf("win.on('closed'", handlerStart)
  const handler = mainSrc.slice(handlerStart, handlerEnd)
  assert(handlerStart > -1 && handlerEnd > handlerStart && handler.length > 0, 'the close handler was located and sliced to its end')
  const guardIdx = handler.indexOf('if (decision.showHint)')
  const supportedIdx = handler.indexOf('if (Notification.isSupported()) {')
  const persistIdx = handler.indexOf(`setSetting(TRAY_HINT_SHOWN_KEY`)
  const notifyIdx = handler.indexOf('new Notification(')
  // Containment, not just order: "after the raise" is also true of a save placed just past the
  // block's closing brace, which persists even where nothing was raised. Match the block's braces.
  const blockOpen = supportedIdx > -1 ? handler.indexOf('{', supportedIdx) : -1
  let blockClose = -1
  for (let i = blockOpen, depth = 0; blockOpen > -1 && i < handler.length; i++) {
    if (handler[i] === '{') depth++
    else if (handler[i] === '}' && --depth === 0) { blockClose = i; break }
  }
  assert(
    guardIdx > -1 && supportedIdx > guardIdx && notifyIdx > supportedIdx && persistIdx > notifyIdx && blockClose > persistIdx,
    'the hint row is persisted only inside the showHint branch AND inside the isSupported() block, after the raise — where no notification can be raised, the row stays unset and the next hide tries again'
  )
  // Quitting: before-quit closes the cache DB before any window's 'close' fires, so the handler must
  // bail out before its first DB read. Without this, every ⌘Q / tray Quit threw in main.
  const bailIdx = handler.indexOf('if (isQuitting) return')
  const readIdx = handler.indexOf('repo?.getSetting(')
  assert(bailIdx > -1 && readIdx > bailIdx, 'the close handler returns on a committed quit BEFORE its first repo read — the DB is already closed by then')
  assert(handler.includes('repo?.getSetting(TRAY_HINT_SHOWN_KEY)'), 'hintShown is read from the durable row, not memory — a relaunch must not re-teach')
  assert(mainSrc.includes('loadCloseMode()'), 'main loads the close mode at startup, before the first close can happen')
  assert(mainSrc.includes('CLOSE_MODE_KEY') && mainSrc.includes(`closeToTray = raw !== 'quit'`), "anything other than an explicit 'quit' row means hide — an unreadable setting degrades to today's behavior")
  // The ✕-means-quit path must COMMIT the quit. `window-all-closed` is a deliberate no-op (tray
  // persistence), so merely letting the close through would leave the app running headless with no
  // window — the exact bug this setting exists to remove. Scope the check to the `if (!isQuitting)`
  // block itself: a whole-handler indexOf would match the `app.quit()` in the comment above it and
  // report the wrong order — a positional assertion has to look at CODE, not prose that names the call.
  const quitBlockStart = handler.lastIndexOf('if (!isQuitting)')
  const quitBlock = handler.slice(quitBlockStart)
  const commitQuitIdx = quitBlock.indexOf('isQuitting = true')
  const appQuitIdx = quitBlock.indexOf('app.quit()')
  assert(quitBlockStart > -1, 'the quit path has an `if (!isQuitting)` guard — re-entrant closes from app.quit() must not re-commit')
  assert(commitQuitIdx > -1 && appQuitIdx > commitQuitIdx, "the quit path commits: isQuitting = true THEN app.quit() — otherwise window-all-closed's no-op strands the app headless")
  assert(/window-all-closed[\s\S]{0,200}do NOT quit/.test(mainSrc), 'and window-all-closed is still the deliberate no-op it always was — the fix belongs in the close handler, not by making window-all-closed quit (that would break tray persistence)')
}

console.log(`\n[smoke] outcome: ${failures === 0 ? 'PASS ✓' : `FAIL ✗ (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
