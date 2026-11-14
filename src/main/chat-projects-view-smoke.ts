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
  batchNote,
  filingOutcome,
  hintsFromDaemon,
  localHasProjects,
  parseMigrated,
  projectsMode,
  questionWords,
  shortFolder,
  storeFromDaemon
} from '@shared/chat-projects-view'
import { classifiedScope } from '@shared/daemon-profiles'
import { emptyProjectStore, rowSuggestion, type ProjectStore } from '@shared/session-projects'

const EXPECTED = 46
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
  available: true,
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
const mode = (state: ChatProjectsState, migrated: boolean | null, local: ProjectStore | null): string => projectsMode({ state, migrated, local })
assert(mode(noChatProjects(), true, localEmpty) === 'local' && mode(noChatProjects(), false, localFull) === 'local', 'a Prometheus that does not serve projects: local, whatever the flag says')
assert(mode({ ...served, available: false }, true, localEmpty) === 'local' && mode({ ...served, list: null }, true, localEmpty) === 'local', 'not available, or not read yet: local')
const chatOnly = readProjectList(ex('list, as a chat-only device').status, ex('list, as a chat-only device').body)
assert(chatOnly.ok && mode({ ...served, list: chatOnly.value }, true, localEmpty) === 'local', 'a Beacon that is not the owner (a device that may only chat) keeps its local projects: it could change none of the daemon\'s')
assert(mode(served, null, localEmpty) === 'local' && mode(served, true, null) === 'local' && mode(served, null, null) === 'local', 'while the flag or the local store is still being read: local, so nothing flickers')
assert(mode(served, true, localFull) === 'daemon', 'the local projects have been moved: the Prometheus\'s are drawn')
assert(mode(served, false, localEmpty) === 'daemon', 'there were none to move: the Prometheus\'s are drawn')
assert(mode(served, false, localFull) === 'local' && mode(served, false, localOnlyAssign) === 'local', 'local projects that have not been moved keep being drawn, and are not touched')

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
  assert(out.kind === 'done' && out.note === null, 'taken out of a project: nothing to say')
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
  assert(batchNote(1).startsWith('One conversation') && batchNote(3).startsWith('3 conversations') && /without changing/.test(batchNote(3)), 'a batch filed as labels says so')
}

// ── the code the sidebar runs ──────────────────────────────────────────────────────────────────────────────────────────────────
{
  const src = (rel: string): string => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8')
  const hook = src('src/renderer/src/projects-source.ts')
  assert(/const mode = projectsMode\(\{ state, migrated, local: localLoaded \? local : null \}\)/.test(hook) && /const store = daemon \? storeFromDaemon\(state, local\.dismissed\) : local/.test(hook), 'which projects are drawn is decided by projectsMode, and nowhere else')
  const updateLocal = hook.slice(hook.indexOf('const updateLocal'), hook.indexOf('// ── the Prometheus'))
  assert(/if \(!loaded\.current\) return/.test(updateLocal) && /settings\.set\(SESSION_PROJECTS_SETTING_KEY, serializeProjectStore\(next\)\)/.test(updateLocal) && (hook.match(/SESSION_PROJECTS_SETTING_KEY/g) ?? []).length === 3, 'this computer\'s store is written in one place, and only after it has been read')
  const daemonOnly = (name: string): string => hook.slice(hook.indexOf(`const ${name} =`), hook.indexOf(`const ${name} =`) + 900)
  assert(/if \(!daemon\) return updateLocal\(\(s\) => assignSession\(s, sessionId, projectId\)\)\s*void fileDaemon/.test(hook) && /if \(!daemon\) \{\s*updateLocal\(\(s\) => \{\s*const made = createProject\(s, label\)/.test(daemonOnly('acceptHint')), 'in local mode a filing and an accepted suggestion are the code they always were; in daemon mode they are asked of the Prometheus')
  assert(/const dismissHints = \(items[^)]*\): void =>\s*updateLocal\(\(s\) => items\.reduce\(\(acc, it\) => dismissSuggestion\(acc, it\.sessionId, it\.key\), s\)\)/.test(hook), 'a dismissed suggestion is kept on this computer in both modes, and touches nothing else in the store')
  assert(!/updateLocal/.test(hook.slice(hook.indexOf('const fileDaemon'), hook.indexOf('const fileInto'))) && !/updateLocal/.test(hook.slice(hook.indexOf('const createDaemon'), hook.indexOf('const acceptHint'))), 'a filing or a create on the Prometheus never writes the local projects or filings')
  assert(/window\.beacon\.chatProjects\.run\(op\)/.test(hook) && !/daemon\.write|daemon\.get/.test(hook), 'the Prometheus is asked only through the hub, never through the generic daemon channels')
  assert(/setAsked\(null\)\s*if \(await fileDaemon\(sid, project\.id, '', \{ keep: true \}, project\)\) left\+\+/.test(hook), 'in a batch, a folder already chosen means filed as a label, never moved')
  const sidebar = src('src/renderer/src/components/Sidebar.tsx')
  assert(/const projects = useProjectsSource\(onSelect\)\s*const store = projects\.store/.test(sidebar) && !/SESSION_PROJECTS_SETTING_KEY|serializeProjectStore|updateStore/.test(sidebar), 'the sidebar draws projects.store and never touches the local store itself')
  assert(/const shownHints = projects\.hints \?\? hints/.test(sidebar) && !/hints\[row\.id\]|hints\[menuRow\.id\]/.test(sidebar), 'the suggestions are the Prometheus\'s in daemon mode, and what main works out in local mode')
  assert(/projects\.mode === 'daemon' \? \(\s*<button[\s\S]{0,200}data-testid="project-new-here"/.test(sidebar), '"New conversation here" is offered only in daemon mode')
  assert(/\{projects\.question \? <ProjectQuestion words=\{projects\.question\.words\} onAnswer=\{projects\.answer\} \/> : null\}/.test(sidebar), 'a question from the Prometheus is shown as a dialog')
}
