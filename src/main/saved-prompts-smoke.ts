/**
 * saved-prompts-smoke — saved prompts and starters (@shared/saved-prompts), headless.
 *
 * Five parts:
 *   1. Names: the slash name comes from the title, and a title is refused when it is empty, too
 *      long, has no letter or digit, names a slash command, or repeats another prompt.
 *   2. The store: add, change, remove, hide a built-in, bring the built-ins back. A refused change
 *      returns the SAME store, which is how the form knows nothing was kept.
 *   3. What is on offer: the person's prompts first, then the built-ins they kept; a saved prompt
 *      with a built-in's name replaces it.
 *   4. The `/` popup: a starter is found by typing its name, completes to its TEXT (not `/name `),
 *      and never changes what a real command does. A draft that is a prompt's text is not a
 *      command of any kind, so nothing about choosing one can reach the slash router.
 *   5. Storage: a round trip, and a parse that survives garbage and drops only the bad records.
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
  parsePromptStore,
  promptSlashCommands,
  removeStarter,
  restoreBuiltins,
  serializePromptStore,
  slashCatalogWith,
  slugOf,
  starters,
  textProblem,
  titleProblem,
  updatePrompt,
  type PromptStore
} from '@shared/saved-prompts'
import { SLASH_COMMANDS, destructiveSlash, parseLocalSlash, slashBoundary, slashCompletion, slashMatches, slashQuery } from '@shared/slash-commands'
import { CacheRepo } from './cache/repo'

const MIN_CHECKS = 60
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
  } else console.log(`saved-prompts smoke: PASS ✓ (${checks} checks: names, store, offer, slash popup, storage)`)
})

const T0 = 1_700_000_000_000
const add = (s: PromptStore, title: string, text: string, id: string, now = T0): PromptStore => addPrompt(s, { title, text }, id, now)

console.log('1. names')
check(slugOf('Plan my day!') === 'plan-my-day', 'a title becomes a lower-case, hyphenated name')
check(slugOf('  Weekly   Review  ') === 'weekly-review', 'runs of spaces are one hyphen, ends are trimmed')
check(slugOf('Q3 — numbers') === 'q3-numbers', 'punctuation is dropped, digits are kept')
check(slugOf('!!!') === '', 'a title with no letter or digit has no name')
check(slugOf('a'.repeat(80)).length === 32, 'the name stops at 32 characters')
check(!slugOf('abcdefghijklmnopqrstuvwxyz01234 -x').endsWith('-'), 'a cut never leaves a trailing hyphen')
{
  const e = emptyPromptStore()
  check(titleProblem(e, 'Weekly review') === null, 'an ordinary title is accepted')
  check(titleProblem(e, '   ') !== null, 'an empty title is refused')
  check(titleProblem(e, 'x'.repeat(PROMPT_TITLE_MAX + 1)) !== null, 'a title over the limit is refused')
  check(titleProblem(e, 'x'.repeat(PROMPT_TITLE_MAX)) === null, 'a title at the limit is accepted')
  check(titleProblem(e, '???') !== null, 'a title with no letter or digit is refused')
  for (const c of ['status', 'reset', 'search', 'approve', 'workspace']) {
    check(titleProblem(e, c) !== null, `"${c}" is refused: /${c} is a command`)
  }
  check(titleProblem(e, 'Status') !== null, 'the command check ignores case')
  check(SLASH_COMMANDS.every((c) => titleProblem(e, c.name) !== null), 'every command in the slash catalog is reserved')
  check(titleProblem(e, 'Status report') === null, 'a title that only starts with a command word is fine')
  check(textProblem('') !== null && textProblem('  \n ') !== null, 'empty prompt text is refused')
  check(textProblem('x'.repeat(PROMPT_TEXT_MAX)) === null, 'text at the limit is accepted')
  check(textProblem('x'.repeat(PROMPT_TEXT_MAX + 1)) !== null, 'text over the limit is refused')
}

console.log('2. the store')
let store = emptyPromptStore()
{
  const a = add(store, 'Weekly review', 'Review my week:\n', 'id-1')
  check(a !== store && a.prompts.length === 1, 'add keeps a prompt')
  check(a.prompts[0].name === 'weekly-review' && a.prompts[0].createdAt === T0 && a.prompts[0].updatedAt === T0, 'it has its name and both times')
  check(a.prompts[0].text === 'Review my week:\n', 'the text is kept exactly, trailing newline included')
  check(store.prompts.length === 0, 'the store passed in is not changed')
  check(add(a, 'weekly  REVIEW', 'again', 'id-2') === a, 'a second prompt with the same name is refused (same store back)')
  check(add(a, 'Other', 'x', 'id-1') === a, 'a repeated id is refused')
  check(add(a, 'Other', 'x', '') === a, 'an empty id is refused')
  check(add(a, 'reset', 'x', 'id-3') === a, 'a command name is refused on add')
  check(add(a, 'Other', '   ', 'id-3') === a, 'empty text is refused on add')
  const b = add(a, 'Standup notes', 'Yesterday / today / blocked:', 'id-2', T0 + 1)
  check(b.prompts.length === 2, 'a second prompt is kept')

  const c = updatePrompt(b, 'id-1', { title: 'Week in review', text: 'Review my week:\n' }, T0 + 50)
  check(c.prompts[0].title === 'Week in review' && c.prompts[0].name === 'week-in-review', 'a new title changes the name with it')
  check(c.prompts[0].id === 'id-1' && c.prompts[0].createdAt === T0 && c.prompts[0].updatedAt === T0 + 50, 'the id and created time stay; updated moves')
  check(updatePrompt(c, 'id-1', { title: 'Week in review', text: 'Review my week:\n' }, T0 + 99) === c, 'saving with nothing changed changes nothing')
  check(updatePrompt(c, 'id-1', { title: 'Standup notes', text: 'x' }, T0 + 99) === c, "a change to another prompt's name is refused")
  check(updatePrompt(c, 'id-1', { title: 'WEEK in review', text: 'new' }, T0 + 99) !== c, 'a prompt may keep its own name')
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

console.log('3. what is on offer')
{
  const fresh = starters(emptyPromptStore())
  check(fresh.length === BUILTIN_STARTERS.length && fresh.every((s) => s.builtin), 'a new install shows the built-in starters')
  check(new Set(BUILTIN_STARTERS.map((b) => b.name)).size === BUILTIN_STARTERS.length, 'built-in names are distinct')
  check(BUILTIN_STARTERS.every((b) => slugOf(b.title) === b.name), "each built-in's name is the one its title derives")
  check(BUILTIN_STARTERS.every((b) => titleProblem(emptyPromptStore(), b.title) === null && textProblem(b.text) === null), 'each built-in would pass the form')
  const offer = starters(store)
  check(offer[0].id === 'id-1' && !offer[0].builtin, "the person's own prompts come first")
  check(!offer.some((s) => s.id === BUILTIN_STARTERS[0].id), 'a hidden built-in is not offered')
  check(offer.length === 1 + BUILTIN_STARTERS.length - 1, 'the rest of the built-ins follow')
  const mine = add(emptyPromptStore(), BUILTIN_STARTERS[1].title, 'my own version', 'own-1')
  const o2 = starters(mine)
  check(o2.filter((s) => s.name === BUILTIN_STARTERS[1].name).length === 1 && o2[0].text === 'my own version', 'a saved prompt with a built-in name replaces that built-in')
  check(new Set(o2.map((s) => s.name)).size === o2.length, 'names on offer are always distinct')
}

console.log('4. the / popup')
{
  const catalog = slashCatalogWith(store)
  check(catalog.length === SLASH_COMMANDS.length + starters(store).length, 'the popup catalog is the commands plus the starters')
  check(catalog.slice(0, SLASH_COMMANDS.length).every((c, i) => c === SLASH_COMMANDS[i]), 'the commands are first and untouched')
  check(new Set(catalog.map((c) => c.name)).size === catalog.length, 'no starter shares a name with a command')
  const hit = slashMatches('week', catalog)
  check(hit.length > 0 && hit[0].name === 'week-in-review', 'typing /week finds the saved prompt')
  check(hit[0].prompt === 'Review my week:\n', 'the row carries the prompt text')
  check(slashCompletion(hit[0]) === 'Review my week:\n', 'choosing it completes to the TEXT, not to /week-in-review')
  check(slashQuery(slashCompletion(hit[0])) === null, 'the popup closes once the text is in the box')
  const status = slashMatches('status', catalog)[0]
  check(status.name === 'status' && status.prompt === undefined && slashCompletion(status) === '/status ', 'a real command still completes to /name and a space')
  check(slashMatches('', catalog).slice(0, 6).every((c) => c.prompt === undefined), "a bare / still opens on the commands, as it did before")
  check(promptSlashCommands(store).every((c) => c.web === true && !c.destructive && !c.local), 'a starter is never marked Telegram-only, destructive or local')
  for (const s of [...BUILTIN_STARTERS, ...starters(store)]) {
    const inBox = slashCompletion({ name: s.name, desc: s.title, web: true, prompt: s.text })
    check(slashBoundary(inBox) === null && destructiveSlash(inBox) === null && parseLocalSlash(inBox) === null, `"${s.title}" in the box is plain text to the send path`)
  }
  // A prompt whose TEXT is itself a command is still only text in the box: the person sees
  // `/reset` there and the send path's own confirmation applies, exactly as if they typed it.
  const sneaky = add(emptyPromptStore(), 'Fresh start', '/reset', 'sn-1')
  check(destructiveSlash(slashCompletion(promptSlashCommands(sneaky)[0])) === 'reset', 'a prompt holding /reset still meets the confirm for /reset')
}

console.log('5. storage')
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
        { id: 'bad-1', title: 'status', text: 'reserved' },
        { id: 'bad-2', title: 'Good one', text: 'duplicate name' },
        { id: 'bad-3', title: 'No text' },
        { id: 7, title: 'Bad id', text: 'x' },
        null,
        'string',
        { id: 'ok-2', title: '  Padded  ', text: 'kept', createdAt: 'yesterday', updatedAt: -4 },
        { id: 'ok-3', title: 'Backwards', text: 'kept', createdAt: 100, updatedAt: 3 }
      ],
      hiddenBuiltins: [BUILTIN_STARTERS[0].id, BUILTIN_STARTERS[0].id, 'builtin:gone', 12]
    })
  )
  check(mixed.prompts.map((p) => p.id).join(',') === 'ok-1,ok-2,ok-3', 'bad records are dropped one by one; good ones stay', mixed.prompts.map((p) => p.id).join(','))
  check(mixed.prompts[0].name === 'good-one', 'a stored name is ignored: the name is always derived from the title')
  check(mixed.prompts[1].title === 'Padded' && mixed.prompts[1].createdAt === 0 && mixed.prompts[1].updatedAt === 0, 'a title is trimmed and unreadable times read as 0')
  check(mixed.prompts[2].updatedAt === 100, 'updated is never before created')
  check(mixed.hiddenBuiltins.length === 1 && mixed.hiddenBuiltins[0] === BUILTIN_STARTERS[0].id, 'hidden built-ins keep only real ids, once each')
  const over = JSON.stringify({ v: 1, prompts: Array.from({ length: PROMPTS_MAX + 20 }, (_, i) => ({ id: `o-${i}`, title: `Over ${i}`, text: 'x' })) })
  check(parsePromptStore(over).prompts.length === PROMPTS_MAX, 'a stored row over the limit is cut to the limit')
  check(
    !CacheRepo.SESSION_SETTING_PREFIXES.some((p) => SAVED_PROMPTS_KEY.startsWith(p)),
    'the settings key is not session-scoped, so forgetting a session can never clear saved prompts'
  )
}
