/**
 * saved-prompts-smoke — saved prompts and starters (@shared/saved-prompts), headless.
 *
 * Seven parts:
 *   1. Titles: refused only when empty, too long, or already used. A title in any script is fine.
 *   2. The store: add, change, remove, hide a built-in, bring the built-ins back. A refused change
 *      returns the SAME store, which is how the form knows nothing was kept.
 *   3. What is on offer, and who gets a slash name: the person's prompts first, then the built-ins
 *      they kept. A name is derived, first come first served, and a title that derives a command's
 *      name, a taken name or no name at all still gives a usable prompt with no slash name.
 *   4. The `/` popup: a starter is listed when its name CONTAINS what was typed, completes to its
 *      TEXT (not `/name `), and never changes what a real command does.
 *   5. Inserting: exactly as saved, after anything already typed.
 *   6. Storage: a round trip, and a parse that drops only what is not a prompt at all.
 *   7. Loading and saving: no change before the first read, a stale read never undoes a change,
 *      and a failed save is reported.
 *   8. The palette: with every starter added, the list it opens on still has the fixed actions.
 *
 * The verdict runs on process 'exit' with a minimum check count, so a part that returns early
 * fails the run instead of passing it short.
 *
 * Run: npm run build && npm run smoke:saved-prompts
 */
import {
  BUILTIN_STARTERS,
  PROMPTS_MAX,
  PROMPT_TEXT_MAX,
  PROMPT_TITLE_MAX,
  SAVED_PROMPTS_KEY,
  addPrompt,
  emptyPromptStore,
  emptyPromptSync,
  insertPrompt,
  parsePromptStore,
  promptSlashCommands,
  removeStarter,
  restoreBuiltins,
  serializePromptStore,
  slashCatalogWith,
  slashNameFor,
  slugOf,
  starters,
  syncChange,
  syncRead,
  syncSaved,
  textProblem,
  titleProblem,
  updatePrompt,
  type PromptStore
} from '@shared/saved-prompts'
import { capGroups, byGroup, rankCommands, type PaletteEntry } from '@shared/commands'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SLASH_COMMANDS, destructiveSlash, parseLocalSlash, slashBoundary, slashCompletion, slashMatches, slashQuery } from '@shared/slash-commands'
import { CacheRepo } from './cache/repo'

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
    console.error(`saved-prompts smoke: FAIL ✗ (only ${checks} of at least ${MIN_CHECKS} checks ran)`)
    process.exitCode = 1
  } else if (failures > 0) {
    console.error(`saved-prompts smoke: FAIL ✗ (${failures} of ${checks})`)
    process.exitCode = 1
  } else console.log(`saved-prompts smoke: PASS ✓ (${checks} checks: titles, store, offer and names, slash popup, insert, storage, sync, palette)`)
})

const T0 = 1_700_000_000_000
const add = (s: PromptStore, title: string, text: string, id: string, now = T0): PromptStore => addPrompt(s, { title, text }, id, now)
const nameOf = (s: PromptStore, id: string): string | undefined => starters(s).find((x) => x.id === id)?.name

console.log('1. titles')
check(slugOf('Plan my day!') === 'plan-my-day', 'a title derives a lower-case, hyphenated name')
check(slugOf('  Weekly   Review  ') === 'weekly-review', 'runs of spaces are one hyphen, ends are trimmed')
check(slugOf('Q3 — numbers') === 'q3-numbers', 'punctuation is dropped, digits are kept')
check(slugOf('!!!') === '' && slugOf('週次レビュー') === '', 'a title with no ASCII letter or digit derives no name')
check(slugOf('a'.repeat(80)).length === 32, 'the name stops at 32 characters')
check(!slugOf('abcdefghijklmnopqrstuvwxyz01234 -x').endsWith('-'), 'a cut never leaves a trailing hyphen')
{
  const e = emptyPromptStore()
  check(titleProblem(e, 'Weekly review') === null, 'an ordinary title is accepted')
  check(titleProblem(e, '   ') !== null, 'an empty title is refused')
  check(titleProblem(e, 'x'.repeat(PROMPT_TITLE_MAX + 1)) !== null, 'a title over the limit is refused')
  check(titleProblem(e, 'x'.repeat(PROMPT_TITLE_MAX)) === null, 'a title at the limit is accepted')
  for (const t of ['週次レビュー', 'Еженедельный обзор', '???', 'C++', 'status', 'Reset']) {
    check(titleProblem(e, t) === null, `"${t}" is accepted as a title (a slash name is a bonus, never a condition)`)
  }
  const one = add(e, 'Weekly review', 'x', 'a')
  check(titleProblem(one, 'weekly REVIEW ') !== null, 'a title the person already uses is refused, whatever its case')
  check(titleProblem(one, 'weekly REVIEW', 'a') === null, 'unless it is that same prompt being edited')
  check(textProblem('') !== null && textProblem('  \n ') !== null, 'empty prompt text is refused')
  check(textProblem('x'.repeat(PROMPT_TEXT_MAX)) === null, 'text at the limit is accepted')
  check(textProblem('x'.repeat(PROMPT_TEXT_MAX + 1)) !== null, 'text over the limit is refused')
}

console.log('2. the store')
let store = emptyPromptStore()
{
  const a = add(store, 'Weekly review', 'Review my week:\n', 'id-1')
  check(a !== store && a.prompts.length === 1, 'add keeps a prompt')
  check(a.prompts[0].createdAt === T0 && a.prompts[0].updatedAt === T0, 'it has both times')
  check(!('name' in a.prompts[0]), 'no slash name is stored: it is derived when read')
  check(a.prompts[0].text === 'Review my week:\n', 'the text is kept exactly, trailing newline included')
  check(store.prompts.length === 0, 'the store passed in is not changed')
  check(add(a, 'weekly  REVIEW', 'again', 'id-2') !== a, 'a title that differs (two spaces) is a different prompt')
  check(add(a, 'WEEKLY review', 'again', 'id-2') === a, 'a repeated title is refused (same store back)')
  check(add(a, 'Other', 'x', 'id-1') === a, 'a repeated id is refused')
  check(add(a, 'Other', 'x', '') === a, 'an empty id is refused')
  check(add(a, 'Other', '   ', 'id-3') === a, 'empty text is refused on add')
  const b = add(a, 'Standup notes', 'Yesterday / today / blocked:', 'id-2', T0 + 1)
  check(b.prompts.length === 2, 'a second prompt is kept')

  const c = updatePrompt(b, 'id-1', { title: 'Week in review', text: 'Review my week:\n' }, T0 + 50)
  check(c.prompts[0].title === 'Week in review' && nameOf(c, 'id-1') === 'week-in-review', 'a new title changes the derived name with it')
  check(c.prompts[0].id === 'id-1' && c.prompts[0].createdAt === T0 && c.prompts[0].updatedAt === T0 + 50, 'the id and created time stay; updated moves')
  check(updatePrompt(c, 'id-1', { title: 'Week in review', text: 'Review my week:\n' }, T0 + 99) === c, 'saving with nothing changed changes nothing')
  check(updatePrompt(c, 'id-1', { title: 'Standup notes', text: 'x' }, T0 + 99) === c, "a change to another prompt's title is refused")
  check(updatePrompt(c, 'id-1', { title: 'WEEK in review', text: 'new' }, T0 + 99) !== c, 'a prompt may keep its own title')
  check(updatePrompt(c, 'nope', { title: 'A', text: 'b' }, T0) === c, 'changing a prompt that is not there changes nothing')

  const d = removeStarter(c, 'id-2')
  check(d.prompts.length === 1 && d.prompts[0].id === 'id-1', 'remove takes out only that prompt')
  check(removeStarter(d, 'id-2') === d, 'removing it twice changes nothing')
  const h = removeStarter(d, BUILTIN_STARTERS[0].id)
  check(h.hiddenBuiltins.length === 1 && h.prompts.length === 1, 'removing a built-in hides it and touches no saved prompt')
  check(removeStarter(h, BUILTIN_STARTERS[0].id) === h, 'hiding it twice changes nothing')
  check(removeStarter(h, 'builtin:made-up') === h, 'an unknown built-in id changes nothing')
  check(restoreBuiltins(h).hiddenBuiltins.length === 0, 'the built-ins can be brought back')
  check(restoreBuiltins(d) === d, 'bringing back nothing changes nothing')

  let many = emptyPromptStore()
  for (let i = 0; i < PROMPTS_MAX; i++) many = add(many, `Prompt ${i}`, 'x', `m-${i}`)
  check(many.prompts.length === PROMPTS_MAX, `${PROMPTS_MAX} prompts are kept`)
  check(add(many, 'One more', 'x', 'm-over') === many, 'one past the limit is refused')
  store = h
}

console.log('3. what is on offer, and who gets a slash name')
{
  const fresh = starters(emptyPromptStore())
  check(fresh.length === BUILTIN_STARTERS.length && fresh.every((s) => s.builtin), 'a new install shows the built-in starters')
  check(fresh.every((s, i) => s.name === BUILTIN_STARTERS[i].name && s.name === slugOf(s.title)), 'each with the name its title derives')
  check(new Set(fresh.map((s) => s.name)).size === fresh.length, 'built-in names are distinct')
  check(BUILTIN_STARTERS.every((b) => titleProblem(emptyPromptStore(), b.title) === null && textProblem(b.text) === null), 'each built-in would pass the form')
  const offer = starters(store)
  check(offer[0].id === 'id-1' && !offer[0].builtin, "the person's own prompts come first")
  check(!offer.some((s) => s.id === BUILTIN_STARTERS[0].id), 'a hidden built-in is not offered')
  check(offer.length === 1 + BUILTIN_STARTERS.length - 1, 'the rest of the built-ins follow')
  const mine = add(emptyPromptStore(), BUILTIN_STARTERS[1].title.toUpperCase(), 'my own version', 'own-1')
  const o2 = starters(mine)
  check(o2.length === BUILTIN_STARTERS.length && o2[0].text === 'my own version' && !o2.some((s) => s.id === BUILTIN_STARTERS[1].id), 'a saved prompt with a built-in title replaces that built-in')
  check(o2[0].name === BUILTIN_STARTERS[1].name, 'and takes its slash name')

  let odd = emptyPromptStore()
  odd = add(odd, 'status', 'my status template', 'o-1')
  odd = add(odd, '週次レビュー', '今週のまとめ:', 'o-2')
  odd = add(odd, 'C++', 'about c++', 'o-3')
  odd = add(odd, 'C#', 'about c#', 'o-4')
  odd = add(odd, 'Plan my day?', 'mine', 'o-5')
  check(odd.prompts.length === 5, 'all five odd titles were saved')
  check(nameOf(odd, 'o-1') === '', 'a prompt titled like a command has no slash name')
  check(nameOf(odd, 'o-2') === '', 'a title with no ASCII letters has no slash name')
  check(nameOf(odd, 'o-3') === 'c' && nameOf(odd, 'o-4') === '', 'two titles deriving one name: the earlier one gets it')
  check(nameOf(odd, 'o-5') === 'plan-my-day', "the person's prompt gets a name before a built-in does")
  check(starters(odd).find((s) => s.id === 'builtin:plan-my-day')?.name === '', 'and that built-in is still offered, without the name')
  const names = starters(odd).map((s) => s.name).filter(Boolean)
  check(new Set(names).size === names.length, 'no two starters ever share a slash name')
  check(names.every((n) => !SLASH_COMMANDS.some((c) => c.name === n)), 'and none is a command')
  check(SLASH_COMMANDS.every((c) => nameOf(add(emptyPromptStore(), c.name, 'x', 'r'), 'r') === ''), 'every command in the slash catalog is reserved')
  check(slashNameFor(odd, 'Reset').why === 'command' && slashNameFor(odd, '???').why === 'none', 'the form can say why a title gets no name')
  check(slashNameFor(odd, 'c').why === 'taken' && slashNameFor(odd, 'c', 'o-3').why === '', 'including one another prompt took (but not the prompt being edited)')
  check(slashNameFor(odd, 'Fresh idea').name === 'fresh-idea' && slashNameFor(odd, 'Fresh idea').why === '', 'and the name a free title will get')
  check(slashNameFor(emptyPromptStore(), 'Draft a reply').why === '', "a built-in's name is free to take")
}

console.log('4. the / popup')
{
  const catalog = slashCatalogWith(store)
  check(catalog.length === SLASH_COMMANDS.length + starters(store).length, 'with nothing typed the popup catalog is the commands plus the starters')
  check(catalog.slice(0, SLASH_COMMANDS.length).every((c, i) => c === SLASH_COMMANDS[i]), 'the commands are first and untouched')
  check(new Set(catalog.map((c) => c.name)).size === catalog.length, 'no starter shares a name with a command')
  const hit = slashMatches('week', slashCatalogWith(store, 'week'))
  check(hit.length > 0 && hit[0].name === 'week-in-review', 'typing /week finds the saved prompt')
  check(hit[0].prompt === 'Review my week:\n', 'the row carries the prompt text')
  check(slashCompletion(hit[0]) === 'Review my week:\n', 'choosing it completes to the TEXT, not to /week-in-review')
  check(slashQuery(slashCompletion(hit[0])) === null, 'the popup closes once the text is in the box')
  check(promptSlashCommands(store, 'review').length === 1, 'a name is matched anywhere in it (/review)')
  check(promptSlashCommands(store, 'wkrv').length === 0, 'but not by scattered letters: /wkrv lists no prompt')
  check(slashMatches('wkrv', slashCatalogWith(store, 'wkrv')).every((c) => c.prompt === undefined), 'so an unknown /word still goes to the daemon instead of becoming a prompt')
  const status = slashMatches('status', slashCatalogWith(store, 'status'))[0]
  check(status.name === 'status' && status.prompt === undefined && slashCompletion(status) === '/status ', 'a real command still completes to /name and a space')
  check(slashMatches('', catalog).slice(0, 6).every((c) => c.prompt === undefined), 'a bare / still opens on the commands, as it did before')
  check(promptSlashCommands(store).every((c) => c.web === true && !c.destructive && !c.local && c.name !== ''), 'a starter row is never Telegram-only, destructive, local or nameless')
  for (const s of [...BUILTIN_STARTERS, ...starters(store)]) {
    const inBox = slashCompletion({ name: s.name, desc: s.title, web: true, prompt: s.text })
    check(slashBoundary(inBox) === null && destructiveSlash(inBox) === null && parseLocalSlash(inBox) === null, `"${s.title}" in the box is plain text to the send path`)
  }
  // A prompt whose TEXT is itself a command is still only text in the box: the person sees
  // `/reset` there and the send path's own confirmation applies, exactly as if they typed it.
  const sneaky = add(emptyPromptStore(), 'Fresh start', '/reset', 'sn-1')
  check(destructiveSlash(slashCompletion(promptSlashCommands(sneaky)[0])) === 'reset', 'a prompt holding /reset still meets the confirm for /reset')
}

console.log('5. inserting')
check(insertPrompt('', 'Research this: ') === 'Research this: ', 'into an empty box: exactly as saved, trailing space kept')
check(insertPrompt('', 'Summarise:\n\n') === 'Summarise:\n\n', 'trailing blank line kept')
check(insertPrompt('half a thought  \n', 'Draft: ') === 'half a thought\n\nDraft: ', 'after typed text: on its own paragraph')
check(insertPrompt('typed', '') === 'typed', 'nothing to insert changes nothing')
check(BUILTIN_STARTERS.every((b) => insertPrompt('', b.text) === b.text && /[\s:]$/.test(b.text)), 'every built-in lands whole, ending where the person starts typing')

console.log('6. storage')
{
  const round = parsePromptStore(serializePromptStore(store))
  check(JSON.stringify(round) === JSON.stringify(store), 'a store survives a round trip unchanged')
  check(JSON.parse(serializePromptStore(store)).v === 1, 'the stored row carries a version')
  for (const bad of [null, undefined, '', 'not json', '[]', '42', '"x"', '{"prompts":"no"}', '{"v":1}']) {
    const p = parsePromptStore(bad as string | null | undefined)
    check(p.prompts.length === 0 && p.hiddenBuiltins.length === 0, `unreadable row ${JSON.stringify(bad)} reads as empty`)
  }
  const mixed = parsePromptStore(
    JSON.stringify({
      v: 1,
      prompts: [
        { id: 'ok-1', title: 'Good one', name: 'reset', text: 'fine', createdAt: 5, updatedAt: 9 },
        { id: 'ok-1', title: 'Same id', text: 'dropped' },
        { id: 'keep-1', title: 'status', text: 'a command word as a title' },
        { id: 'keep-2', title: 'Good one', text: 'same title as another' },
        { id: 'keep-3', title: 'x'.repeat(PROMPT_TITLE_MAX + 30), text: 'longer than the form allows now' },
        { id: 'bad-3', title: 'No text' },
        { id: 'bad-4', title: 'Blank text', text: '   ' },
        { id: 7, title: 'Bad id', text: 'x' },
        null,
        'string',
        { id: 'ok-2', title: '  Padded  ', text: 'kept', createdAt: 'yesterday', updatedAt: -4 },
        { id: 'ok-3', title: 'Backwards', text: 'kept', createdAt: 100, updatedAt: 3 },
        { id: 'bad-5', title: 'Huge', text: 'x'.repeat(PROMPT_TEXT_MAX * 8 + 1) }
      ],
      hiddenBuiltins: [BUILTIN_STARTERS[0].id, BUILTIN_STARTERS[0].id, 'builtin:gone', 12]
    })
  )
  const ids = mixed.prompts.map((p) => p.id).join(',')
  check(ids === 'ok-1,keep-1,keep-2,keep-3,ok-2,ok-3', 'only what is not a prompt at all is dropped', ids)
  check(!('name' in mixed.prompts[0]) && nameOf(mixed, 'ok-1') === 'good-one', 'a stored name is ignored: the name is always derived from the title')
  check(nameOf(mixed, 'keep-1') === '' && nameOf(mixed, 'keep-2') === '', 'a prompt whose name a command or another prompt has is KEPT, without a slash name')
  check(mixed.prompts.find((p) => p.id === 'keep-3')?.title.length === PROMPT_TITLE_MAX + 30, 'a title over the limit is kept as it is')
  check(JSON.stringify(parsePromptStore(serializePromptStore(mixed))) === JSON.stringify(mixed), 'and all of them survive the next save and read')
  const p2 = mixed.prompts.find((p) => p.id === 'ok-2')
  check(p2?.title === 'Padded' && p2.createdAt === 0 && p2.updatedAt === 0, 'a title is trimmed and unreadable times read as 0')
  check(mixed.prompts.find((p) => p.id === 'ok-3')?.updatedAt === 100, 'updated is never before created')
  check(mixed.hiddenBuiltins.length === 1 && mixed.hiddenBuiltins[0] === BUILTIN_STARTERS[0].id, 'hidden built-ins keep only real ids, once each')
  const over = JSON.stringify({ v: 1, prompts: Array.from({ length: PROMPTS_MAX + 20 }, (_, i) => ({ id: `o-${i}`, title: `Over ${i}`, text: 'x' })) })
  check(parsePromptStore(over).prompts.length === PROMPTS_MAX, 'a stored row over the limit is cut to the limit')
  check(
    !CacheRepo.SESSION_SETTING_PREFIXES.some((p) => SAVED_PROMPTS_KEY.startsWith(p)),
    'the settings key is not session-scoped, so forgetting a session can never clear saved prompts'
  )
}

console.log('7. loading and saving')
{
  const row = serializePromptStore(add(emptyPromptStore(), 'Stored one', 'kept on disk', 's-1'))
  const s0 = emptyPromptSync()
  const early = syncChange(s0, (s) => add(s, 'Too early', 'x', 'e-1'))
  check(early.write === null && early.state === s0, 'before the first read no change is accepted, so an empty list can never replace the stored row')
  const s1 = syncRead(s0, s0.gen, row)
  check(s1.loaded && s1.store.prompts.length === 1, 'a read loads the stored prompts')
  check(syncRead(s1, s1.gen, row) === s1, 'a read that finds nothing new changes nothing (no re-render)')
  const ch = syncChange(s1, (s) => add(s, 'New one', 'typed now', 'n-1'))
  check(ch.write !== null && ch.state.store.prompts.length === 2 && ch.state.gen === s1.gen + 1, 'a change is applied, handed back to write, and bumps the generation')
  check(JSON.parse(ch.write ?? '{}').prompts.length === 2, 'what is written is the whole new store')
  check(syncChange(ch.state, (s) => s).write === null, 'a refused change (same store back) writes nothing')
  // The race: a focus read started before the change, and comes back after it with the OLD row.
  const stale = syncRead(ch.state, s1.gen, row)
  check(stale === ch.state && stale.store.prompts.length === 2, 'a read that started before a change does not undo it')
  const fresh = syncRead(ch.state, ch.state.gen, ch.write)
  check(fresh === ch.state, 'a read that started after it agrees with it')
  const other = serializePromptStore(add(add(emptyPromptStore(), 'Stored one', 'kept on disk', 's-1'), 'From the other window', 'x', 'w-2'))
  check(syncRead(ch.state, ch.state.gen, other).store.prompts.some((p) => p.id === 'w-2'), "a later read does pick up another window's save")
  const failed = syncSaved(ch.state, false)
  check(failed.saveFailed === true && failed.store === ch.state.store, 'a failed save is flagged')
  const rolled = syncRead(failed, failed.gen, row)
  check(rolled.store.prompts.length === 1 && rolled.saveFailed === true, 'and the read that follows shows what is really stored, still flagged')
  check(syncSaved(rolled, true).saveFailed === false, 'the next save that lands clears the flag')
  check(syncSaved(ch.state, true) === ch.state, 'a save that lands when nothing was wrong changes nothing')
  const unread = syncRead(s0, s0.gen, 'not json')
  check(unread.loaded && unread.store.prompts.length === 0, 'a damaged row reads as empty and counts as read')
  const store = readFileSync(join(process.cwd(), 'src/renderer/src/saved-prompts-store.ts'), 'utf8')
  check(/syncChange\(state, fn\)/.test(store) && /syncRead\(state, startedAt,/.test(store) && /syncSaved\(state, false\)/.test(store), 'the renderer store goes through this state machine for all three')
  check(!/settings\.set\([^)]*\)\.catch\(\(\) => undefined\)/.test(store), 'and does not swallow a failed save')
}

console.log('8. the palette')
{
  // The fixed actions MainView offers, then the starters, as MainView orders them.
  const src = readFileSync(join(process.cwd(), 'src/renderer/src/components/MainView.tsx'), 'utf8')
  const fixedAt = src.indexOf("id: 'action:shortcuts'")
  const promptsAt = src.indexOf('id: `prompt:${s.id}`')
  check(fixedAt > 0 && promptsAt > fixedAt, 'in MainView the "Use prompt" rows come after the last fixed action')
  const fixed: PaletteEntry[] = ['New chat', 'Saved prompts…', 'Reconnect to gateway', 'Open Connection Settings', 'Show keyboard shortcuts'].map((label, i) => ({ id: `action:${i}`, label, group: 'action' }))
  const rows: PaletteEntry[] = [...fixed, ...starters(emptyPromptStore()).map((s) => ({ id: `prompt:${s.id}`, label: `Use prompt: ${s.title}`, group: 'action' as const }))]
  const opened = capGroups(byGroup(rankCommands(rows, '')))
  check(fixed.every((f) => opened.some((o) => o.id === f.id)), 'the list the palette opens on still shows the fixed actions')
  const typed = capGroups(byGroup(rankCommands(rows, 'use prompt')))
  check(typed.length === Math.min(5, BUILTIN_STARTERS.length) && typed.every((o) => o.id.startsWith('prompt:')), 'and typing "use prompt" brings the starters up')
}
