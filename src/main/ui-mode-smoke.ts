/**
 * ui-mode-smoke — everyday mode (@shared/ui-mode) and the Today home (@shared/today), headless.
 *
 *   1. the stored mode, and the one-time choice for an install with none;
 *   2. the everyday rail: a subset of the full tree, home first, Config last, within the rail's cap;
 *   3. which views and Config tabs each mode shows, and where a put-away one sends you;
 *   4. full mode is Beacon as it was: the same tree, every tab, Mission;
 *   5. Today's "since you last looked";
 *   6. Today's rows from the daemon's event log;
 *   7. the settings keys are classified, and the call sites go through the rules.
 *
 * Run: npm run build && npm run smoke:ui-mode
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_TABS } from '@shared/daemon-api'
import { classifiedScope } from '@shared/daemon-profiles'
import { isOwnerOnlyView } from '@shared/device-role'
import type { EventRow } from '@shared/gateway-events'
import { TODAY_DEFAULT_SPAN_MS, TODAY_MAX_SPAN_MS, TODAY_SEEN_KEY, agoWords, sinceHeading, todayPartial, todayRows, todaySince } from '@shared/today'
import { UI_MODE_KEY, USED_INSTALL_KEYS, configTabInMode, configTabVisible, decideFirstUiMode, homeLabel, navTreeFor, parseUiMode, viewInMode, viewVisible } from '@shared/ui-mode'
import { DEFAULT_VIEW, NAV_TREE, NAV_VIEWS, RAIL_MAX, flattenNavTree, railDestination, subNavForView, usesPillRow, type ViewId } from '@shared/views'

const MIN_CHECKS = 110
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
    console.error(`ui-mode smoke: FAIL ✗ (only ${checks} of at least ${MIN_CHECKS} checks ran)`)
    process.exitCode = 1
  } else if (failures > 0) {
    console.error(`ui-mode smoke: FAIL ✗ (${failures} of ${checks})`)
    process.exitCode = 1
  } else console.log(`ui-mode smoke: PASS ✓ (${checks} checks: stored mode, everyday rail, visibility, full unchanged, since, rows, wiring)`)
})

console.log('1. the stored mode and the first choice')
check(parseUiMode('everyday') === 'everyday' && parseUiMode('full') === 'full', 'both stored values are read')
for (const bad of [null, undefined, '', 'simple', 'FULL', '1']) check(parseUiMode(bad as string | null | undefined) === null, `${JSON.stringify(bad)} is not a mode`)
{
  // The first decision, with each thing it reads faked: what is stored, what is kept, and a read
  // that fails. `wrote` is what it put in the settings table, or undefined when it wrote nothing.
  const run = async (o: { needsSetup: boolean; stored?: Record<string, string>; kept?: number; conversations?: number; fail?: 'get' | 'kept' | 'conversations' | 'set' }): Promise<{ mode: string | null; wrote: string | undefined }> => {
    const table: Record<string, string> = { ...(o.stored ?? {}) }
    let wrote: string | undefined
    const mode = await decideFirstUiMode(
      {
        getSetting: async (k) => {
          if (o.fail === 'get') throw new Error('unreadable')
          return k in table ? table[k] : null
        },
        setSetting: async (k, v) => {
          if (o.fail === 'set') throw new Error('unwritable')
          if (k === UI_MODE_KEY) wrote = v
          table[k] = v
        },
        conversations: async () => {
          if (o.fail === 'conversations') throw new Error('no cache')
          return Array.from({ length: o.conversations ?? 0 })
        },
        kept: async () => {
          if (o.fail === 'kept') throw new Error('no list')
          return Array.from({ length: o.kept ?? 0 })
        }
      },
      o.needsSetup
    )
    return { mode, wrote }
  }
  const eq = (r: { mode: string | null; wrote: string | undefined }, mode: string | null, wrote: string | undefined): boolean => r.mode === mode && r.wrote === wrote
  void (async () => {
    check(eq(await run({ needsSetup: true }), 'everyday', 'everyday'), 'a new install (setup needed, nothing kept, nothing held, no settings) starts everyday, and that is written')
    check(eq(await run({ needsSetup: false, kept: 1, conversations: 40 }), 'full', 'full'), 'an install already connected keeps everything, and that is written')
    check(eq(await run({ needsSetup: false }), 'full', 'full'), 'connected with nothing else to show for it is still not new')
    // The case the first version got wrong: Set up again closes the cache, so conversations read
    // as none. Each of these alone must be enough to say "not new".
    check(eq(await run({ needsSetup: true, kept: 1 }), 'full', 'full'), 'setting up again while another Prometheus is kept: not new')
    check(eq(await run({ needsSetup: true, conversations: 3 }), 'full', 'full'), 'setup needed but conversations held: not new')
    for (const k of USED_INSTALL_KEYS) {
      check(eq(await run({ needsSetup: true, stored: { [k]: 'x' } }), 'full', 'full'), `setting up again after forgetting the only Prometheus, with "${k}" left from before: not new`)
    }
    check(USED_INSTALL_KEYS.length >= 6 && USED_INSTALL_KEYS.every((k) => classifiedScope(k) === 'beacon'), 'every such setting is Beacon-wide, so forgetting a Prometheus cannot clear it')
    check(eq(await run({ needsSetup: true, stored: { [UI_MODE_KEY]: 'full' } }), 'full', undefined), 'a stored mode is returned and never decided or written again')
    check(eq(await run({ needsSetup: false, stored: { [UI_MODE_KEY]: 'everyday' }, kept: 2 }), 'everyday', undefined), 'whatever the install looks like now')
    check(eq(await run({ needsSetup: true, stored: { [UI_MODE_KEY]: 'garbage' } }), 'everyday', 'everyday'), 'an unreadable stored value is decided afresh')
    for (const fail of ['get', 'kept', 'conversations', 'set'] as const) {
      const r = await run({ needsSetup: true, fail })
      check(r.mode === null && r.wrote === undefined, `a failed ${fail} decides nothing and writes nothing (Beacon shows everything this launch, and decides at the next)`)
    }
    check(eq(await run({ needsSetup: false, fail: 'kept' }), 'full', 'full'), 'an install that is connected never needs the reads that can fail')
  })()
}

console.log('2. the everyday rail')
{
  const tree = navTreeFor('everyday')
  const flat = flattenNavTree(tree)
  const all = new Set(NAV_VIEWS.map((v) => v.id))
  check(flat.every((id) => all.has(id)), 'every everyday view is a real view')
  check(new Set(flat).size === flat.length, 'no view appears twice')
  check(tree.length <= RAIL_MAX && tree.length === 4, `the rail has four entries (cap ${RAIL_MAX})`, String(tree.length))
  check(tree[0].kind === 'view' && tree[0].id === 'mission', 'the home is first')
  const last = tree[tree.length - 1]
  check(last.kind === 'view' && last.id === 'config', 'Config is last')
  check(flat.join(',') === 'mission,chat,sessions,documents,artifacts,wiki,files,config', 'it is exactly: home, Chats (chat, sessions), Workspace (documents, artifacts, wiki, files), Config', flat.join(','))
  const full = new Map(NAV_TREE.flatMap((e) => (e.kind === 'group' ? [[e.group.id, e.group] as const] : [])))
  for (const e of tree) {
    if (e.kind !== 'group') continue
    const same = full.get(e.group.id)
    check(!!same && same.label === e.group.label && e.group.children.every((c) => same.children.includes(c)), `${e.group.label} is the full mode's group of that name, with some of its views`)
    check(viewVisible(railDestination(e), 'everyday'), `clicking ${e.group.label} lands on a view that is shown`)
  }
  check(usesPillRow('documents', tree) && subNavForView('documents', tree)?.children.length === 4, 'Workspace keeps a pill row, of four')
  check(usesPillRow('chat', tree), 'Chats keeps its pill row')
  check(homeLabel('everyday') === 'Today' && homeLabel('full') === 'Mission', 'the home is Today here and Mission in full')
}

console.log('3. what each mode shows, and where a put-away view sends you')
{
  const hidden: ViewId[] = ['coding', 'loop-manager', 'board', 'checkpoints', 'skills', 'integrations', 'activity', 'toolfeed', 'status']
  for (const v of hidden) {
    check(!viewVisible(v, 'everyday') && viewVisible(v, 'full'), `${v} is put away in everyday mode and there in full`)
    check(viewInMode(v, 'everyday') === 'mission' && viewInMode(v, 'full') === v, `asking for ${v} in everyday mode shows the home`)
  }
  check(NAV_VIEWS.filter((v) => !viewVisible(v.id, 'everyday')).length === hidden.length, 'and those nine are all of them')
  for (const v of ['mission', 'chat', 'sessions', 'documents', 'config'] as ViewId[]) check(viewInMode(v, 'everyday') === v, `${v} is itself in everyday mode`)
  check(viewVisible('mission', 'everyday') && !isOwnerOnlyView('mission'), 'the everyday home is a view an approved device may open too')
  const kept = CONFIG_TABS.filter((t) => configTabVisible(t.id, 'everyday')).map((t) => t.id)
  check(kept.join(',') === 'models,connectors,usage,memory,cron,grants,devices,skin', 'everyday Config keeps the tabs a person sets something in', kept.join(','))
  check(configTabVisible('grants', 'everyday'), 'Grants is kept: a lasting grant can be given in every mode, so it can be seen and taken back in every mode')
  check(configTabInMode('sentinel', 'everyday') === 'models' && configTabInMode('memory', 'everyday') === 'memory', 'a put-away tab opens the first shown one; a shown tab opens itself')
  check(configTabInMode(null, 'everyday') === 'models' && configTabInMode('made-up', 'full') === CONFIG_TABS[0].id, 'no tab, or an unknown one, opens the first')
}

console.log('4. full mode is unchanged')
check(navTreeFor('full') === NAV_TREE, 'the rail is NAV_TREE itself')
check(NAV_VIEWS.every((v) => viewVisible(v.id, 'full') && viewInMode(v.id, 'full') === v.id), 'every view is shown and is itself')
check(CONFIG_TABS.every((t) => configTabVisible(t.id, 'full') && configTabInMode(t.id, 'full') === t.id), 'every Config tab is shown and is itself')
check(DEFAULT_VIEW === 'mission' && viewInMode(DEFAULT_VIEW, 'everyday') === 'mission', 'the default view is the home in both modes')

console.log('5. since you last looked')
{
  const NOW = 1_800_000_000_000
  const none = todaySince(null, NOW)
  check(none.since === NOW - TODAY_DEFAULT_SPAN_MS && none.looked === false, 'with nothing stored it is the last day, and not called a last look')
  const hour = todaySince(String(NOW - 3_600_000), NOW)
  check(hour.since === NOW - 3_600_000 && hour.looked === true, 'a stored time is used')
  check(todaySince(String(NOW - 30 * 24 * 3_600_000), NOW).since === NOW - TODAY_MAX_SPAN_MS, 'it never reaches back more than a week')
  for (const bad of ['', 'yesterday', '-5', '0', String(NOW + 60_000)]) check(todaySince(bad, NOW).looked === false, `a stored ${JSON.stringify(bad)} is not believed`)
  check(sinceHeading(false, none.since, NOW) === 'In the last day', 'the heading says "In the last day" when there was no last look')
  check(sinceHeading(true, hour.since, NOW) === 'Since you last looked (1 hour ago)', 'and when there was, says how long ago')
  check(agoWords(NOW - 20_000, NOW) === 'just now' && agoWords(NOW - 5 * 60_000, NOW) === '5 minutes ago' && agoWords(NOW - 60_000, NOW) === '1 minute ago', 'minutes read as words')
  check(agoWords(NOW - 26 * 3_600_000, NOW) === 'yesterday' && agoWords(NOW - 4 * 24 * 3_600_000, NOW) === '4 days ago', 'and days')
  check(agoWords(NOW + 5_000, NOW) === 'just now', 'a time slightly ahead of this clock is "just now", not negative')
}

console.log('6. what happened')
{
  const T = 1_800_000_000_000
  const iso = (ms: number): string => new Date(ms).toISOString()
  const ev = (id: number, type: string, at: number, payload: Record<string, unknown>): EventRow => ({ id, signal_type: type, timestamp: iso(at), payload })
  const events: EventRow[] = [
    ev(1, 'turn_completed', T - 9_000, { session_id: 'beacon:trip', summary: 'Booked   the\nfirst leg.' }),
    ev(2, 'turn_completed', T - 5_000, { session_id: 'beacon:trip', summary: 'Here are three hotels near the station.' }),
    ev(3, 'turn_completed', T - 7_000, { session_id: 'beacon:untitled', summary: '' }),
    ev(4, 'task_completed', T - 6_000, { session_id: 'beacon:trip', description: 'Compare train fares' }),
    ev(5, 'task_failed', T - 4_000, { description: 'Download the receipts', error: 'the site refused the login' }),
    ev(6, 'tool_call_end', T - 3_000, { session_id: 'beacon:trip', tool_name: 'bash' }),
    ev(7, 'turn_completed', T - 90_000, { session_id: 'beacon:old', summary: 'before the last look' }),
    ev(8, 'turn_completed', T - 2_000, { summary: 'no session named' }),
    { id: 9, signal_type: 'task_completed', timestamp: 'not a date', payload: { description: 'unreadable time' } }
  ]
  const rows = todayRows(events, T - 60_000, { 'beacon:trip': 'Trip planning', 'beacon:untitled': '  ' })
  const by = (k: string) => rows.find((r) => r.key === k)
  check(rows.map((r) => r.ts).every((t, i, a) => i === 0 || a[i - 1] >= t), 'newest first')
  check(by('replies:beacon:trip')?.text === '2 replies in Trip planning', 'replies in one conversation are one row, counted, by title', by('replies:beacon:trip')?.text)
  check(by('replies:beacon:trip')?.detail === 'Here are three hotels near the station.' && by('replies:beacon:trip')?.ts === T - 5_000, "with the newest reply's opening words and time")
  check(by('replies:beacon:untitled')?.text === 'A reply in a conversation', 'a conversation with no title is "a conversation", never its id')
  check(!rows.some((r) => /beacon:/.test(r.text) || /beacon:/.test(r.detail)), 'no row shows a session id')
  check(by('replies:')?.text === 'A reply in a conversation' && by('replies:')?.sessionId === null, 'a reply naming no conversation has nothing to open')
  check(by('task:4')?.text === 'A task finished: Compare train fares' && by('task:4')?.kind === 'task-done' && by('task:4')?.sessionId === 'beacon:trip', 'a finished task is a row with what it was')
  check(by('task:5')?.text === 'A task failed: Download the receipts' && by('task:5')?.detail === 'the site refused the login' && by('task:5')?.kind === 'task-failed', 'a failed task says why')
  check(!rows.some((r) => r.key.includes('old')), 'what happened before the last look is left out')
  check(!rows.some((r) => r.text.includes('bash')), 'tool calls are not things that happened to a person')
  check(!rows.some((r) => r.key === 'task:9'), 'an event with no readable time is left out, not dated now')
  check(rows.length === 5, 'five rows in all', String(rows.length))
  check(todayRows(events, T - 60_000, {}, 2).length === 2, 'the list is capped')
  check(todayRows([], T, {}).length === 0 && todayRows(events, T, {}).length === 0, 'nothing new is an empty list')
  const whitespace = todayRows([ev(1, 'turn_completed', T - 1_000, { session_id: 's', summary: 'a\n\n  b' })], T - 5_000, {})
  check(whitespace[0].detail === 'a b', 'line breaks in a summary are flattened')
  const two = [ev(1, 'turn_completed', T - 1_000, { session_id: 's' }), ev(2, 'turn_completed', T - 2_000, { session_id: 's' })]
  check(todayPartial(two, T - 60_000, 2) === true, 'as many rows as were asked for, none reaching back to the last look: the list is partial')
  check(todayPartial(two, T - 1_500, 2) === false, 'the rows do reach back past the last look: complete')
  check(todayPartial(two, T - 60_000, 200) === false, 'fewer rows than asked for: that is everything there is')
  check(todayPartial([], T, 200) === false, 'nothing read is not partial')
  const long = todayRows([ev(1, 'task_completed', T - 1_000, { description: 'x'.repeat(300) })], T - 5_000, {})
  check(long[0].text.length < 110 && long[0].text.endsWith('…'), 'a long description is cut')
}

console.log('7. keys and call sites')
{
  check(classifiedScope(UI_MODE_KEY) === 'beacon', 'the mode is Beacon-wide: it is how this person likes Beacon')
  check(classifiedScope(TODAY_SEEN_KEY) === 'prometheus', 'the last look is kept with its Prometheus')
  const read = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8')
  const main = read('src/renderer/src/components/MainView.tsx')
  check(/const view = viewInMode\(chosenView, uiMode\)/.test(main), 'MainView draws the view the mode allows, derived (a put-away view is never drawn)')
  check(/view === 'mission' && uiMode === 'everyday' \? \(\s*<TodayHome/.test(main), 'the home is Today in everyday mode')
  check(/NAV_VIEWS\.filter\(\(v\) => viewVisible\(v\.id, uiMode\)\)/.test(main), 'the palette lists only the views this mode shows')
  check(/id: 'action:ui-mode'/.test(main), 'and offers the switch itself')
  check(/navTreeFor\(mode\)/.test(read('src/renderer/src/components/NavRail.tsx')), 'the rail is the mode\'s tree')
  check(/subNavForView\(view, navTreeFor\(useUiMode\(\)\)\)/.test(read('src/renderer/src/components/SubNav.tsx')), "the pill row is the mode's group")
  check(/configTabInMode\(picked, mode\)/.test(read('src/renderer/src/components/ConfigPanel.tsx')), 'Config opens a tab this mode shows')
  check(/await decideFirstUiMode\(s\.needsSetup\)/.test(read('src/renderer/src/App.tsx')), 'the first choice is made in the setup check, before anything mounts')
  const store = read('src/renderer/src/ui-mode-store.ts')
  check(/let mode: UiMode = 'full'/.test(store), 'until the stored mode is read, nothing is put away')
  check(/await decideFirst\(/.test(store) && /kept: \(\) => b\.instances\.list\(\)/.test(store), 'the store hands the decision to the tested rule, with the kept list')
  const today = read('src/renderer/src/components/TodayHome.tsx')
  check(/if \(!at\.loaded\) return/.test(today) && /if \(cur === at\.instance\)/.test(today), 'Today writes the last look only after reading it, and only into the Prometheus it read it from')
  check(/addEventListener\('blur', write\)/.test(today) && /addEventListener\('pagehide', write\)/.test(today) && /visibilitychange/.test(today), 'and writes it when the window is left or hidden, not only on leaving the view')
  check(/const mayReadSchedule = role !== undefined && role !== 'limited' && !refused/.test(today) && /if \(mayReadSchedule\)/.test(today), 'the schedule is not asked for on an approved device, before the role is known, or while refused')
  check(/onOpenStatus=\{viewVisible\('status', uiMode\) \?/.test(main), 'the context meter links to Status only where Status is shown')
  check(/setChosenView\(viewInMode\(v, uiModeRef\.current\)\)/.test(main), 'a put-away view is never remembered as the chosen one')
}
