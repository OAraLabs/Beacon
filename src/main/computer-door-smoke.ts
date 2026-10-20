/**
 * computer-door smoke — the pure decisions behind starting a desktop task and picking an app
 * (v1.1 PR 7, door routes). FAIL-LOUD + count-guarded, like theme-smoke.
 *
 * The two rules that matter, and why they are asserted rather than trusted:
 *
 * 1. THE DAEMON'S WORDS WIN. A door refusal carries `detail` — the sentence `DoorRefused` wrote
 *    for a person. Beacon renders it VERBATIM and marks it as such; its own words are only a
 *    fallback for a body that named a code with no sentence. Two surfaces computing the same
 *    sentence is the defect SPRINT-CONSENT removed from the approval card.
 *
 * 2. THE TEXT IS NEVER TAKEN FROM THE GOAL. `text_to_type` must come from the caller and never
 *    from the chooser (candidates.py), and the approval prompt shows `arguments` — so text parsed
 *    out of a goal would reach the keyboard without ever having been shown for approval.
 *
 * 3. `needs_app` is the consent step, not an error: it carries the picker's rows, and the UI shows
 *    a picker. An app the daemon did NOT offer is never pre-selected.
 */
import { readFileSync } from 'node:fs'
import {
  DOOR_CODES,
  EMPTY_BINDING,
  EMPTY_START_FORM,
  bindingFromWire,
  computerTaskStartBody,
  doorRefusal,
  isNeedsApp,
  pickerRows,
  startFormError
} from '@shared/computer-door'

let failures = 0
let checks = 0
function assert(cond: boolean, label: string): void {
  checks++
  console.log(`[computer-door-smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}

// A COUNT GUARD: every assertion below is a top-level call, so a rename that stopped a section
// running would reduce this count silently and still print PASS. The two halves are ~55 model
// checks and ~28 wiring checks; the floor sits above the larger half so EITHER half vanishing
// trips it, with a small margin for trimming. Move it with the checks.
const MIN_CHECKS = 78

function main(): void {
  console.log('\n=== 1. the refusal vocabulary is complete and closed ===')
  assert(DOOR_CODES.length === 7, `the door's codes are the seven the daemon can send (got ${DOOR_CODES.length})`)
  assert(new Set(DOOR_CODES).size === DOOR_CODES.length, 'no code is listed twice')
  assert(DOOR_CODES.includes('needs_app') && DOOR_CODES.includes('not_a_person'),
    'the two codes the UI branches on are both declared')

  console.log('\n=== 2. the daemon\'s own sentence wins, verbatim ===')
  const withDetail = doorRefusal(409, { error: 'busy', detail: 'A task is already running here.' })
  assert(withDetail.message === 'A task is already running here.', 'the daemon\'s detail is shown as-is')
  assert(withDetail.fromDaemon === true, '...and is marked as the daemon\'s words, not Beacon\'s')
  assert(withDetail.code === 'busy', 'the machine code rides through untouched')

  const multiLine = doorRefusal(400, { error: 'refused', detail: 'one   two\n\nthree' })
  assert(multiLine.message === 'one two three', 'whitespace in the daemon\'s sentence is collapsed for one line')

  console.log('\n=== 3. a code with no sentence gets Beacon\'s fallback, and says so ===')
  const bare = doorRefusal(401, { error: 'not_a_person' })
  assert(bare.message.length > 10, 'a code with no detail still yields a sentence')
  assert(bare.fromDaemon === false, '...and it is NOT claimed to be the daemon\'s words')
  assert(bare.message.includes('person'), 'the fallback for not_a_person names the actual rule')

  console.log('\n=== 4. an unknown code renders as itself, never blank ===')
  const unknown = doorRefusal(500, { error: 'a_code_never_seen' })
  assert(unknown.message.length > 0, 'an unmapped code still says something')
  assert(unknown.fromDaemon === false, 'an unmapped code is not presented as the daemon\'s sentence')
  const noBody = doorRefusal(502, null)
  assert(noBody.code === 'http_502', 'a body-less HTTP failure is named by its status')
  assert(noBody.message.length > 0, '...and still has a sentence')

  console.log('\n=== 5. retryable is exactly the codes where retrying could help ===')
  assert(doorRefusal(503, { error: 'integration_down' }).retryable === true, 'a driver that is not ready may come back')
  assert(doorRefusal(409, { error: 'busy' }).retryable === true, 'a running task ends, so busy is transient')
  assert(doorRefusal(401, { error: 'not_a_person' }).retryable === false,
    'not_a_person is permanent — offering Retry would be a control that cannot work')
  assert(doorRefusal(404, { error: 'computer_use_off' }).retryable === false, 'the feature being off does not fix itself')
  assert(doorRefusal(403, { error: 'in_tool_call' }).retryable === false, 'a tool-context start is refused identically every time')
  assert(doorRefusal(0, {}).code === 'http_0' && doorRefusal(0, {}).retryable === false,
    'a non-retryable HTTP shape is not mistaken for a network blip')

  console.log('\n=== 6. needs_app is the consent step and carries the picker ===')
  const needsApp = doorRefusal(409, {
    error: 'needs_app',
    detail: 'Which app should I use?',
    options: ['gedit', 'Firefox'],
    describes: 'Clicks and Tab/Escape in gedit only.',
    app: 'gedit'
  })
  assert(isNeedsApp(needsApp), 'isNeedsApp identifies the pick-me refusal')
  assert(needsApp.options.join(',') === 'gedit,Firefox', 'the picker rows are the daemon\'s, in its order')
  assert(needsApp.describes === 'Clicks and Tab/Escape in gedit only.', 'the daemon\'s coverage sentence is kept verbatim')
  assert(needsApp.app === 'gedit', 'the app the daemon matched is pre-selected')
  assert(isNeedsApp(doorRefusal(409, { error: 'busy' })) === false, 'a different 409 is not a pick-me')

  console.log('\n=== 7. an app the daemon did NOT offer is never pre-selected ===')
  const notOffered = doorRefusal(409, { error: 'needs_app', options: ['gedit'], app: 'Safari' })
  assert(notOffered.app === null,
    'pre-selecting an app outside the list would look like a pick the person never saw')
  const junkOptions = doorRefusal(409, { error: 'needs_app', options: ['gedit', '', null, 7, 'gedit'] })
  assert(junkOptions.options.join(',') === 'gedit', 'non-string and empty options are dropped, not rendered')

  console.log('\n=== 8. the binding view: off is the normal case, and never throws ===')
  assert(bindingFromWire({ state: 'off', session_id: 's' }).on === false, 'state:off reads as off')
  assert(bindingFromWire(null) === EMPTY_BINDING, 'a null payload is the empty binding, not a crash')
  assert(bindingFromWire('nonsense').on === false, 'a wrong-typed payload degrades to off')
  assert(bindingFromWire({}).on === false, 'an empty object is off')
  assert(bindingFromWire({ state: 'ON' }).on === false, 'only the exact string "on" counts as on')

  const on = bindingFromWire({
    state: 'on', app: 'gedit', scope: 'session', covers: ['click', 'press_key:tab'],
    describes: 'Clicks and Tab in gedit.', set_by: { surface: 'beacon' }, expires_at: 1_800_000_000
  })
  assert(on.on === true && on.app === 'gedit', 'an on binding carries the app')
  assert(on.covers.join(',') === 'click,press_key:tab', 'what it covers is the daemon\'s list')
  assert(on.describes === 'Clicks and Tab in gedit.', 'the coverage sentence is verbatim')
  assert(on.surface === 'beacon', 'where the pick was made is the daemon\'s word')
  assert(on.expiresAt === 1_800_000_000_000,
    'the daemon\'s expiry is epoch SECONDS, so it is ×1000 — Beacon never recomputes it locally')
  const noExpiry = bindingFromWire({ state: 'on', app: 'gedit', expires_at: 'soon' })
  assert(noExpiry.expiresAt === null, 'a wrong-typed expiry is null, not NaN and not a guess')

  console.log('\n=== 9. the start form: the goal is the only requirement ===')
  assert(startFormError(EMPTY_START_FORM) !== null, 'an empty form cannot be sent')
  assert(startFormError({ goal: '   ', text: '', app: '' }) !== null, 'a whitespace goal cannot be sent')
  assert(startFormError({ goal: 'press Tab in the editor', text: '', app: '' }) === null,
    'a goal alone is enough — the app may be asked for, which is a conversation not an error')
  assert(startFormError({ goal: 'type it', text: '', app: '' }) === null,
    'text is optional: nothing to type is a legitimate task')

  console.log('\n=== 10. THE TEXT IS NEVER TAKEN FROM THE GOAL ===')
  const body = computerTaskStartBody(
    { goal: 'type hello into the search box', text: '', app: '' }, 'sess-1')
  assert(body.goal === 'type hello into the search box', 'the goal is sent as the goal')
  assert(!('text' in body), 'no text is sent when none was entered — the goal is NOT parsed for one')
  assert(!('app' in body), 'an empty app is omitted, not sent as "" (absent means use the binding)')
  assert(body.session_id === 'sess-1', 'the session rides along')

  const withText = computerTaskStartBody(
    { goal: 'search for it', text: 'hello world', app: 'Firefox' }, 'sess-2')
  assert(withText.text === 'hello world', 'text the person typed is sent')
  assert(withText.app === 'Firefox', 'an app the person picked is sent')
  assert(withText.goal === 'search for it', 'the goal is not merged into the text')
  assert(!JSON.stringify(withText).includes('search for it hello'),
    'the goal and the text stay separate fields on the wire')

  const padded = computerTaskStartBody({ goal: '  a   b  ', text: '  x  ', app: '  ' }, 's')
  assert(padded.goal === 'a b', 'the goal is normalised the way the daemon normalises it')
  assert(padded.text === 'x', 'the text is trimmed')
  assert(!('app' in padded), 'a whitespace-only app is omitted')

  console.log('\n=== 11. the picker rows are de-duplicated, in order ===')
  assert(pickerRows(['b', 'a', 'b', '  a  ', '', 'c']).join(',') === 'b,a,c',
    'dupes collapse (after trimming) and the daemon\'s order is kept')
  assert(pickerRows([]).join(',') === '', 'no apps is no rows, not a crash')

  console.log('\n=== 12. the renderer is WIRED to the model (source check) ===')
  // The model above is only half the claim: a correct computerTaskStartBody that no component
  // calls renders a dead door. A smoke cannot mount a window, so the wiring is asserted from
  // source — the house pattern. Every slice asserts its own length first, because an indexOf
  // that misses returns '' and would pass the next check vacuously.
  {
    const pane = readFileSync(new URL('../../src/renderer/src/components/ProgressPane.tsx', import.meta.url), 'utf8')
    const ipc = readFileSync(new URL('../../src/main/ipc.ts', import.meta.url), 'utf8')
    const rest = readFileSync(new URL('../../src/main/connection/rest.ts', import.meta.url), 'utf8')

    // The component exists and is mounted in the no-task state.
    const doorIdx = pane.indexOf('function ComputerDoor(')
    assert(doorIdx !== -1, 'ComputerDoor is defined in the pane')
    assert(pane.includes('<ComputerDoor sessionId={sessionId}'), 'ComputerDoor is mounted (not dead code)')

    // It renders through the model, never a second hand-rolled decision.
    assert(pane.includes('computerTaskStartBody('), 'the start button builds its body through the model')
    assert(pane.includes('startFormError('), 'the form is validated by the model, not an inline truthiness check')
    assert(pane.includes('pickerRows('), 'the picker rows come from the model')
    assert(pane.includes('isNeedsApp('), 'a needs_app refusal opens the picker rather than showing an error')

    // The refusal is RENDERED, not thrown: the daemon's message reaches the screen.
    const refIdx = pane.indexOf('refused.message')
    assert(refIdx !== -1, 'the component renders the refusal message')
    assert(pane.slice(refIdx, refIdx + 400).includes('refused.describes'),
      '...and the daemon\'s coverage sentence beside it')
    // A non-retryable refusal must not offer a control that cannot work.
    assert(pane.includes('refused.retryable ?'), 'Retry/Dismiss is offered only where retrying could help')

    // The five IPC handlers exist, and each reaches the connection (not a stub). The window is
    // this handler's whole body — from its IPC key to the NEXT handleFromShell — not a fixed
    // character count: the handlers with more input validation call `conn.` several hundred
    // chars in, and a fixed window would pass or fail on how much validation precedes the call
    // rather than on whether the call is there.
    const doorKeys = ['COMPUTER_APPS', 'COMPUTER_BINDING_GET', 'COMPUTER_BINDING_SET',
      'COMPUTER_BINDING_CLEAR', 'COMPUTER_TASK_START'] as const
    for (const key of doorKeys) {
      const hIdx = ipc.indexOf(`IPC.${key},`)
      assert(hIdx !== -1, `main registers a handler for ${key}`)
      const next = ipc.indexOf('handleFromShell(', hIdx + 1)
      const body = ipc.slice(hIdx, next === -1 ? undefined : next)
      assert(body.length > 20, `the ${key} handler body was located (${body.length} chars)`)
      assert(/conn\.(listComputerApps|getComputerBinding|setComputerBinding|clearComputerBinding|startComputerTask)/.test(body),
        `${key}'s handler calls the connection, not a placeholder`)
    }

    // The REST layer talks to the real routes and does NOT flatten a refusal into a thrown Error.
    assert(rest.includes('/api/computer/apps'), 'the REST layer hits GET /api/computer/apps')
    assert(rest.includes('/api/computer/tasks') && rest.includes('startComputerTask'), 'the REST layer starts a task')
    assert(rest.includes('doorRefusal(res.status, parsed)'), 'a non-2xx becomes a structured refusal, not a thrown Error')
    // A door refusal must not flip the app-wide REST auth state (see the note in connection/index.ts).
    const conn = readFileSync(new URL('../../src/main/connection/index.ts', import.meta.url), 'utf8')
    const listIdx = conn.indexOf('listComputerApps()')
    assert(listIdx !== -1 && !conn.slice(listIdx, listIdx + 120).includes('trackAuth'),
      'the door wrappers do NOT use trackAuth — a per-route 401 is not an app-wide auth failure')
  }

  if (checks < MIN_CHECKS) {
    failures++
    console.error(`[computer-door-smoke] FAIL only ${checks} checks ran, expected at least ${MIN_CHECKS} — a section stopped running`)
  }
  console.log(failures === 0
    ? `\n[computer-door-smoke] PASS (${checks} checks)`
    : `\n[computer-door-smoke] FAIL (${failures} of ${checks})`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
