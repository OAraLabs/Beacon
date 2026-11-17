/**
 * Chat projects smoke (headless / ELECTRON_RUN_AS_NODE): Beacon's wire to the projects a Prometheus keeps (@shared/chat-projects) and
 * the hub in main that holds them (src/main/chat-projects.ts).
 *
 * Against what a REAL Prometheus answered (src/main/fixtures/chat_projects.json, recorded by scripts/record-chat-projects.py from the
 * daemon's own routes, nothing in it written by hand):
 *
 *   * every answer is read as what it is, and every refusal is one plain sentence, never a status code or a daemon word;
 *   * the requests Beacon builds are exactly the ones the daemon accepted in that recording;
 *   * GATED: a Prometheus that does not say it serves projects is asked NOTHING, and its state is "not available";
 *   * what a window may ask is checked in main: an id that a URL parser would read as more than one segment never reaches a path;
 *   * a connection replaced while a read is out: the late answer is dropped, never shown for the new Prometheus.
 */
import fixture from './fixtures/chat_projects.json'
import { readFileSync } from 'node:fs'
import {
  CHAT_PROJECTS_CAPABILITY,
  PROJECT_ROUTES,
  advertisesChatProjects,
  chatProjectWords,
  importKey,
  readChangeFrame,
  readFiled,
  readProjectDeleted,
  readProjectList,
  readProjectWrite,
  readStarted,
  readSuggestions,
  refusal,
  validOp,
  type ChatProjectsOp,
  type ChatProjectsState
} from '@shared/chat-projects'
import { ChatProjectsHub, type ProjectsRequest } from './chat-projects'
import { isProjectRoute } from './connection/rest'

const EXPECTED = 112
let failures = 0
let checks = 0
function assert(cond: boolean, label: string, detail?: unknown): void {
  checks++
  console.log(`[chat-projects-smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail !== undefined ? `  — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
  if (!cond) failures++
}
process.on('exit', () => {
  if (checks !== EXPECTED) {
    console.log(`[chat-projects-smoke] FAIL  ${checks} checks ran, expected ${EXPECTED}`)
    failures++
  }
  console.log(failures === 0 ? `[chat-projects-smoke] PASS (${checks} checks)` : `[chat-projects-smoke] ${failures} FAILED`)
  process.exitCode = failures === 0 ? 0 : 1
})

type Exchange = { label: string; as: string; method: string; path: string; request: unknown; status: number; body: unknown }
const exchanges = fixture.exchanges as Exchange[]
const ex = (label: string): Exchange => {
  const found = exchanges.filter((e) => e.label === label)
  if (found.length !== 1) throw new Error(`fixture: ${found.length} exchanges labelled ${JSON.stringify(label)}`)
  return found[0]
}
const WORDS = /HTTP|\b[45]\d\d\b|\/api\/|operator_only|name_taken|bad_folder|workspace_set|unknown_|machine_session|device_session|folder_in_use|chat_project/i
const sentence = (m: string): boolean => m.length > 10 && m.length < 140 && /[.]$/.test(m) && !WORDS.test(m)

// ── the recording ───────────────────────────────────────────────────────────────────────────────────────────────────────────
assert(typeof fixture.made_from === 'string' && fixture.made_from !== 'unknown' && exchanges.length === 41, 'the fixture says which daemon it came from, and holds its forty-one exchanges', fixture.made_from)
assert(advertisesChatProjects({ server_capabilities: fixture.capabilities }) && CHAT_PROJECTS_CAPABILITY === 'projects', 'the capability the daemon lists is the one Beacon looks for')
assert(!advertisesChatProjects({ server_capabilities: ['voice_input', 'approval_critical'] }) && !advertisesChatProjects({}) && !advertisesChatProjects(null) && !advertisesChatProjects({ server_capabilities: 'projects' }) && !advertisesChatProjects({ server_capabilities: [{ projects: true }] }), 'anything else, or nothing, or something malformed, is "no"')

// ── lists ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const none = readProjectList(ex('list, none yet').status, ex('list, none yet').body)
  assert(none.ok && none.value.role === 'owner' && none.value.rev === 0 && none.value.projects.length === 0 && none.value.skipped === 0, 'an empty list for the owner: rev 0, no projects')
  const full = readProjectList(ex('list').status, ex('list').body)
  assert(full.ok && full.value.projects.map((p) => p.name).join() === 'Kitchen remodel,Garden' && full.value.rev === 2, "the owner's list, in the daemon's order, with its rev")
  const k = full.ok ? full.value.projects[0] : null
  assert(!!k && k.id === 'cp_000000000001' && k.folderManaged === true && k.importKey === 'beacon-desktop:p1' && k.createdAt === 1793667600000 && k.instructionsRev === '' && k.files === 0, 'a project reads with its id, managed folder, import key and time in ms')
  const g = full.ok ? full.value.projects[1] : null
  assert(!!g && g.folderManaged === false && g.importKey === null && g.folder.endsWith('/home/repo'), 'a folder the owner picked is not managed, and has no import key')
  const chatOnly = readProjectList(ex('list, as a chat-only device').status, ex('list, as a chat-only device').body)
  assert(chatOnly.ok && chatOnly.value.role === 'chat_only' && chatOnly.value.rev === null && chatOnly.value.projects.length === 0, 'a device that may only chat is told nothing: an empty list, and no rev')
  const chatOnlyFiled = readProjectList(ex('list, as a chat-only device that has a conversation filed').status, ex('list, as a chat-only device that has a conversation filed').body)
  assert(chatOnlyFiled.ok && chatOnlyFiled.value.role === 'chat_only' && chatOnlyFiled.value.projects.length === 1 && chatOnlyFiled.value.skipped === 0 && chatOnlyFiled.value.projects[0].folder === '' && chatOnlyFiled.value.projects[0].sessions === 1, "a device that may only chat is told a project's name and how many of its conversations are in it, and no folder: that is read, not skipped")
  const odd = readProjectList(200, { role: 'owner', rev: 3, projects: [{ id: 'cp_1', name: 'ok', folder: '/x' }, { nope: true }, 'text', { id: 'cp_2', name: 'also ok', folder: '/y' }] })
  assert(odd.ok && odd.value.projects.length === 2 && odd.value.skipped === 2, 'an entry that cannot be read is counted, not silently dropped')
  const bad = readProjectList(200, { projects: 'many' })
  assert(!bad.ok && bad.kind === 'failed' && sentence(bad.message), 'a 200 that is not a list is a failure in plain words')
}

// ── refusals, in words ─────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const kinds: Array<[string, string]> = [
    ['create, a name taken (with another folder)', 'name_taken'],
    ['create, a folder already used', 'folder_in_use'],
    ['create, the home folder', 'bad_folder'],
    ['create, a folder that is not there', 'bad_folder'],
    ['create, no name', 'name_required'],
    ['create, a chat-only device', 'not_owner'],
    ['get, unknown', 'unknown_project'],
    ['rename, a name taken', 'name_taken'],
    ['file, a folder was chosen by hand', 'workspace_set'],
    ["file, a chat-only device's conversation", 'device_session'],
    ['file, a session the daemon does not have', 'unknown_session'],
    ['file, a machine session', 'machine_session'],
    ['file, a project that is not there', 'unknown_project'],
    ['file, as a chat-only device', 'not_owner'],
    ['start a conversation, a project that is not there', 'unknown_project'],
    ['suggestions, as a chat-only device', 'not_owner'],
    ['delete, a project that is not there', 'unknown_project'],
    ['delete, as a chat-only device', 'not_owner'],
    ['a route this daemon does not have', 'unsupported']
  ]
  for (const [label, kind] of kinds) {
    const e = ex(label)
    const r = refusal(e.status, e.body)
    assert(!r.ok && r.kind === kind && sentence(r.message) && r.status === e.status, `${label}: ${kind}, in a sentence`, r)
  }
  const hand = refusal(409, ex('file, a folder was chosen by hand').body)
  assert(!hand.ok && hand.workspace?.endsWith('/home/hand-picked') === true, 'the folder a conversation already works in comes back with the question about it')
  const home = refusal(400, ex('create, the home folder').body)
  assert(!home.ok && home.reason === "the home directory, or a folder that contains it, cannot be a project folder", "a folder the daemon won't use carries the daemon's own reason beside Beacon's sentence")
  assert(!refusal(0, null).ok && refusal(0, null).kind === 'unreachable' && refusal(401, null).kind === 'not_owner' && refusal(500, { error: 'boom' }).kind === 'failed' && refusal(404, { error: 'x', kind: 'unavailable' }).kind === 'unsupported', 'no answer, a refused key, a server error, and "no durable store" each have their own word')
  assert(refusal(404, { error: 'x', kind: 'made_up_by_a_newer_daemon' }).kind === 'failed' && refusal(409, { kind: 'made_up_by_a_newer_daemon' }).kind === 'failed' && refusal(404, { detail: 'Not Found' }).kind === 'unsupported' && refusal(405, null).kind === 'unsupported', 'a kind Beacon does not know is a failure, never believed and never taken for "no projects"; only a 404 with no kind of any sort is that')
  assert((['unsupported', 'not_owner', 'name_taken', 'name_required', 'folder_in_use', 'bad_folder', 'unknown_project', 'unknown_session', 'machine_session', 'workspace_set', 'device_session', 'unreachable', 'failed'] as const).every((k) => sentence(chatProjectWords(k))), 'every kind has a sentence with no status, route or daemon word in it')
}

// ── writes ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const made = readProjectWrite(ex('create, a managed folder').status, ex('create, a managed folder').body)
  assert(made.ok && made.value.created === true && made.value.project.name === 'Kitchen remodel', 'a create the daemon did: the project, and that it made it')
  const again = readProjectWrite(ex('create again, same import key').status, ex('create again, same import key').body)
  assert(again.ok && again.value.created === false && again.value.project.id === 'cp_000000000001', 'the same import key again: the project it already had, created: false')
  const byName = readProjectWrite(ex('create, same name in another case').status, ex('create, same name in another case').body)
  assert(byName.ok && byName.value.created === false && byName.value.project.id === 'cp_000000000001', 'the same name in another case: the project it already had')
  const picked = readProjectWrite(ex('create, a folder the owner picked').status, ex('create, a folder the owner picked').body)
  assert(picked.ok && picked.value.project.folderManaged === false, 'a folder the owner picked is made as it is')
  const renamed = readProjectWrite(ex('rename').status, ex('rename').body)
  assert(renamed.ok && renamed.value.project.name === 'Back garden' && renamed.value.created === null, 'a rename answers with the project; it was not "created"')
  const gone = readProjectDeleted(ex('delete').status, ex('delete').body)
  assert(gone.ok && gone.value.id === 'cp_000000000003' && gone.value.unfiled === 0, 'a delete: which, and how many conversations it left unfiled')
}

// ── filing and starting ────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const filed = readFiled(ex('file').status, ex('file').body)
  assert(filed.ok && filed.value.projectId === 'cp_000000000001' && filed.value.workspace?.endsWith('/projects-root/kitchen-remodel') === true, 'filed: the project, and the folder the conversation works in now')
  const label = readFiled(ex('file, as a label only (the folder is kept)').status, ex('file, as a label only (the folder is kept)').body)
  assert(label.ok && label.value.projectId === 'cp_000000000002' && label.value.workspace === null, 'filed as a label only: the conversation has no folder of its own, and filing it did not give it one')
  const out = readFiled(ex('file, unfile').status, ex('file, unfile').body)
  assert(out.ok && out.value.projectId === null, 'taken out of a project: no project')
  const replaced = readFiled(ex('file, replacing the hand-chosen folder').status, ex('file, replacing the hand-chosen folder').body)
  const deviceLabel = readFiled(ex('file a device\'s conversation as a label only').status, ex('file a device\'s conversation as a label only').body)
  assert(replaced.ok && deviceLabel.ok, 'the answers to the two questions the daemon can ask back are filings')
  const started = readStarted(ex('start a conversation inside a project').status, ex('start a conversation inside a project').body)
  assert(started.ok && started.value.projectId === 'cp_000000000002' && started.value.sessionId.startsWith('desktop:'), 'a conversation started in a project: its id, and the project')
  const list = ex('the session list carries the filing').body as Array<{ session_id: string; chat_project_id: string | null; has_chat_project_id: boolean }>
  assert(list.every((r) => r.has_chat_project_id), 'every row of the daemon\'s session list says which project it is filed in (null when none)')
}

// ── suggestions and frames ─────────────────────────────────────────────────────────────────────────────────────────────────
{
  const s = readSuggestions(ex('suggestions').status, ex('suggestions').body)
  assert(s.ok && Object.keys(s.value.suggestions).length === 2 && s.value.rev === 8, 'suggestions for two conversations, with the rev they were made at')
  const intoOld = s.ok ? s.value.suggestions[fixture.sessions.suggested_into_project] : undefined
  const intoNew = s.ok ? s.value.suggestions[fixture.sessions.suggested_new] : undefined
  assert(intoOld?.project?.id === 'cp_000000000002' && intoOld.calls === 3 && intoOld.share === 1, 'a suggestion for a folder that is a project names that project')
  assert(intoNew?.project === null && intoNew.label === 'new-thing', 'a suggestion for one that is not: no project, and the label a new one would get')
  const proto = readSuggestions(200, { suggestions: JSON.parse('{"__proto__":{"key":"k","label":"l","share":1,"calls":3,"project":null},"desktop:ok":{"key":"k2","label":"l2","share":1,"calls":3,"project":null}}'), rev: 1 })
  assert(proto.ok && Object.keys(proto.value.suggestions).join() === '__proto__,desktop:ok' && proto.value.suggestions['__proto__']?.key === 'k', 'a conversation id of __proto__ is an ordinary key: a suggestion for it is kept, not lost')
  const frames = fixture.frames.map((f) => readChangeFrame(f))
  assert(frames.every((f) => f !== null) && frames.map((f) => f?.change).join() === 'created,created,updated,membership,membership,membership,membership,membership,membership,created,deleted', 'every frame the daemon sent is read, in order, with its kind')
  assert(frames.every((f, i) => i === 0 || (f?.rev ?? 0) > (frames[i - 1]?.rev ?? 0)), 'each carries a rev that is higher than the one before')
  assert(fixture.device_got_frames === 0, 'a device that may only chat is sent none')
  assert(readChangeFrame({ type: 'approval_pending', payload: {} }) === null && readChangeFrame({ type: 'chat_project_changed', payload: { rev: 'x' } }) === null && readChangeFrame(null) === null, 'any other frame, or a malformed one, is nothing')
  assert(!JSON.stringify(fixture.frames).includes('/private/tmp'), 'no frame carries a folder path')
}

// ── what Beacon asks is what the daemon accepted ─────────────────────────────────────────────────────────────────────────────
{
  const same = (r: { method: string; path: string; body?: unknown }, label: string): boolean => {
    const e = ex(label)
    return r.method === e.method && r.path === e.path && JSON.stringify(r.body ?? null) === JSON.stringify(e.request ?? null)
  }
  assert(same(PROJECT_ROUTES.list(), 'list, none yet') && same(PROJECT_ROUTES.suggestions(), 'suggestions'), 'the list and suggestions requests')
  assert(same(PROJECT_ROUTES.create('Kitchen remodel', { importKey: 'beacon-desktop:p1' }), 'create, a managed folder'), 'a create with no folder and an import key')
  assert(same(PROJECT_ROUTES.create('Garden', { folder: (ex('create, a folder the owner picked').request as { folder: string }).folder }), 'create, a folder the owner picked'), 'a create with the folder the owner picked')
  assert(same(PROJECT_ROUTES.rename('cp_000000000002', 'Back garden'), 'rename'), 'a rename')
  assert(same(PROJECT_ROUTES.remove('cp_000000000003'), 'delete'), 'a delete')
  assert(same(PROJECT_ROUTES.file(fixture.sessions.filed, 'cp_000000000001'), 'file') && same(PROJECT_ROUTES.file(fixture.sessions.filed, null), 'file, unfile'), 'filing and taking out')
  assert(same(PROJECT_ROUTES.file(fixture.sessions.hand_chosen_folder, 'cp_000000000001', { replace: true }), 'file, replacing the hand-chosen folder'), 'filing and replacing the folder somebody chose')
  assert(same(PROJECT_ROUTES.file(fixture.sessions.label_only, 'cp_000000000002', { keep: true }), 'file, as a label only (the folder is kept)'), 'filing as a label only')
  assert(same(PROJECT_ROUTES.start('cp_000000000002'), 'start a conversation inside a project'), 'a conversation started in a project')
  assert(importKey('p1') === 'beacon-desktop:p1' && importKey('') === null && importKey('é') === null && importKey('x'.repeat(200)) === null && importKey('x'.repeat(185)) !== null && importKey('a b') === null && importKey('a\tb') === null, 'an import key is printable ASCII with no space, at most 200 characters, or none')
}

// ── a route a window may ask, and an id that is one segment ─────────────────────────────────────────────────────────────────
{
  const yes: Array<[string, string]> = [['GET', '/api/chat-projects'], ['POST', '/api/chat-projects'], ['PUT', '/api/chat-projects/cp_000000000001'], ['DELETE', '/api/chat-projects/cp_000000000001'], ['GET', '/api/chat-project-suggestions'], ['PUT', '/api/sessions/desktop%3Aabc/project'], ['POST', '/api/sessions'], ['GET', '/api/sessions']]
  assert(yes.every(([m, p]) => isProjectRoute(m, p)), 'each project route, with its own method, is allowed')
  const no: Array<[string, string]> = [
    ['POST', '/api/chat-projects/cp_1'], ['PUT', '/api/sessions'], ['DELETE', '/api/sessions'], ['DELETE', '/api/sessions/x/project'], ['PUT', '/api/approvals/x/approve'],
    ['GET', '/api/chat-projects/..'], ['PUT', '/api/chat-projects/.'], ['PUT', '/api/sessions/../project'], ['PUT', '/api/sessions/%2e%2e/project'],
    ['DELETE', '/api/chat-projects/%2E%2E'], ['PUT', '/api/sessions/a%2fb/project'], ['PUT', '/api/sessions/a%5cb/project'], ['PUT', '/api/sessions/a\\b/project'],
    ['GET', '/api/chat-projects/cp_1?x=/../approvals'], ['PUT', '/api/sessions/.\t./project'], ['PUT', '/api/sessions/.\n./project'], ['PUT', '/api/sessions/a b/project'], ['GET', '/api/chat-projects/cp_1\r'], ['GET', '/api/chat-projects/x/files'], ['GET', '/api/chat-projects/']
  ]
  assert(no.every(([m, p]) => !isProjectRoute(m, p)), 'another method, another path, a dot segment (written or encoded), an encoded slash or backslash, a query, or a path under a project that is not a route: none is')
  const ok = (o: unknown): boolean => validOp(o) !== null
  assert(ok({ op: 'refresh' }) && ok({ op: 'create', name: 'A' }) && ok({ op: 'create', name: 'A', importKey: 'beacon-desktop:p1' }) && ok({ op: 'rename', id: 'cp_1', name: 'B' }) && ok({ op: 'remove', id: 'cp_1' }) && ok({ op: 'file', sessionId: 'desktop:abc', projectId: null }) && ok({ op: 'file', sessionId: 'desktop:abc', projectId: 'cp_1', keep: true }) && ok({ op: 'start', projectId: 'cp_1' }), 'every operation the window can ask, in its good shapes, is accepted')
  const bad: unknown[] = [null, 'create', 5, {}, { op: 'nope' }, { op: 'create' }, { op: 'create', name: '' }, { op: 'create', name: 'x'.repeat(201) }, { op: 'create', name: 5 }, { op: 'create', name: 'A', importKey: 5 }, { op: 'create', name: 'A', importKey: '' },
    { op: 'rename', id: 'cp_1' }, { op: 'rename', name: 'B' }, { op: 'remove', id: '' }, { op: 'remove', id: '..' }, { op: 'remove', id: '.' }, { op: 'remove', id: 'a/b' }, { op: 'remove', id: 'a%2fb' }, { op: 'remove', id: 'a b' }, { op: 'remove', id: 'a?b' }, { op: 'remove', id: 'a\\b' }, { op: 'remove', id: 'é' }, { op: 'remove', id: 'x'.repeat(121) },
    { op: 'file', sessionId: 'desktop:abc' }, { op: 'file', sessionId: 'desktop:abc', projectId: 5 }, { op: 'file', sessionId: '..', projectId: null }, { op: 'file', sessionId: 'desktop:abc', projectId: '../x' }, { op: 'file', sessionId: 'desktop:abc', projectId: null, keep: 'yes' }, { op: 'file', sessionId: 'desktop:abc', projectId: null, replace: 1 },
    { op: 'start' }, { op: 'start', projectId: '..' }]
  assert(bad.every((o) => validOp(o) === null), 'a malformed op, an id that is not one plain segment, a flag that is not true or false: refused, never forwarded')
  const v = validOp({ op: 'file', sessionId: 'desktop:abc', projectId: 'cp_1', keep: true, extra: 'ignored', __proto__: { keep: false } }) as Extract<ChatProjectsOp, { op: 'file' }> | null
  assert(v?.op === 'file' && v.keep === true && !('extra' in v), 'only the fields an op has are kept')
}

// ── main wires it the way this file says ────────────────────────────────────────────────────────────────────────────────────────
{
  const src = (rel: string): string => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8')
  const main = src('src/main/index.ts')
  assert(/const projects = new ChatProjectsHub\(\{\s*request: \(method, path, body\) => conn\.projectsCall\(method, path, body\)/.test(main) && !/new ChatProjectsHub/.test(main.replace(/const projects = new ChatProjectsHub/, '')), 'one hub is made for each connection, and it asks through THAT connection: never whichever one is current later')
  assert(/projects\.onGatewayEvent\(ev as \{ type\?: string; payload\?: unknown \}\)/.test(main) && /onListed: \(rows\) => projects\.setFilings\(rows\)/.test(main), "the hub hears the connection's frames and the daemon's session list")
  assert(/if \(chatProjects !== projects\) return[\s\S]{0,400}broadcast\(IPC\.CHAT_PROJECTS_CHANGED, s\)/.test(main) && /registerChatProjectsHandlers\(\(\) => chatProjects, \(\) => chatContent\)/.test(main), 'a hub that has been replaced says nothing to the window, and the window reaches only the current one')
  assert(/chatProjects\?\.reset\(\) \/\/ the one for the connection before this/.test(main) && /chatProjects\?\.reset\(\)\s*chatProjects = null\s*chatContent = null\s*broadcast\(IPC\.CHAT_PROJECTS_CHANGED, noChatProjects\(\)\)/.test(main), 'a connection that is replaced, or forgotten with its key, takes its hub with it: nothing more is asked of that Prometheus, and the window is told there are no projects')
  assert(/if \(r\.status === 0\) throw Object\.assign/.test(src('src/main/connection/index.ts')), 'no answer at all is never taken for an answer the key was tried on: it cannot clear a refused key')
  const ipc = src('src/main/chat-projects-ipc.ts')
  assert(/const op = validOp\(raw\)\s*if \(!op\) return refusal\(400, null\)\s*const hub = current\(\)/.test(ipc) && (ipc.match(/handleFromShell\(/g) ?? []).length === 3 && !/ipcMain/.test(ipc), 'the window can ask only through three shell-checked handlers, and an op is validated before it reaches the hub')
  const rest = src('src/main/connection/rest.ts')
  assert(/async projectsCall\([^)]*\)[\s\S]{0,90}?\{\s*if \(!isProjectRoute\(method, path\) && !isProjectContentRoute\(method, path\)\) throw/.test(rest) && /async projectsBytes\([^)]*\)[\s\S]{0,400}?\{\s*if \(!isProjectContentRoute\(method, path\)\) throw/.test(rest), 'the REST client refuses any path that is not one of the project routes before it sends anything, and the bytes call only the instructions and files routes')
  const hub = src('src/main/chat-projects.ts')
  assert(/async run\(op: ChatProjectsOp\)[\s\S]{0,60}?\{\s*if \(!this\.available\) return refusal\(404, null\)/.test(hub), 'and the hub answers "unsupported" before it builds a request, whatever was asked')
}

// ── the hub ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// A Prometheus that answers from the recording: a request is matched by method, path and body, and one the recording has no answer for
// fails the check (it would be a request the daemon never accepted).
function world(): { hub: ChatProjectsHub; asked: string[]; states: ChatProjectsState[]; latest: () => ChatProjectsState; hold: { on: boolean; release: () => void } } {
  const asked: string[] = []
  const states: ChatProjectsState[] = []
  const hold = { on: false, release: () => undefined as void }
  const request: ProjectsRequest = async (method, path, body) => {
    asked.push(`${method} ${path}`)
    const e = exchanges.find((x) => x.method === method && x.path === path && JSON.stringify(x.request ?? null) === JSON.stringify(body ?? null) && x.as === 'op')
    if (!e) throw new Error(`no recorded answer for ${method} ${path} ${JSON.stringify(body)}`)
    if (hold.on) await new Promise<void>((res) => (hold.release = () => res()))
    return { status: e.status, body: e.body }
  }
  const hub = new ChatProjectsHub({ request, onState: (s) => states.push(s) })
  return { hub, asked, states, latest: () => states[states.length - 1] ?? hub.state(), hold }
}
const subscribed = (caps: string[]): { type: string; payload: unknown } => ({ type: 'subscribed', payload: { server_capabilities: caps } })
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10))

async function hubChecks(): Promise<void> {
{
  // Not served: nothing asked, nothing available.
  const w = world()
  w.hub.onGatewayEvent(subscribed(['voice_input', 'approval_critical']))
  const results = [
    await w.hub.run({ op: 'refresh' }),
    await w.hub.run({ op: 'create', name: 'A' }),
    await w.hub.run({ op: 'rename', id: 'cp_1', name: 'B' }),
    await w.hub.run({ op: 'remove', id: 'cp_1' }),
    await w.hub.run({ op: 'file', sessionId: 'desktop:x', projectId: 'cp_1' }),
    await w.hub.run({ op: 'start', projectId: 'cp_1' })
  ]
  w.hub.setFilings([{ id: 'desktop:x', chatProjectId: 'cp_1' }])
  w.hub.onGatewayEvent({ type: 'chat_project_changed', payload: { rev: 9, project_id: 'cp_1', change: 'created', session_id: null } })
  await settle()
  assert(w.asked.length === 0, 'a Prometheus that does not say it serves projects is asked nothing: not a list, not a change, not a frame\'s follow-up')
  assert(results.every((r) => !r.ok && r.kind === 'unsupported' && sentence(r.message)), 'and every change the window asks for is "unsupported", in words')
  assert(w.hub.state().available === false && w.hub.state().list === null && Object.keys(w.hub.state().filings).length === 0, 'and its state is "not available", with nothing in it')
}
{
  // Served: the list and the suggestions are read once the daemon says so.
  const w = world()
  w.hub.onGatewayEvent(subscribed(['voice_input', 'projects']))
  await settle()
  assert(w.asked.join('|') === 'GET /api/chat-projects|GET /api/chat-project-suggestions' && w.latest().available && w.latest().list?.projects.length === 0, 'when the daemon says it serves projects, Beacon reads the list and the suggestions, and nothing else')
}
{
  // Operations update the state from the answer, then read again.
  const w = world()
  w.hub.onGatewayEvent(subscribed(['projects']))
  await settle()
  const made = await w.hub.run({ op: 'create', name: 'Kitchen remodel', importKey: 'beacon-desktop:p1' })
  assert(made.ok && made.project?.id === 'cp_000000000001' && made.created === true && w.hub.state().list?.projects.some((p) => p.id === 'cp_000000000001') === true, 'a create is in the list at once, from the daemon\'s answer')
  const filed = await w.hub.run({ op: 'file', sessionId: fixture.sessions.filed, projectId: 'cp_000000000001' })
  assert(filed.ok && w.hub.state().filings[fixture.sessions.filed] === 'cp_000000000001', 'a filing shows in the state from the answer')
  const unfiled = await w.hub.run({ op: 'file', sessionId: fixture.sessions.filed, projectId: null })
  assert(unfiled.ok && !(fixture.sessions.filed in w.hub.state().filings), 'taking a conversation out of a project removes it from the filings')
  const refused = await w.hub.run({ op: 'file', sessionId: 'desktop:gone', projectId: 'cp_000000000001', keep: true })
  assert(!refused.ok && refused.kind === 'unknown_session', 'a refusal comes back as the sentence, and changes nothing')
  const noKeep = await w.hub.run({ op: 'file', sessionId: fixture.sessions.hand_chosen_folder, projectId: 'cp_000000000001' })
  assert(!noKeep.ok && noKeep.kind === 'workspace_set' && noKeep.workspace?.endsWith('/home/hand-picked') === true, 'a conversation whose folder was chosen by hand comes back as a question, with that folder')
  const kept = await w.hub.run({ op: 'file', sessionId: fixture.sessions.label_only, projectId: 'cp_000000000002', keep: true })
  assert(kept.ok, 'and the answer "keep it" files it as a label')
  const started = await w.hub.run({ op: 'start', projectId: 'cp_000000000002' })
  assert(started.ok && typeof started.sessionId === 'string' && w.hub.state().filings[started.sessionId ?? ''] === 'cp_000000000002', 'a conversation started in a project is filed in it')
}
{
  // Frames: a rev we have changes nothing; a rev we don't is read again.
  const w = world()
  w.hub.onGatewayEvent(subscribed(['projects']))
  await settle()
  const before = w.asked.length
  w.hub.onGatewayEvent({ type: 'chat_project_changed', payload: { rev: 0, project_id: null, change: 'created', session_id: null } })
  await settle()
  assert(w.asked.length === before, 'a frame with the rev Beacon already has asks nothing')
  w.hub.onGatewayEvent({ type: 'chat_project_changed', payload: { rev: 5, project_id: 'cp_000000000001', change: 'updated', session_id: null } })
  await settle()
  assert(w.asked.length === before + 2, 'a frame with a rev Beacon does not have makes it read the list again')
  w.hub.onGatewayEvent({ type: 'approval_pending', payload: { request_id: 'x' } })
  w.hub.onGatewayEvent({ type: 'chat_project_changed', payload: { rev: 'x' } })
  await settle()
  assert(w.asked.length === before + 2, 'another frame, or a malformed one, asks nothing')
}
{
  // A rollback to a Prometheus that no longer serves them; a new connection; a late answer.
  const w = world()
  w.hub.onGatewayEvent(subscribed(['projects']))
  await settle()
  w.hub.onGatewayEvent(subscribed(['voice_input']))
  assert(w.hub.state().available === false && w.hub.state().list === null, 'a Prometheus rolled back to one without projects is "not available" at once, and the list is gone')
  const gone = await w.hub.run({ op: 'refresh' })
  assert(!gone.ok && gone.kind === 'unsupported' && w.asked.length === 2, 'and nothing more is asked')

}
  // An answer that lands after the connection was replaced is dropped. The old read answers with projects the new one does not have.
  {
    let release: () => void = () => undefined
    let calls = 0
    const recorded = (label: string): { status: number; body: unknown } => ({ status: ex(label).status, body: ex(label).body })
    const stub: ProjectsRequest = async (method, path) => {
      if (method === 'GET' && path === '/api/chat-projects') {
        calls++
        if (calls === 1) {
          await new Promise<void>((res) => (release = res))
          return recorded('list') // two projects: what the replaced connection's Prometheus would have said
        }
        return recorded('list, none yet')
      }
      return recorded('suggestions')
    }
    const hub = new ChatProjectsHub({ request: stub, onState: () => undefined })
    hub.onGatewayEvent(subscribed(['projects']))
    await settle()
    hub.reset()
    hub.onGatewayEvent(subscribed(['projects'])) // the next connection, which also serves projects
    await settle()
    release()
    await settle()
    await settle()
    assert(hub.state().available && hub.state().list?.projects.length === 0 && hub.state().list?.rev === 0, 'an answer from the replaced connection lands after the new one has read its own list: it is dropped, and the new list stands')
  }
  {
    const hold = { release: () => undefined as void }
    const asked3: string[] = []
    const stub: ProjectsRequest = async (method, path) => {
      asked3.push(`${method} ${path}`)
      if (method === 'POST') {
        await new Promise<void>((res) => (hold.release = res))
        return { status: ex('create, a managed folder').status, body: ex('create, a managed folder').body }
      }
      const label = path === '/api/chat-projects' ? 'list, none yet' : 'suggestions'
      return { status: ex(label).status, body: ex(label).body }
    }
    const hub = new ChatProjectsHub({ request: stub, onState: () => undefined })
    hub.onGatewayEvent(subscribed(['projects']))
    await settle()
    const pending = hub.run({ op: 'create', name: 'Kitchen remodel', importKey: 'beacon-desktop:p1' })
    await settle()
    hub.reset()
    hub.onGatewayEvent(subscribed(['projects']))
    await settle()
    const readsBefore = asked3.length
    hold.release()
    const result = await pending
    await settle()
    assert(!result.ok && result.kind === 'unreachable' && !hub.state().list?.projects.some((p) => p.id === 'cp_000000000001') && asked3.length === readsBefore, "a change that was out when the connection was replaced is refused, not applied to the new Prometheus's list, and starts no read of its own")
  }
  {
    // A read under way when the Prometheus is rolled back, and upgraded again: the hub reads again (it does not wait on a dead read).
    const w3 = world()
    w3.hold.on = true
    w3.hub.onGatewayEvent(subscribed(['projects']))
    await settle()
    w3.hub.onGatewayEvent(subscribed(['voice_input']))
    w3.hold.on = false
    w3.hold.release()
    await settle()
    const before = w3.asked.length
    w3.hub.onGatewayEvent(subscribed(['projects']))
    await settle()
    assert(w3.asked.length === before + 2 && w3.hub.state().list !== null, 'a Prometheus rolled back during a read, then upgraded again: the list is read again, not left empty behind a read that will never finish')
  }
  {
    // A reconnect to the same Prometheus misses frames: the list is read again.
    const w4 = world()
    w4.hub.onGatewayEvent(subscribed(['projects']))
    await settle()
    const before = w4.asked.length
    w4.hub.onGatewayEvent(subscribed(['projects']))
    await settle()
    assert(w4.asked.length === before + 2, 'a reconnect whose reply still says it serves projects reads the list again: changes made while the socket was down sent Beacon no frame')
  }
  {
    const co = world()
    co.hold.on = true
    co.hub.onGatewayEvent(subscribed(['projects']))
    await settle()
    void co.hub.refresh()
    void co.hub.refresh()
    void co.hub.refresh()
    await settle()
    const during = co.asked.length
    co.hold.on = false
    co.hold.release()
    await settle()
    await settle()
    assert(during === 1 && co.asked.length === 4, 'reads are one at a time: three asks while one is out make exactly one more read (a list and the suggestions), not three', { during, total: co.asked.length })
  }
{
  // Whether Beacon has heard what the Prometheus does: a reply, or the end of the wait for one (an old Prometheus never replies).
  const quiet = new ChatProjectsHub({ request: async () => ({ status: 200, body: null }), onState: () => undefined, decideAfterMs: 40 })
  assert(quiet.state().known === false && quiet.state().available === false, 'before the Prometheus has said anything, its state is "not known yet", which is not "no projects"')
  await new Promise((r) => setTimeout(r, 90))
  assert(quiet.state().known === true && quiet.state().available === false, 'one that stays silent is taken to serve none, once the wait is over')
  const replies = new ChatProjectsHub({ request: async () => ({ status: 200, body: null }), onState: () => undefined, decideAfterMs: 5000 })
  replies.onGatewayEvent(subscribed(['voice_input']))
  assert(replies.state().known === true && replies.state().available === false, 'one that replies without projects is known at once, without waiting')
  replies.reset()
  assert(replies.state().known === false, 'a new connection starts not knowing again')
}
{
  // What the move of the local projects tells the window.
  const w = world()
  const note = { status: 'done' as const, projects: 2, moved: 3, leftovers: 1, alreadyFiled: 0, skippedProjects: 0, message: null, fresh: true }
  w.hub.setMigration(note)
  assert(w.hub.state().migration === null, 'a Prometheus that does not serve projects has no move to report')
  w.hub.onGatewayEvent(subscribed(['projects']))
  await settle()
  w.hub.setMigration(note)
  assert(w.hub.state().migration?.moved === 3 && w.states.at(-1)?.migration?.status === 'done', 'what the move did is in the state the window is sent')
  w.hub.reset()
  assert(w.hub.state().migration === null, 'and goes with the connection')
}
{
  // Filings from the session list.
  const w = world()
  w.hub.setFilings([{ id: 'desktop:early', chatProjectId: 'cp_000000000001' }]) // the list can land before the daemon has said anything
  assert(Object.keys(w.hub.state().filings).length === 0 && w.asked.length === 0, 'a session list that lands before the daemon says it serves projects shows nothing and asks nothing')
  w.hub.onGatewayEvent(subscribed(['projects']))
  await settle()
  assert(JSON.stringify(w.hub.state().filings) === '{"desktop:early":"cp_000000000001"}', 'but it is kept, and shown once the daemon says it does')
  w.hub.setFilings([{ id: 'desktop:a', chatProjectId: 'cp_000000000001' }, { id: 'desktop:b', chatProjectId: null }, { id: 'desktop:c' }])
  assert(JSON.stringify(w.hub.state().filings) === '{"desktop:a":"cp_000000000001"}', "the daemon's session list says which conversation is filed where; unfiled ones are absent")
  w.hub.setFilings([{ id: 'desktop:a' }, { id: 'desktop:b' }])
  assert(JSON.stringify(w.hub.state().filings) === '{"desktop:a":"cp_000000000001"}', 'a daemon that says nothing about projects in its list leaves what Beacon has alone')
  w.hub.setFilings([])
  assert(Object.keys(w.hub.state().filings).length === 0, 'an empty list from a daemon that serves projects says nothing is filed')
}
}
hubChecks().catch((e) => {
  console.log(`[chat-projects-smoke] FAIL  the hub checks threw: ${e instanceof Error ? e.message : String(e)}`)
  failures++
})
