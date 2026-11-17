/**
 * Projects in the sidebar smoke (headless / ELECTRON_RUN_AS_NODE): which projects the sidebar draws, and what a filing answer turns into
 * (@shared/chat-projects-view, src/renderer/src/projects-source.ts).
 *
 *   * the daemon's projects replace the local ones ONLY when it says it serves them, this Beacon is its owner, and the local projects
 *     have been moved to it or there are none: in every other case the sidebar is what it was, and nothing local is touched;
 *   * the answers are the daemon's real ones (src/main/fixtures/chat_projects.json): a filing is a note that says where the
 *     conversation works now, a question with the folder in it, or the refusal's own sentence;
 *   * a conversation is never moved into a folder, or a phone's conversation bound to one, without the person saying so.
 */
import fixture from './fixtures/chat_projects.json'
import { readFileSync } from 'node:fs'
import { readFiled, readProjectList, readSuggestions, refusal, noChatProjects, type ChatProjectsResult, type ChatProjectsState } from '@shared/chat-projects'
import {
  CHAT_PROJECTS_MIGRATED_KEY,
  CHAT_PROJECTS_SERVED_KEY,
  batchNote,
  batchSummary,
  filingOutcome,
  hintsFromDaemon,
  localHasProjects,
  parseMigrated,
  projectsMode,
  questionWords,
  shortFolder,
  storeFromDaemon,
  writeDismissedOnly
} from '@shared/chat-projects-view'
import { classifiedScope } from '@shared/daemon-profiles'
import { emptyProjectStore, rowSuggestion, type ProjectStore } from '@shared/session-projects'

const EXPECTED = 60
let failures = 0
let checks = 0
function assert(cond: boolean, label: string, detail?: unknown): void {
  checks++
  console.log(`[chat-projects-view-smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail !== undefined ? `  — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
  if (!cond) failures++
}
process.on('exit', () => {
  if (checks !== EXPECTED) {
    console.log(`[chat-projects-view-smoke] FAIL  ${checks} checks ran, expected ${EXPECTED}`)
    failures++
  }
  console.log(failures === 0 ? `[chat-projects-view-smoke] PASS (${checks} checks)` : `[chat-projects-view-smoke] ${failures} FAILED`)
  process.exitCode = failures === 0 ? 0 : 1
})

type Exchange = { label: string; status: number; body: unknown }
const ex = (label: string): Exchange => {
  const found = (fixture.exchanges as Exchange[]).filter((e) => e.label === label)
  if (found.length !== 1) throw new Error(`fixture: ${found.length} exchanges labelled ${JSON.stringify(label)}`)
  return found[0]
}

// The daemon's own list and suggestions, as the hub would hold them.
const list = readProjectList(ex('list').status, ex('list').body)
const sug = readSuggestions(ex('suggestions').status, ex('suggestions').body)
if (!list.ok || !sug.ok) throw new Error('fixture: list or suggestions unreadable')
const served: ChatProjectsState = {
  known: true,
  available: true,
  migration: null,
  list: list.value,
  filings: { [fixture.sessions.filed]: 'cp_000000000001', [fixture.sessions.label_only]: 'cp_000000000002' },
  suggestions: sug.value.suggestions,
  problem: null
}
const localEmpty = emptyProjectStore()
const localFull: ProjectStore = { projects: [{ id: 'p1', name: 'Kitchen' }], assign: { 'desktop:a': 'p1' }, dismissed: {} }
const localOnlyAssign: ProjectStore = { projects: [], assign: { 'desktop:a': 'p1' }, dismissed: {} }

// ── the migrated flag ──────────────────────────────────────────────────────────────────────────────────────────────────────────
assert(CHAT_PROJECTS_MIGRATED_KEY === 'chat-projects:migrated:v1' && classifiedScope(CHAT_PROJECTS_MIGRATED_KEY) === 'prometheus', 'the flag is kept per Prometheus: it says whether THAT one has had the local projects moved to it')
assert(parseMigrated('{"done":true}') && parseMigrated('{"done":true,"moved":28,"leftovers":[]}'), 'a flag that says done is done')
assert(![null, undefined, '', 'x', '{}', '{"done":false}', '{"done":"true"}', '{"done":1}', '[]', 'null', '{"done":'].some((v) => parseMigrated(v as string | null | undefined)), 'anything else, unreadable or absent, is not done')
assert(!localHasProjects(localEmpty) && localHasProjects(localFull) && localHasProjects(localOnlyAssign), 'local projects to move: any project, or any conversation filed in one')

// ── which projects are drawn ───────────────────────────────────────────────────────────────────────────────────────────────────
const mode = (state: ChatProjectsState, migrated: boolean | null, local: ProjectStore | null, servedBefore: boolean | null = false): string => projectsMode({ state, migrated, local, servedBefore })
const silentKnown: ChatProjectsState = { ...noChatProjects(), known: true }
assert(CHAT_PROJECTS_SERVED_KEY === 'chat-projects:served:v1' && classifiedScope(CHAT_PROJECTS_SERVED_KEY) === 'prometheus', 'whether a Prometheus has ever been seen serving projects is kept per Prometheus')
assert(mode(silentKnown, false, localEmpty) === 'local' && mode(silentKnown, false, localFull) === 'local' && mode({ ...served, available: false }, false, localEmpty) === 'local', 'a Prometheus that has said it does not serve projects, and never has: local')
assert(mode(silentKnown, true, localEmpty) === 'wait' && mode(silentKnown, true, localFull) === 'wait', 'one the local projects were moved to, that does not answer now: wait. Its projects are the truth, and the local copy is retired')
assert(mode(noChatProjects(), false, localEmpty) === 'wait' && mode(noChatProjects(), true, localEmpty) === 'wait', 'before the Prometheus has said anything, with no local projects, nothing is decided: wait, so nothing made now can pin the sidebar to the local projects')
assert(mode(noChatProjects(), false, localFull) === 'local' && mode(noChatProjects(), false, localOnlyAssign) === 'local', 'with local projects already there and a Prometheus that has never served any, nothing waits: local, at once, as it always was')
assert(mode(silentKnown, true, localEmpty, true) === 'wait' && mode(silentKnown, false, localFull, true) === 'wait', 'a Prometheus that has served projects before and says nothing now (offline, or connecting) is waited for, not taken for one that never did')
assert(mode({ ...served, list: null }, true, localEmpty) === 'wait', 'it serves them, and its list is still being read: wait')
const chatOnly = readProjectList(ex('list, as a chat-only device').status, ex('list, as a chat-only device').body)
assert(chatOnly.ok && mode({ ...served, list: chatOnly.value }, true, localEmpty) === 'local', "a Beacon that is not the owner (a device that may only chat) keeps its local projects: it could change none of the daemon's")
assert(mode(served, null, localEmpty) === 'wait' && mode(served, true, null) === 'wait' && mode(served, true, localEmpty, null) === 'wait' && mode(served, null, null, null) === 'wait', 'while the flag, the local store or the served flag is still being read: wait')
assert(mode({ ...served, migration: { status: 'running', projects: 0, moved: 0, leftovers: 0, alreadyFiled: 0, skippedProjects: 0, message: null, fresh: false } }, false, localFull) === 'wait', 'while the local projects are being moved, nothing is made or changed: an edit then would not be in what is moved, and the move would hide it')
assert(mode({ ...served, migration: { status: 'incomplete', projects: 0, moved: 0, leftovers: 0, alreadyFiled: 0, skippedProjects: 0, message: 'x', fresh: false } }, false, localFull) === 'local' && mode({ ...served, migration: { status: 'done', projects: 1, moved: 1, leftovers: 0, alreadyFiled: 0, skippedProjects: 0, message: null, fresh: true } }, true, localFull) === 'daemon', 'a move that did not finish leaves the local projects drawn; one that did, the Prometheus\'s')
assert(mode(served, true, localFull) === 'daemon', "the local projects have been moved: the Prometheus's are drawn")
assert(mode(served, false, localEmpty) === 'daemon', "there were none to move: the Prometheus's are drawn")
assert(mode(served, false, localFull) === 'local' && mode(served, false, localOnlyAssign) === 'local', 'local projects that have not been moved keep being drawn, and are not touched')

// ── a dismissal changes nothing else in the stored store ─────────────────────────────────────────────────────────────────────────
{
  const stored = JSON.stringify({ projects: [{ id: 'p1', name: 'Kitchen' }, { id: 'p2', name: 'kitchen' }, { nope: 1 }], assign: { 'desktop:a': 'p1', 'desktop:b': 'gone' }, dismissed: { 'desktop:old': 'x' }, extra: { keep: ['me'] } })
  const out = writeDismissedOnly(stored, { 'desktop:old': 'x', 'desktop:new': 'y' })
  const back = out ? (JSON.parse(out) as Record<string, unknown>) : null
  const orig = JSON.parse(stored) as Record<string, unknown>
  assert(!!back && JSON.stringify(back.projects) === JSON.stringify(orig.projects) && JSON.stringify(back.assign) === JSON.stringify(orig.assign) && JSON.stringify(back.extra) === JSON.stringify(orig.extra), 'only `dismissed` changes: every project and filing, including ones this version would drop on reading, and fields it does not know, come back exactly')
  assert(JSON.stringify(back?.dismissed) === '{"desktop:old":"x","desktop:new":"y"}', 'and the dismissals are the new ones')
  assert(writeDismissedOnly('not json', {}) === null && writeDismissedOnly('[]', {}) === null && writeDismissedOnly('"x"', {}) === null && writeDismissedOnly('null', {}) === null, 'what is stored but cannot be read as a store is never written over')
  assert(JSON.parse(writeDismissedOnly(null, { a: 'b' }) ?? '{}').dismissed.a === 'b' && JSON.parse(writeDismissedOnly('', { a: 'b' }) ?? '{}').projects.length === 0, 'with nothing stored, a store holding only the dismissals')
}

// ── what is drawn in daemon mode ───────────────────────────────────────────────────────────────────────────────────────────────
{
  const dismissed = { 'desktop:x': 'beacon' }
  const store = storeFromDaemon(served, dismissed)
  assert(store.projects.map((p) => p.name).join() === 'Kitchen remodel,Garden' && store.projects.map((p) => p.id).join() === 'cp_000000000001,cp_000000000002', "the daemon's projects, in its order, with its ids")
  assert(store.assign[fixture.sessions.filed] === 'cp_000000000001' && Object.keys(store.assign).length === 2, 'the daemon\'s filings, and nothing from this computer\'s')
  assert(store.dismissed['desktop:x'] === 'beacon' && store.dismissed !== dismissed, 'the dismissed suggestions are the ones kept on this computer (a copy)')
  const hints = hintsFromDaemon(served)
  assert(Object.keys(hints).length === 2 && hints[fixture.sessions.suggested_new]?.label === 'new-thing' && hints[fixture.sessions.suggested_new]?.calls === 3, "the daemon's suggestions, in the shape the sidebar draws")
  // The suggestion was made after the project was renamed (the recorded list is from before): the list as it stood by then.
  const renamed = storeFromDaemon({ ...served, list: { ...list.value, projects: list.value.projects.map((p) => (p.id === 'cp_000000000002' ? { ...p, name: 'Back garden' } : p)) } }, {})
  const into = rowSuggestion(renamed, fixture.sessions.suggested_into_project, hints[fixture.sessions.suggested_into_project])
  assert(into?.existing?.id === 'cp_000000000002', 'a suggestion for a folder that is a project is filed into that project, by the sidebar\'s own name rule')
  const fresh = rowSuggestion(store, fixture.sessions.suggested_new, hints[fixture.sessions.suggested_new])
  assert(fresh?.existing === undefined && fresh?.hint.label === 'new-thing', 'one that is not offers a new project with the label')
  assert(rowSuggestion({ ...store, dismissed: { [fixture.sessions.suggested_new]: 'new-thing' } }, fixture.sessions.suggested_new, hints[fixture.sessions.suggested_new]) === null, 'a suggestion the person said no to stays gone')
  assert(rowSuggestion(store, fixture.sessions.filed, { key: 'k', label: 'l', share: 1, calls: 3 }) === null, 'a conversation that is filed is not suggested anything')
}

// ── a filing's answer ──────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const asRead = (label: string): ChatProjectsResult => {
    const e = ex(label)
    const filed = readFiled(e.status, e.body)
    return filed.ok ? { ok: true, sessionId: filed.value.sessionId, workspace: filed.value.workspace } : filed
  }
  const kitchen = { id: 'cp_000000000001', name: 'Kitchen remodel', folder: '/x/projects-root/kitchen-remodel' }
  const ctx = (o: { keep?: boolean; unfiling?: boolean; project?: typeof kitchen | null } = {}) => ({ sessionId: 'desktop:s', title: 'Plan the kitchen', project: o.project === undefined ? kitchen : o.project, keep: o.keep === true, unfiling: o.unfiling === true })
  const moved = filingOutcome(asRead('file'), ctx())
  assert(moved.kind === 'done' && moved.note === 'Moved to “Kitchen remodel”. It now works in …/projects-root/kitchen-remodel.', 'a conversation moved into a project: a note that says where it works now', moved)
  const label = filingOutcome(asRead('file, as a label only (the folder is kept)'), ctx({ keep: true }))
  assert(label.kind === 'done' && label.note === 'Filed in “Kitchen remodel”. Its own folder was left as it was.', 'filed as a label only: says the folder was left as it was')
  const out = filingOutcome(asRead('file, unfile'), ctx({ unfiling: true, project: null }))
  assert(out.kind === 'done' && out.note === "Taken out of the project. It works in Prometheus's own workspace.", "taken out of a project: says where it works now (the daemon's answer: no folder of its own)")
  const outHere = filingOutcome({ ok: true, sessionId: 's', workspace: '/x/y/z' }, ctx({ unfiling: true, project: null }))
  assert(outHere.kind === 'done' && outHere.note === 'Taken out of the project. It works in …/y/z.', 'and when it still has a folder, which')
  const noFolder = filingOutcome({ ok: true, sessionId: 's', workspace: null }, ctx())
  assert(noFolder.kind === 'done' && noFolder.note === 'Moved to “Kitchen remodel”.', 'an answer with no folder in it says no more than it knows')
  const hand = filingOutcome(refusal(409, ex('file, a folder was chosen by hand').body), ctx())
  assert(hand.kind === 'ask' && hand.question.kind === 'workspace' && hand.question.workspace?.endsWith('/home/hand-picked') === true && hand.question.projectFolder === kitchen.folder && hand.question.title === 'Plan the kitchen', 'a folder chosen by hand: a question, with that folder, the project and the title in it')
  const dev = filingOutcome(refusal(409, ex("file, a chat-only device's conversation").body), ctx())
  assert(dev.kind === 'ask' && dev.question.kind === 'device', "a phone's conversation: a question")
  const gone = filingOutcome(refusal(404, ex('file, a session the daemon does not have').body), ctx())
  assert(gone.kind === 'say' && gone.message === "Prometheus doesn't have that conversation any more.", "a conversation Prometheus doesn't have: the refusal's own sentence")
  const noProject = filingOutcome(refusal(409, ex('file, a folder was chosen by hand').body), ctx({ project: null }))
  assert(noProject.kind === 'say', 'a question about a project Beacon does not have is not asked: it is said')
  const notOwner = filingOutcome(refusal(403, ex('file, as a chat-only device').body), ctx())
  assert(notOwner.kind === 'say' && /isn't an owner/.test(notOwner.message), 'a Beacon that is not an owner is told so')
  assert(shortFolder('/a/b/c/d') === '…/c/d' && shortFolder('/a/b') === '/a/b' && shortFolder('/a') === '/a' && shortFolder('') === '', 'a folder is shortened to its last two parts for a sentence')
}

// ── the questions ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const q = { kind: 'workspace' as const, sessionId: 's', title: 'Plan the kitchen', projectId: 'cp_1', projectName: 'Kitchen remodel', projectFolder: '/x/y', workspace: '/home/me/hand-picked' }
  const w = questionWords(q)
  assert(w.choices.length === 2 && w.choices[0].send.keep === true && w.choices[0].primary === true && w.choices[1].send.replace === true, 'a hand-chosen folder: leave it alone (the first, and the one that is already selected) or use the project\'s')
  assert(w.text.includes('Plan the kitchen') && w.text.includes('Kitchen remodel') && w.text.includes('…/me/hand-picked'), 'the question names the conversation, the project and the folder')
  const d = questionWords({ ...q, kind: 'device', workspace: null })
  assert(d.choices.length === 1 && d.choices[0].send.keep === true && !('replace' in d.choices[0].send) && /phone that can only chat/.test(d.text), "a phone's conversation can only be filed as a label: binding a folder to it is not offered")
  assert(!/HTTP|\/api\/|workspace|chat_project|device_session|409/.test(w.text + d.text + w.choices.map((c) => c.label).join()), 'neither question has a status, a route or a daemon word in it')
  assert(questionWords({ ...q, title: '' }).text.startsWith('This conversation'), 'an untitled conversation is "This conversation"')
  assert(batchSummary({ project: 'Kitchen', folder: '/x/projects/kitchen', moved: 2, labelled: 1, refused: 0, why: null }) === 'Moved 2 conversations to “Kitchen”. They now work in …/projects/kitchen. One conversation already had a folder chosen for it, so it was filed without changing its folder.' && batchSummary({ project: 'K', folder: null, moved: 1, labelled: 0, refused: 2, why: 'Prometheus is down.' }) === 'Moved 1 conversation to “K”. 2 could not be filed: Prometheus is down.', 'a batch is one note: how many were moved and where they work, how many were filed as labels, how many were refused and why')
  assert(batchNote(1).startsWith('One conversation') && batchNote(3).startsWith('3 conversations') && /without changing/.test(batchNote(3)), 'a batch filed as labels says so')
}

// ── the code the sidebar runs ──────────────────────────────────────────────────────────────────────────────────────────────────
{
  const src = (rel: string): string => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8')
  const hook = src('src/renderer/src/projects-source.ts')
  assert(/const mode = projectsMode\(\{ state, migrated, local: localLoaded \? local : null, servedBefore \}\)/.test(hook) && /const store = daemon \? storeFromDaemon\(state, local\.dismissed\) : local/.test(hook), 'which projects are drawn is decided by projectsMode, and nowhere else')
  const updateLocal = hook.slice(hook.indexOf('const updateLocal'), hook.indexOf('// ── the Prometheus'))
  assert(/if \(!loaded\.current\) return/.test(updateLocal) && /settings\.set\(SESSION_PROJECTS_SETTING_KEY, serializeProjectStore\(next\)\)/.test(updateLocal) && (hook.match(/settings\.set\(SESSION_PROJECTS_SETTING_KEY/g) ?? []).length === 2 && /const out = writeDismissedOnly\(raw, dismissed\)\s*if \(out\) await window\.beacon\.settings\.set\(SESSION_PROJECTS_SETTING_KEY, out\)/.test(hook), "this computer's store is written in two places: the whole store in local mode (only after it has been read), and in daemon mode the dismissals alone")
  const daemonOnly = (name: string): string => hook.slice(hook.indexOf(`const ${name} =`), hook.indexOf(`const ${name} =`) + 900)
  assert(/if \(hold\(\)\) return\s*if \(!daemon\) \{\s*updateLocal\(\(s\) => assignSession\(s, sessionId, projectId\)\)\s*after\?\.\(\)\s*return\s*\}\s*void fileDaemon\(sessionId, projectId, title, \{\}, undefined, after\)/.test(hook) && /if \(!daemon\) \{\s*updateLocal\(\(s\) => \{\s*const made = createProject\(s, label\)/.test(daemonOnly('acceptHint')), 'in local mode a filing and an accepted suggestion are the code they always were; in daemon mode they are asked of the Prometheus')
  assert(/const dismissHints = \(items[^)]*\): void => \{\s*if \(!daemon\) return updateLocal\(\(s\) => items\.reduce\(\(acc, it\) => dismissSuggestion\(acc, it\.sessionId, it\.key\), s\)\)/.test(hook) && /const out = writeDismissedOnly\(raw, dismissed\)/.test(hook), 'a dismissed suggestion is kept on this computer in both modes; in daemon mode it is written into the stored store as it stands, never re-serialised')
  assert(!/updateLocal/.test(hook.slice(hook.indexOf('const tryFile'), hook.indexOf('const fileInto'))) && !/updateLocal/.test(hook.slice(hook.indexOf('const createDaemon'), hook.indexOf('const acceptHint'))), 'a filing or a create on the Prometheus never writes the local projects or filings')
  assert(/window\.beacon\.chatProjects\.run\(op\)/.test(hook) && !/daemon\.write|daemon\.get/.test(hook), 'the Prometheus is asked only through the hub, never through the generic daemon channels')
  assert(/if \(t\.kind === 'asked'\) \{\s*t = await tryFile\(sid, project\.id, '', \{ keep: true \}, project\)/.test(hook) && !/setAsked/.test(hook.slice(hook.indexOf('const acceptHint'), hook.indexOf('const dismissHints'))) && /if \(batching\.current\) return/.test(hook), "in a batch, a folder already chosen means filed as a label, never moved; it never opens or closes the person's own question, and a second click is ignored")
  const sidebar = src('src/renderer/src/components/Sidebar.tsx')
  assert(/const projects = useProjectsSource\(onSelect\)\s*const store = projects\.store/.test(sidebar) && !/SESSION_PROJECTS_SETTING_KEY|serializeProjectStore|updateStore/.test(sidebar), 'the sidebar draws projects.store and never touches the local store itself')
  assert(/const unpin = pinned\?\.\[sessionId\] \? \(\): void => onTogglePin\?\.\(sessionId, false\) : undefined\s*fileInto\(sessionId, target === 'unfiled' \? null : target, unpin\)/.test(sidebar) && !/if \(pinned\?\.\[sessionId\]\) onTogglePin\?\.\(sessionId, false\)\s*fileInto/.test(sidebar), 'a pinned row dragged into a project is unpinned once it is FILED, so a refused filing or a cancelled question leaves it as it was')
  assert(/const shownHints = projects\.hints \?\? hints/.test(sidebar) && !/hints\[row\.id\]|hints\[menuRow\.id\]/.test(sidebar), 'the suggestions are the Prometheus\'s in daemon mode, and what main works out in local mode')
  assert(/projects\.mode === 'daemon' \? \(\s*<button[\s\S]{0,200}data-testid="project-new-here"/.test(sidebar), '"New conversation here" is offered only in daemon mode')
  assert(/\{projects\.question \? <ProjectQuestion words=\{projects\.question\.words\} onAnswer=\{projects\.answer\} \/> : null\}/.test(sidebar), 'a question from the Prometheus is shown as a dialog')
}
