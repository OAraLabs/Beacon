#!/usr/bin/env node
// Launch-restore yields to a choice — structural, on MainView's source.
//
// THE BUG IT PINS SHUT. Launch-restore awaits the session list, then awaits `session:last:v1`,
// then opens that session. The list paints before the second await returns, so a row clicked (or
// New chat pressed) in between used to be replaced by the restored session a moment later. The fix:
// every path that sets the open session goes through ONE setter, `setActive`, which marks a ref;
// the restore uses the raw state setter, and only after checking that ref, with no await left
// between the check and the set.
//
// WHY STRUCTURAL. The bug is React sequencing across two IPC awaits; no smoke here renders React,
// and a timing test in node would be a model of the race, not the race. The race itself is
// `probe:launch-restore`, which drives the built app and constructs the losing interleaving by
// holding the restore's read in main. This file is the cheap floor that runs in verify: it pins the
// wiring the probe proved, including the one thing the probe cannot see — a NEW caller that sets
// the open session without going through `setActive` (the probe only exercises the paths it clicks).
//
// WHY THE COMPILER'S AST, NOT REGEX. MainView's own comments name `setActiveState` and
// `chosenSinceMount` — the comment explaining the rule contains the words the rule is about, so a
// text count would pass or fail on prose. Comments are not nodes; the parse sees only code.
//
// HOW IT KEEPS ITSELF HONEST (the error-boundary-smoke idiom): every check is a named predicate over
// the parsed source. Each runs on the real file (must hold); then each PLANTED mutation re-parses a
// mutated copy and requires the check it targets to fail. And every check must be targeted by at
// least one plant — a check no plant can fail has not shown it can fail at all.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const SRC = 'src/renderer/src/components/MainView.tsx'
const FLAG = 'chosenSinceMount'
const SETTER = 'setActive'
// Split panes (2026-10-12): the one non-choice path that may call the raw setter. A session leaving
// the screen because main opened it in its own window (a launch-restored pop-out included) is not a
// choice, and marking it would cancel launch-restore. It must not mark the flag (the "written once,
// inside setActive" check holds that) and it is the only other caller the raw-setter check allows.
const ADJUST = 'adjustLayout'

let failures = 0
function report(ok, what, detail = '') {
  console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'}  ${what}${detail && !ok ? `\n        ${detail}` : ''}`)
  if (!ok) failures++
}

/** Parse once and pull out the handful of nodes the checks talk about. Missing pieces are null;
 *  the checks treat null as "not wired", never as a crash. */
function analyze(text) {
  const sf = ts.createSourceFile('MainView.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const all = []
  const walk = (n) => {
    all.push(n)
    ts.forEachChild(n, walk)
  }
  walk(sf)
  const within = (n, anc) => !!anc && n.pos >= anc.pos && n.end <= anc.end
  const callOf = (n, name) => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name
  const isFlag = (n) => ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === FLAG && n.name.text === 'current'

  // const [active, <raw>] = useState<ChatTarget>(…)
  const state = all.find(
    (n) => ts.isVariableDeclaration(n) && ts.isArrayBindingPattern(n.name) && n.initializer && callOf(n.initializer, 'useState') && n.name.elements[0]?.name?.text === 'layout'
  )
  const rawId = state?.name.elements[1]?.name ?? null
  const raw = rawId && ts.isIdentifier(rawId) ? rawId.text : null
  const rawRefs = raw ? all.filter((n) => ts.isIdentifier(n) && n.text === raw && n !== rawId) : []

  // const chosenSinceMount = useRef(<init>)
  const ref = all.find((n) => ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === FLAG)
  const refInit = ref?.initializer && callOf(ref.initializer, 'useRef') ? ref.initializer.arguments[0] ?? null : null
  const flagWrites = all.filter((n) => ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && isFlag(n.left))

  // const setActive = useCallback((target) => { … }, …)
  const wrap = all.find((n) => ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === SETTER && n.initializer && callOf(n.initializer, 'useCallback'))
  const wrapFn = wrap?.initializer.arguments[0] ?? null
  const adjust = all.find((n) => ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === ADJUST && n.initializer && callOf(n.initializer, 'useCallback'))
  const adjustFn = adjust?.initializer.arguments[0] ?? null

  // The restore = the function that awaits settings.get(LAST_SESSION_KEY).
  const reads = all.filter(
    (n) =>
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'get' &&
      /(^|\.)settings$/.test(n.expression.expression.getText(sf)) &&
      n.arguments[0] && ts.isIdentifier(n.arguments[0]) && n.arguments[0].text === 'LAST_SESSION_KEY'
  )
  let restoreFn = null
  for (let p = reads[0]?.parent; p && !restoreFn; p = p.parent) if (ts.isArrowFunction(p) || ts.isFunctionExpression(p)) restoreFn = p
  const stmts = restoreFn && ts.isBlock(restoreFn.body) ? [...restoreFn.body.statements] : []
  const stmtOf = (n) => (n ? stmts.findIndex((s) => within(n, s)) : -1)
  const awaitsIn = (s) => all.some((n) => ts.isAwaitExpression(n) && within(n, s))
  const guard = stmts.findIndex(
    (s) =>
      ts.isIfStatement(s) &&
      isFlag(s.expression) &&
      !s.elseStatement &&
      (ts.isReturnStatement(s.thenStatement) || (ts.isBlock(s.thenStatement) && s.thenStatement.statements.length === 1 && ts.isReturnStatement(s.thenStatement.statements[0])))
  )
  const rawInRestore = rawRefs.filter((id) => within(id, restoreFn))
  const syncInRestore = all.filter((n) => callOf(n, 'syncActive') && within(n, restoreFn))

  return { raw, rawRefs, refInit, flagWrites, wrapFn, adjustFn, reads, restoreFn, stmts, stmtOf, awaitsIn, guard, rawInRestore, syncInRestore, within }
}

const isCallee = (id) => ts.isCallExpression(id.parent) && id.parent.expression === id

/** name → predicate(analysis). One copy of each; the plants below run these same functions. */
const CHECKS = {
  'launch-restore is found: exactly one function awaits settings.get(LAST_SESSION_KEY)': (a) =>
    a.reads.length === 1 && !!a.restoreFn && a.stmts.length > 0,

  'the choice flag is a ref that starts false (true would mean the restore never applies)': (a) =>
    a.refInit?.kind === ts.SyntaxKind.FalseKeyword,

  'setActive, the setter every other path uses, marks the choice and sets the raw state': (a) =>
    !!a.wrapFn &&
    a.flagWrites.some((w) => a.within(w, a.wrapFn) && w.right.kind === ts.SyntaxKind.TrueKeyword) &&
    a.rawRefs.some((id) => isCallee(id) && a.within(id, a.wrapFn)),

  'nothing un-marks the choice: the flag is written once, `= true`, inside setActive': (a) =>
    a.flagWrites.length === 1 && a.flagWrites[0].right.kind === ts.SyntaxKind.TrueKeyword && a.within(a.flagWrites[0], a.wrapFn),

  'the raw state setter is only CALLED, and only inside setActive and launch-restore — no path goes around the flag': (a) =>
    !!a.raw &&
    a.raw !== SETTER &&
    a.rawRefs.length > 0 &&
    a.rawRefs.every((id) => isCallee(id) && (a.within(id, a.wrapFn) || a.within(id, a.restoreFn) || a.within(id, a.adjustFn))),
  'adjustLayout (the one non-choice path) calls the raw setter exactly once and nothing else does': (a) =>
    !!a.adjustFn && a.rawRefs.filter((id) => a.within(id, a.adjustFn)).length === 1,

  'the restore checks the flag after it has read the last session': (a) =>
    a.guard >= 0 && a.guard > a.stmtOf(a.reads[0]),

  'no await between the check and the set — nothing can be chosen after the check passes': (a) =>
    a.guard >= 0 && a.stmts.slice(a.guard + 1).every((s) => !a.awaitsIn(s)),

  'the restore sets the session and tells main (syncActive) only after the check': (a) =>
    a.guard >= 0 &&
    a.rawInRestore.length >= 1 &&
    a.syncInRestore.length >= 1 &&
    a.rawInRestore.every((id) => a.stmtOf(id) > a.guard) &&
    a.syncInRestore.every((c) => a.stmtOf(c) > a.guard)
}

const real = readFileSync(join(process.cwd(), SRC), 'utf8')
const A = analyze(real)
for (const [name, pred] of Object.entries(CHECKS)) {
  let ok = false
  let why = ''
  try {
    ok = pred(A) === true
  } catch (e) {
    why = String(e?.stack ?? e)
  }
  report(ok, name, why)
}

// ── plant-and-flag ─────────────────────────────────────────────────────────────────────────────
// Anchors are exact text from MainView; each must match ONCE, or the plant reports itself stale.
const GUARD = '      if (chosenSinceMount.current) return\n'
const READS = '      const list = await refreshSessions()\n'
const SETS = '        setActiveState(single(target))\n        syncActive(target)\n'
const MARK = '    chosenSinceMount.current = true\n'
const HOME_SET = '    setActive(HOME)\n    syncActive(HOME)\n'
const PLANTS = [
  { name: 'the restore stops reading LAST_SESSION_KEY', edits: [['b.settings.get(LAST_SESSION_KEY)', 'b.settings.get(OTHER_KEY)']], breaks: 'launch-restore is found: exactly one function awaits settings.get(LAST_SESSION_KEY)' },
  { name: 'the flag starts true', edits: [[`const ${FLAG} = useRef(false)`, `const ${FLAG} = useRef(true)`]], breaks: 'the choice flag is a ref that starts false (true would mean the restore never applies)' },
  { name: 'setActive stops marking the choice', edits: [[MARK, '']], breaks: 'setActive, the setter every other path uses, marks the choice and sets the raw state' },
  { name: 'goHome resets the flag', edits: [[HOME_SET, `    ${FLAG}.current = false\n` + HOME_SET]], breaks: 'nothing un-marks the choice: the flag is written once, `= true`, inside setActive' },
  { name: 'goHome goes around setActive (the regression the probe cannot see)', edits: [[HOME_SET, '    setActiveState(HOME)\n    syncActive(HOME)\n']], breaks: 'the raw state setter is only CALLED, and only inside setActive and launch-restore — no path goes around the flag' },
  { name: 'the raw setter is handed out as a value', edits: [[HOME_SET, '    void [setActiveState]\n' + HOME_SET]], breaks: 'the raw state setter is only CALLED, and only inside setActive and launch-restore — no path goes around the flag' },
  { name: 'the guard is removed (the original bug)', edits: [[GUARD, '']], breaks: 'the restore checks the flag after it has read the last session' },
  { name: 'the guard moves above the awaits (checks before anything could be chosen)', edits: [[GUARD, ''], [READS, GUARD + READS]], breaks: 'the restore checks the flag after it has read the last session' },
  { name: 'an await slips in between the check and the set', edits: [[GUARD, GUARD + '      await Promise.resolve()\n']], breaks: 'no await between the check and the set — nothing can be chosen after the check passes' },
  { name: 'the guard moves below the set', edits: [[GUARD, ''], [SETS, SETS + GUARD]], breaks: 'the restore sets the session and tells main (syncActive) only after the check' },
  { name: 'closing a pane goes around setActive', edits: [['setActive((l) => closePane(l, index))', 'setActiveState((l) => closePane(l, index))']], breaks: 'the raw state setter is only CALLED, and only inside setActive and launch-restore — no path goes around the flag' },
  { name: 'Open beside marks the choice itself', edits: [['      setActive(() => r.layout)\n', `      ${FLAG}.current = true\n      setActive(() => r.layout)\n`]], breaks: 'nothing un-marks the choice: the flag is written once, `= true`, inside setActive' },
  { name: 'adjustLayout loses its raw call', edits: [['const adjustLayout = useCallback((fn: (l: PaneLayout) => PaneLayout) => setActiveState(fn), [])', 'const adjustLayout = useCallback((fn: (l: PaneLayout) => PaneLayout) => setActive(fn), [])']], breaks: 'adjustLayout (the one non-choice path) calls the raw setter exactly once and nothing else does' }
]

let seen = 0
for (const p of PLANTS) {
  let mutated = real
  let stale = ''
  for (const [from, to] of p.edits) {
    const n = mutated.split(from).length - 1
    if (n !== 1) {
      stale = `anchor matched ${n} times: ${JSON.stringify(from.trim())}`
      break
    }
    mutated = mutated.replace(from, to)
  }
  if (stale) {
    report(false, `plant "${p.name}" — ${stale}`, 'update the plant, do not delete it')
    continue
  }
  if (mutated === real) {
    report(false, `plant "${p.name}" applied no change`)
    continue
  }
  let caught = false
  try {
    caught = CHECKS[p.breaks](analyze(mutated)) === false
  } catch {
    caught = false // a check that throws on a mutant has not SEEN it; it has crashed
  }
  report(caught, `plant "${p.name}" is SEEN by "${p.breaks}"`)
  if (caught) seen++
}
report(seen === PLANTS.length, `every plant was seen (${seen}/${PLANTS.length})`)
const unplanted = Object.keys(CHECKS).filter((c) => !PLANTS.some((p) => p.breaks === c))
report(unplanted.length === 0, 'every check is shown able to fail by at least one plant', unplanted.join('; '))

console.log(
  failures === 0
    ? `\n[smoke] outcome: PASS ✓ (launch-restore wiring: ${Object.keys(CHECKS).length} checks, ${seen} planted mutations all seen)`
    : `\n[smoke] outcome: FAIL ✗ (${failures})`
)
console.log('[smoke] The RACE is proven by `npm run probe:launch-restore` on the built app, not here.')
process.exit(failures === 0 ? 0 : 1)
