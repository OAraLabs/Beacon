/**
 * Chat project content smoke (headless / ELECTRON_RUN_AS_NODE): a project's instructions and reference files on the Prometheus that
 * keeps it (@shared/chat-projects-content, src/main/chat-projects-content.ts).
 *
 * Against what a REAL Prometheus answered (`content` in src/main/fixtures/chat_projects.json, recorded by scripts/record-chat-projects.py):
 *
 *   * every answer is read as what it is; every refusal is one plain sentence, and a conflict carries the text it conflicts with;
 *   * the requests Beacon builds are exactly the ones the daemon accepted, byte for byte (the file's bytes are the body, not base64);
 *   * GATED: a Prometheus that does not serve projects is asked nothing, by any of the six operations;
 *   * the window never names a path on this computer: files come from the system's panel, and nothing is read that is too large, or
 *     is not a plain file, before it is read;
 *   * a connection replaced while a call is out: its late answer is dropped, and a downloaded file is not written for it.
 */
import fixture from './fixtures/chat_projects.json'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CONTENT_ROUTES,
  MAX_FILE_BYTES,
  readFileDeleted,
  readFileWritten,
  readFiles,
  readInstructions,
  readInstructionsSaved,
  validContentOp,
  withReplace,
  type ContentResult
} from '@shared/chat-projects-content'
import { describeFile, effectiveNote, formatBytes } from '@shared/chat-projects-content-view'
import { chatProjectWords } from '@shared/chat-projects'
import { ChatProjectContent, type ContentPanels, type ProjectsBytes } from './chat-projects-content'
import type { ProjectsRequest } from './chat-projects'
import { RestClient, isProjectContentRoute, isProjectRoute } from './connection/rest'

const EXPECTED = 69
let failures = 0
let checks = 0
function assert(cond: boolean, label: string, detail?: unknown): void {
  checks++
  console.log(`[chat-projects-content-smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail !== undefined ? `  — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
  if (!cond) failures++
}
process.on('exit', () => {
  if (checks !== EXPECTED) {
    console.log(`[chat-projects-content-smoke] FAIL  ${checks} checks ran, expected ${EXPECTED}`)
    failures++
  }
  console.log(failures === 0 ? `[chat-projects-content-smoke] PASS (${checks} checks)` : `[chat-projects-content-smoke] ${failures} FAILED`)
  process.exitCode = failures === 0 ? 0 : 1
})

type Exchange = { label: string; as: string; method: string; path: string; request: unknown; status: number; body?: unknown; bytes_b64?: string; headers?: Record<string, string> }
const content = fixture.content as unknown as { exchanges: Exchange[]; frames: Array<{ type: string; payload: Record<string, unknown> }>; project: string }
const ex = (label: string): Exchange => {
  const found = content.exchanges.filter((e) => e.label === label)
  if (found.length !== 1) throw new Error(`fixture: ${found.length} exchanges labelled ${JSON.stringify(label)}`)
  return found[0]
}
const P = content.project
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')

// ── what each answer is read as ───────────────────────────────────────────────────────────────────────────────────────────────
{
  const none = readInstructions(ex('instructions, none yet').status, ex('instructions, none yet').body)
  assert(none.ok && none.value.content === '' && none.value.rev === '' && none.value.maxChars === 12000 && none.value.effective.length === 0, 'no instructions yet: empty text, the empty revision a first save is made from, the limit the loader reads')
  const some = readInstructions(ex('instructions').status, ex('instructions').body)
  assert(some.ok && some.value.content === 'Be brief.' && some.value.rev === '213c22ed7234eb11' && some.value.effective.length === 1 && some.value.effective[0].chars === 9 && !some.value.effective[0].omitted && !some.value.effective[0].truncated, 'instructions: the text, its revision, and the file the loader reads')
  const shadow = readInstructions(ex('instructions where another convention file is').status, ex('instructions where another convention file is').body)
  assert(shadow.ok && shadow.value.effective.length === 1 && /CLAUDE\.md$/.test(shadow.value.effective[0].path), "another convention file there is shown as what the loader reads")
  const odd = readInstructions(200, { content: 'x', rev: 'r', effective: [{ path: 'a', chars: 1, truncated: true, omitted: true, shadowed_by: 'b/CLAUDE.md', symlink: true }, 5, { chars: 3 }] })
  assert(odd.ok && odd.value.effective.length === 1 && odd.value.effective[0].truncated && odd.value.effective[0].omitted && odd.value.effective[0].shadowedBy === 'b/CLAUDE.md' && odd.value.effective[0].symlink && odd.value.maxChars === 12000, 'a file the loader cuts, leaves out or reads past another is marked; a row that is not one is dropped')
  const saved = readInstructionsSaved(ex('save instructions').status, ex('save instructions').body)
  assert(saved.ok && saved.value.rev === '213c22ed7234eb11', 'a save answers the new revision')
  const conflict = readInstructionsSaved(ex('save, but somebody saved since (a stale revision)').status, ex('save, but somebody saved since (a stale revision)').body)
  assert(!conflict.ok && conflict.kind === 'conflict' && conflict.current?.content === 'Be brief.' && conflict.current.rev === '213c22ed7234eb11' && conflict.message === chatProjectWords('conflict'), 'a save from a stale revision is a conflict that carries the text it conflicts with and its revision')
  const would = readInstructionsSaved(ex('save that would shadow it').status, ex('save that would shadow it').body)
  assert(!would.ok && would.kind === 'would_shadow' && JSON.stringify(would.shadowed) === '["CLAUDE.md"]', 'a save that would stop another file being read says which')
  const long = readInstructionsSaved(ex('save, too long').status, ex('save, too long').body)
  assert(!long.ok && long.kind === 'too_long', 'a text longer than the loader reads is refused as that')
  const bad = readInstructionsSaved(ex('save, not a text').status, ex('save, not a text').body)
  assert(!bad.ok && bad.kind === 'failed', 'a request the daemon calls malformed is a failure in plain words, never its own')
  const folder = readInstructions(ex("instructions, the file is a folder").status, ex("instructions, the file is a folder").body)
  const gone = readInstructions(ex("instructions, the project's folder was deleted").status, ex("instructions, the project's folder was deleted").body)
  assert(!folder.ok && folder.kind === 'not_a_file' && !gone.ok && gone.kind === 'folder_missing', "a folder where the instructions file is, and a project whose folder is gone, are said as such")
  const chatOnly = readInstructions(403, ex('instructions, as a chat-only device').body)
  const nope = readInstructions(404, ex('instructions, a project that is not there').body)
  assert(!chatOnly.ok && chatOnly.kind === 'not_owner' && !nope.ok && nope.kind === 'unknown_project', 'a device that may only chat is told so; a project that is gone is told so')
  const garbage = [readInstructions(200, { content: 5, rev: 'x' }), readInstructions(200, null), readFiles(200, { files: 'no' }), readFileWritten(200, { ok: true }), readFileDeleted(200, {})]
  assert(garbage.every((g) => !g.ok && g.kind === 'failed'), 'a 200 that is not what the route sends is a failure, never an empty success')
}
{
  const files = readFiles(ex('files').status, ex('files').body)
  assert(files.ok && files.value.length === 3 && files.value[0].name === 'notes.md' && files.value[0].size === 27 && files.value[0].mime === 'text/markdown' && files.value[0].modified === 1793667600000, 'files: name, size, kind, and the time in milliseconds')
  assert(files.ok && files.value[2].name === 'résumé draft.txt', 'a name with accents and a space is read as written')
  const empty = readFiles(ex('files, none yet').status, ex('files, none yet').body)
  assert(empty.ok && empty.value.length === 0, 'no files yet is an empty list')
  const w = readFileWritten(ex('add a file').status, ex('add a file').body)
  assert(w.ok && w.value.name === 'notes.md' && w.value.size === 18, 'an upload answers the file as it is now')
  const again = readFileWritten(ex('add it again').status, ex('add it again').body)
  const hidden = readFileWritten(ex('add a file, a name that is not allowed').status, ex('add a file, a name that is not allowed').body)
  assert(!again.ok && again.kind === 'exists' && !hidden.ok && hidden.kind === 'bad_name', 'a name that is taken, and a name that is not allowed, are said as such')
  assert(!readFileWritten(413, { error: 'too big' }).ok && (readFileWritten(413, null) as { kind?: string }).kind === 'too_large', 'a file over what the daemon takes is "too large" whatever the body says (it sends none)')
  const del = readFileDeleted(ex('delete a file').status, ex('delete a file').body)
  const del2 = readFileDeleted(ex('delete it again').status, ex('delete it again').body)
  assert(del.ok && !del2.ok && del2.kind === 'unknown_file', 'deleting a file that is already gone is said as that')
  const every = ['conflict', 'would_shadow', 'not_a_file', 'folder_missing', 'too_large', 'too_long', 'exists', 'too_many', 'bad_name', 'unknown_file', 'io_error', 'timeout'] as const
  assert(every.every((k) => chatProjectWords(k).length > 10 && !/\b(4\d\d|5\d\d|json|http|api|kind)\b/i.test(chatProjectWords(k))), 'every new refusal is one plain sentence: no status, no daemon word')
}

// ── how it is told ────────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  assert(formatBytes(0) === '0 bytes' && formatBytes(1) === '1 byte' && formatBytes(18) === '18 bytes' && formatBytes(1500) === '1.5 KB' && formatBytes(340_000) === '340 KB' && formatBytes(1_500_000) === '1.5 MB' && formatBytes(-1) === '' && formatBytes(NaN) === '', 'a size is told in the unit a person reads')
  const now = 1793667600000 + 3 * 86_400_000
  const line = describeFile({ name: 'a.md', size: 27, modified: 1793667600000, mime: 'text/markdown' }, now)
  assert(/^27 bytes · text\/markdown · /.test(line) && describeFile({ name: 'x', size: 5, modified: now, mime: null }, now) === '5 bytes · today' && describeFile({ name: 'x', size: 5, modified: 0, mime: 'application/octet-stream' }, now) === '5 bytes', 'a file line: size, kind (not the generic one), and when')
  const base = { path: 'a/PROMETHEUS.md', chars: 5, truncated: false, omitted: false, shadowedBy: null, symlink: false }
  assert(effectiveNote(base) === '' && /CLAUDE\.md is read instead/.test(effectiveNote({ ...base, shadowedBy: 'CLAUDE.md' })) && /too long/.test(effectiveNote({ ...base, omitted: true })) && /only the start/.test(effectiveNote({ ...base, truncated: true })) && /link/.test(effectiveNote({ ...base, symlink: true })), 'a file the loader does not read whole is said so, in words')
}

// ── what Beacon asks is what the daemon accepted ─────────────────────────────────────────────────────────────────────────────
{
  const same = (r: { method: string; path: string; body?: unknown }, label: string, replace = false): boolean => {
    const e = ex(label)
    // A file's body is its bytes, recorded as their size and hash: what the request carries in JSON is nothing.
    const jsonBody = e.request && typeof e.request === 'object' && 'sha256' in e.request ? null : (e.request ?? null)
    return e.method === r.method && e.path === withReplace(r.path, replace) && JSON.stringify(jsonBody) === JSON.stringify(r.body ?? null)
  }
  assert(same(CONTENT_ROUTES.instructions(P), 'instructions') && same(CONTENT_ROUTES.files(P), 'files'), 'the instructions and the list of files are asked on the paths the daemon serves')
  assert(same(CONTENT_ROUTES.saveInstructions(P, 'Be brief.', ''), 'save instructions') && same(CONTENT_ROUTES.saveInstructions('cp_000000000005', 'New.', '', true), 'save anyway'), 'a save sends the text and the revision it was made from, and shadow_ok only when the person said so')
  assert(CONTENT_ROUTES.saveInstructions(P, 'x', 'r').body.base_rev === 'r' && !('shadow_ok' in CONTENT_ROUTES.saveInstructions(P, 'x', 'r').body), 'shadow_ok is never sent unasked')
  assert(same(CONTENT_ROUTES.putFile(P, 'notes.md', false), 'add a file') && same(CONTENT_ROUTES.putFile(P, 'notes.md', true), 'add it again, replacing', true), 'a file goes up on its own path, with ?replace=true only when it is to overwrite')
  assert(same(CONTENT_ROUTES.putFile(P, 'résumé draft.txt', false), 'add a file, a name with a space and accents') && same(CONTENT_ROUTES.getFile(P, 'notes.md'), 'get a file') && same(CONTENT_ROUTES.deleteFile(P, 'notes.md'), 'delete a file'), 'a name with accents and a space is one encoded segment, as the daemon was asked')
  const tricky = CONTENT_ROUTES.getFile(P, '../a?b#c d.txt').path
  assert(!/\.\.\//.test(tricky) && !/[?# ]/.test(tricky.slice(tricky.indexOf('/files/'))), 'a name that would be a path, a query or a fragment is encoded into one segment')
}
{
  const ok: Array<[string, string]> = [
    ['GET', `/api/chat-projects/${P}/instructions`], ['PUT', `/api/chat-projects/${P}/instructions`], ['GET', `/api/chat-projects/${P}/files`],
    ['GET', `/api/chat-projects/${P}/files/notes.md`], ['PUT', `/api/chat-projects/${P}/files/r%C3%A9sum%C3%A9%20draft.txt`], ['DELETE', `/api/chat-projects/${P}/files/notes.md`],
    ['PUT', `/api/chat-projects/${P}/files/.hidden`], ['GET', `/api/chat-projects/${P}/files/a.b.c`], ['GET', `/api/chat-projects/${P}/files/100%25.txt`]
  ]
  assert(ok.every(([m, p]) => isProjectContentRoute(m, p)), 'each content route, with its own method, is allowed (a name with a dot at the start is the daemon\'s to refuse)')
  const no: Array<[string, string]> = [
    ['DELETE', `/api/chat-projects/${P}/instructions`], ['POST', `/api/chat-projects/${P}/files`], ['PUT', `/api/chat-projects/${P}/files`], ['DELETE', `/api/chat-projects/${P}/files`],
    ['GET', `/api/chat-projects/${P}/files/`], ['GET', `/api/chat-projects/${P}/files/a/b`], ['GET', `/api/chat-projects/${P}/files/..`], ['GET', `/api/chat-projects/${P}/files/.`],
    ['GET', `/api/chat-projects/${P}/files/%2e%2e`], ['GET', `/api/chat-projects/${P}/files/a%2fb`], ['GET', `/api/chat-projects/${P}/files/a%5cb`], ['GET', `/api/chat-projects/${P}/files/a\\b`],
    ['GET', `/api/chat-projects/${P}/files/a?replace=true`], ['GET', `/api/chat-projects/../files`], ['GET', `/api/chat-projects/${P}/files/a\tb`], ['GET', `/api/chat-projects/${P}/other`],
    ['GET', `/api/chat-projects/${P}/instructions/x`], ['GET', `/api/sessions`], ['PUT', `/api/config`]
  ]
  assert(no.every(([m, p]) => !isProjectContentRoute(m, p)), 'another method, a path that is not one segment, a dot segment (written or encoded), an encoded slash or backslash, a query, or any other path: none is')
  assert(!isProjectRoute('GET', `/api/chat-projects/${P}/files`) && !isProjectRoute('GET', `/api/chat-projects/${P}/instructions`), 'the hub routes stay as they were: the content routes are a list of their own')
}
{
  const okOp = (o: unknown): boolean => validContentOp(o) !== null
  assert(okOp({ op: 'instructions', id: P }) && okOp({ op: 'files', id: P }) && okOp({ op: 'save-instructions', id: P, content: 'x', baseRev: '' }) && okOp({ op: 'save-instructions', id: P, content: '', baseRev: 'r', shadowOk: true }) && okOp({ op: 'upload', id: P }) && okOp({ op: 'upload', id: P, replace: true }) && okOp({ op: 'upload', id: P, replace: true, name: 'notes.md' }) && okOp({ op: 'download', id: P, name: 'résumé draft.txt' }) && okOp({ op: 'delete-file', id: P, name: '100%.txt' }), 'every operation the window can ask, in its good shapes, is accepted')
  const bad: unknown[] = [{ op: 'upload', id: P, name: 'notes.md' }, { op: 'upload', id: P, replace: true, name: '..' }, { op: 'upload', id: P, replace: true, name: 'a/b' }, { op: 'upload', id: P, replace: true, name: 5 }, null, 'files', {}, { op: 'nope', id: P }, { op: 'files' }, { op: 'files', id: '..' }, { op: 'files', id: 'a/b' }, { op: 'files', id: 'a%2fb' }, { op: 'files', id: 'a b' }, { op: 'files', id: '' }, { op: 'files', id: 'é' },
    { op: 'save-instructions', id: P, content: 5, baseRev: '' }, { op: 'save-instructions', id: P, content: 'x' }, { op: 'save-instructions', id: P, content: 'x', baseRev: '', shadowOk: 'yes' }, { op: 'save-instructions', id: P, content: 'x'.repeat(1_000_001), baseRev: '' },
    { op: 'upload', id: P, replace: 'yes' },
    { op: 'download', id: P }, { op: 'download', id: P, name: '..' }, { op: 'download', id: P, name: 'a/b' }, { op: 'download', id: P, name: 'a\\b' }, { op: 'download', id: P, name: 'a\nb' }, { op: 'download', id: P, name: 'x'.repeat(121) }, { op: 'delete-file', id: P, name: '' }]
  assert(bad.every((o) => validContentOp(o) === null), 'a malformed op, an id or a name that is not one plain segment, a text that is too long to be sent, a flag that is not true or false: refused, never forwarded')
  const v = validContentOp({ op: 'upload', id: P, replace: true, path: '/etc/passwd', files: ['/etc/hosts'] }) as Record<string, unknown> | null
  assert(v !== null && !('path' in v) && !('files' in v) && v.replace === true, 'an upload carries no path from the page: only the fields an op has are kept, and the panel is main\'s')
}

// ── the class that asks ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// A Prometheus that answers from the recording. A request is matched by method, path (with its query) and body (a file by its sha256);
// one the recording has no answer for throws, as it would be one the daemon never accepted.
interface Probe { run: ChatProjectContent; asked: string[]; sent: Buffer[]; state: { available: boolean; current: boolean; prefer: string | null; replaceDuringBytes: boolean } }
function probe(): Probe {
  const asked: string[] = []
  const sent: Buffer[] = []
  const state = { available: true, current: true, prefer: null as string | null, replaceDuringBytes: false }
  // The daemon is not stateless (a second read after a save, a second delete): the recorded answers to one request are given in the order
  // they were recorded, the last one again after that, unless the check says which it wants.
  const used = new Set<Exchange>()
  const pick = (matches: Exchange[]): Exchange | undefined => {
    const wanted = state.prefer ? matches.find((m) => m.label === state.prefer) : undefined
    state.prefer = null
    const e = wanted ?? matches.find((m) => !used.has(m)) ?? matches[matches.length - 1]
    if (e) used.add(e)
    return e
  }
  const request: ProjectsRequest = async (method, path, body) => {
    asked.push(`${method} ${path}`)
    const e = pick(content.exchanges.filter((x) => x.method === method && x.path === path && JSON.stringify(x.request ?? null) === JSON.stringify(body ?? null) && x.as === 'op'))
    if (!e) throw new Error(`no recorded answer for ${method} ${path} ${JSON.stringify(body)}`)
    return { status: e.status, body: e.body }
  }
  const bytes: ProjectsBytes = async (method, path, opts) => {
    asked.push(`${method} ${withReplace(path, opts.replace === true)}`)
    if (opts.body) sent.push(opts.body)
    if (state.replaceDuringBytes) state.current = false // the person switched Prometheus while this was out
    const full = withReplace(path, opts.replace === true)
    const e = pick(content.exchanges.filter(
      (x) => x.method === method && x.path === full && x.as === 'op' && (opts.body ? JSON.stringify(x.request) === JSON.stringify({ bytes: opts.body.byteLength, sha256: sha(opts.body) }) : x.request === null)
    ))
    if (!e) throw new Error(`no recorded answer for ${method} ${full}`)
    if (e.bytes_b64 !== undefined) return { status: e.status, body: null, bytes: Buffer.from(e.bytes_b64, 'base64'), contentType: e.headers?.['content-type'] ?? null }
    return { status: e.status, body: e.body, bytes: null, contentType: null }
  }
  return { run: new ChatProjectContent({ request, bytes, available: () => state.available, isCurrent: () => state.current }), asked, sent, state }
}
const noPanels: ContentPanels = { pickFiles: async () => { throw new Error('a panel was opened') }, pickSaveAs: async () => { throw new Error('a panel was opened') } }
/** What the panel was asked for (several files, or one), for the checks that care. */
const panelAsked: boolean[] = []
const dir = mkdtempSync(join(tmpdir(), 'beacon-content-smoke-'))
const fileAt = (name: string, data: Buffer | string): string => {
  const d = mkdtempSync(join(dir, 'f-'))
  const p = join(d, name)
  writeFileSync(p, data)
  return p
}
const failedOf = (r: ContentResult): { kind?: string } => r as { kind?: string }

async function classChecks(): Promise<void> {
  // Not served: nothing asked, no panel opened.
  {
    const p = probe()
    p.state.available = false
    const results = [
      await p.run.run({ op: 'instructions', id: P }, noPanels),
      await p.run.run({ op: 'save-instructions', id: P, content: 'x', baseRev: '' }, noPanels),
      await p.run.run({ op: 'files', id: P }, noPanels),
      await p.run.run({ op: 'upload', id: P }, noPanels),
      await p.run.run({ op: 'download', id: P, name: 'notes.md' }, noPanels),
      await p.run.run({ op: 'delete-file', id: P, name: 'notes.md' }, noPanels)
    ]
    assert(results.every((r) => !r.ok && r.kind === 'unsupported') && p.asked.length === 0, 'a Prometheus that does not serve projects is asked nothing by any of the six operations, and no panel is opened for it')
  }
  // Instructions.
  {
    const p = probe()
    p.state.prefer = 'instructions'
    const r = await p.run.run({ op: 'instructions', id: P }, noPanels)
    assert(r.ok && r.instructions?.content === 'Be brief.' && r.instructions.rev === '213c22ed7234eb11', 'the instructions are read from the Prometheus')
    const none = await p.run.run({ op: 'save-instructions', id: P, content: 'Be brief.', baseRev: '' }, noPanels)
    assert(none.ok && none.rev === '213c22ed7234eb11', 'a save answers the new revision')
    const stale = await p.run.run({ op: 'save-instructions', id: P, content: 'Mine.', baseRev: '' }, noPanels)
    assert(!stale.ok && stale.kind === 'conflict' && stale.current?.content === 'Be brief.', 'a save from a stale revision is a conflict with the text on the Prometheus; nothing is overwritten')
    const sh = await p.run.run({ op: 'save-instructions', id: 'cp_000000000005', content: 'New.', baseRev: '' }, noPanels)
    const anyway = await p.run.run({ op: 'save-instructions', id: 'cp_000000000005', content: 'New.', baseRev: '', shadowOk: true }, noPanels)
    assert(!sh.ok && sh.kind === 'would_shadow' && anyway.ok, 'a save that would shadow another file is refused until the person says to go on')
  }
  // Upload.
  {
    const p = probe()
    const notes = fileAt('notes.md', '# Notes\nBuy milk.\n')
    const other = fileAt('notes.md', '# Other\n')
    const cancelled = await p.run.run({ op: 'upload', id: P }, { ...noPanels, pickFiles: async () => null })
    assert(cancelled.ok && cancelled.cancelled === true && p.asked.length === 0, 'closing the panel sends nothing')
    const one = await p.run.run({ op: 'upload', id: P }, { ...noPanels, pickFiles: async () => [notes] })
    assert(one.ok && one.uploaded?.length === 1 && one.uploaded[0].name === 'notes.md' && one.uploaded[0].size === 18 && p.sent[0].toString() === '# Notes\nBuy milk.\n' && p.asked[0] === `PUT /api/chat-projects/${P}/files/notes.md`, 'a chosen file goes up as raw bytes on its own name, without ?replace')
    const twice = await p.run.run({ op: 'upload', id: P }, { ...noPanels, pickFiles: async () => [other] })
    assert(twice.ok && JSON.stringify(twice.existing) === '["notes.md"]' && twice.uploaded?.length === 0 && (twice.failed ?? []).length === 0, 'a name that is taken is reported as taken, not as a failure and not replaced')
    const replaced = await p.run.run({ op: 'upload', id: P, replace: true }, { ...noPanels, pickFiles: async () => [fileAt('notes.md', '# Notes\nBuy milk and eggs.\n')] })
    assert(replaced.ok && replaced.uploaded?.length === 1 && p.asked[p.asked.length - 1].endsWith('/files/notes.md?replace=true'), 'replacing is asked for with ?replace=true, and only when the person said to')
    const many = await p.run.run({ op: 'upload', id: P }, { ...noPanels, pickFiles: async () => [fileAt('.hidden', 'x'), fileAt('résumé draft.txt', 'Café\n'), fileAt('page.html', '<script>alert(1)</script>')] })
    assert(many.ok && many.uploaded?.map((f) => f.name).join() === 'résumé draft.txt,page.html' && many.failed?.length === 1 && many.failed[0].name === '.hidden' && many.failed[0].message === chatProjectWords('bad_name'), 'several at once: one the daemon refuses is said, and the others still go up')
  }
  // What is never read.
  {
    const p = probe()
    const big = fileAt('big.bin', '')
    truncateSync(big, MAX_FILE_BYTES + 1)
    const folder = join(dir, 'a-folder')
    mkdirSync(folder)
    const target = fileAt('real.txt', '# Notes\nBuy milk.\n')
    const linkDir = mkdtempSync(join(dir, 'l-'))
    const link = join(linkDir, 'notes.md')
    symlinkSync(target, link)
    const r = await p.run.run({ op: 'upload', id: P }, { ...noPanels, pickFiles: async () => [big, folder, join(dir, 'missing.txt'), link] })
    assert(r.ok && r.failed?.length === 3 && r.failed[0].message === chatProjectWords('too_large') && r.failed[1].message === 'That is not a plain file.' && r.failed[2].message === "Beacon couldn't read that file.", 'a file over the limit, a folder and a file that is not there are refused before anything is read or sent', r)
    assert(r.ok && r.uploaded?.length === 1 && p.sent.length === 1 && p.asked.length === 1 && p.asked[0].endsWith('/files/notes.md'), 'a link to a plain file is a file (the person chose it), sent under the link\'s own name; nothing else was asked of the Prometheus')
  }
  // An upload that ends early.
  {
    const asked: string[] = []
    const run = new ChatProjectContent({
      request: async () => ({ status: 200, body: null }),
      bytes: async (_m, path) => {
        asked.push(path)
        return asked.length === 1 ? { status: 409, body: { kind: 'too_many', error: 'x' }, bytes: null, contentType: null } : { status: 200, body: { ok: true, file: { name: 'z', size: 1, mtime: 1 } }, bytes: null, contentType: null }
      },
      available: () => true,
      isCurrent: () => true
    })
    const r = await run.run({ op: 'upload', id: P }, { ...noPanels, pickFiles: async () => [fileAt('a.txt', '1'), fileAt('b.txt', '2'), fileAt('c.txt', '3')] })
    assert(r.ok && asked.length === 1 && r.failed?.length === 3 && r.failed[0].message === chatProjectWords('too_many') && /^Not sent\./.test(r.failed[1].message), 'when the project can take no more, the rest are not sent, and each is said not to have been')
    const down = new ChatProjectContent({
      request: async () => ({ status: 200, body: null }),
      bytes: async () => { throw new Error('blocked daemon path') },
      available: () => true,
      isCurrent: () => true
    })
    const a = await down.run({ op: 'upload', id: P }, { ...noPanels, pickFiles: async () => [fileAt('a\\b.txt', 'x')] })
    assert(a.ok && a.failed?.length === 1 && a.failed[0].message === chatProjectWords('bad_name'), 'a name the transport will not put in a path is a refusal in words, never a thrown error')
  }
  // Download.
  {
    const p = probe()
    const out = join(dir, 'saved-notes.md')
    const r = await p.run.run({ op: 'download', id: P, name: 'notes.md' }, { ...noPanels, pickSaveAs: async (n) => (n === 'notes.md' ? out : null) })
    assert(r.ok && r.saved === true && readFileSync(out, 'utf8') === '# Notes\nBuy milk and eggs.\n', 'a file is saved where the person chose, byte for byte, under the name it has')
    const html = join(dir, 'saved-page.html')
    await p.run.run({ op: 'download', id: P, name: 'page.html' }, { ...noPanels, pickSaveAs: async () => html })
    assert(readFileSync(html, 'utf8') === '<script>alert(1)</script>', 'a web page is saved as bytes, never opened or run')
    const before = p.asked.length
    const c = await p.run.run({ op: 'download', id: P, name: 'notes.md' }, { ...noPanels, pickSaveAs: async () => null })
    assert(c.ok && c.cancelled === true && p.asked.length === before, 'closing the save panel asks nothing')
    const missing = await p.run.run({ op: 'download', id: P, name: 'nope.txt' }, { ...noPanels, pickSaveAs: async () => join(dir, 'never.txt') })
    assert(!missing.ok && failedOf(missing).kind === 'unknown_file', 'a file that is gone is said so, and nothing is written')
    const blocked = await p.run.run({ op: 'download', id: P, name: 'notes.md' }, { ...noPanels, pickSaveAs: async () => join(dir, 'no-such-folder', 'x.md') })
    assert(!blocked.ok && failedOf(blocked).kind === 'io_error', 'a place that cannot be written is said so')
  }
  // Delete.
  {
    const p = probe()
    const d = await p.run.run({ op: 'delete-file', id: P, name: 'notes.md' }, noPanels)
    const again = await p.run.run({ op: 'delete-file', id: P, name: 'notes.md' }, noPanels)
    assert(d.ok && !again.ok && failedOf(again).kind === 'unknown_file', 'deleting a reference file deletes that file; again, it is already gone')
  }
  // Replace on a row: one file, under that row's name.
  {
    const p = probe()
    const other = fileAt('whatever-it-is-called-here.md', '# Notes\nBuy milk and eggs.\n')
    const spare = fileAt('spare.md', '# Never sent\n')
    panelAsked.length = 0
    const r = await p.run.run({ op: 'upload', id: P, replace: true, name: 'notes.md' }, { ...noPanels, pickFiles: async (multiple) => (panelAsked.push(multiple), [other, spare]) })
    assert(r.ok && r.uploaded?.length === 1 && r.uploaded[0].name === 'notes.md' && p.asked.length === 1 && p.asked[0].endsWith('/files/notes.md?replace=true') && panelAsked.join() === 'false', 'Replace on a row puts the ONE file chosen in that file\'s place, under its name, asking the panel for one file; a second is never sent')
  }
  // A download that stops short is not a file.
  {
    const p = probe()
    const out = join(dir, 'kept.md')
    writeFileSync(out, 'what was there')
    const run = new ChatProjectContent({
      request: async () => ({ status: 200, body: null }),
      bytes: async () => ({ status: 0, body: null, bytes: null, contentType: null }),
      available: () => true,
      isCurrent: () => true
    })
    const r = await run.run({ op: 'download', id: P, name: 'notes.md' }, { ...noPanels, pickSaveAs: async () => out })
    assert(!r.ok && failedOf(r).kind === 'unreachable' && readFileSync(out, 'utf8') === 'what was there' && !existsSync(`${out}.beacon-part`), 'a download that did not arrive whole leaves the file the person chose to overwrite exactly as it was')
    const empty = new ChatProjectContent({ request: async () => ({ status: 200, body: null }), bytes: async () => ({ status: 200, body: null, bytes: Buffer.alloc(0), contentType: null }), available: () => true, isCurrent: () => true })
    const e = join(dir, 'empty.txt')
    const er = await empty.run({ op: 'download', id: P, name: 'empty.txt' }, { ...noPanels, pickSaveAs: async () => e })
    assert(er.ok && readFileSync(e).byteLength === 0 && !existsSync(`${e}.beacon-part`), 'a file that really is empty is saved as an empty file, and no scratch file is left')
    void p
  }

  // A connection replaced while a call is out.
  {
    const p = probe()
    p.state.current = false
    const i = await p.run.run({ op: 'instructions', id: P }, noPanels)
    const out = join(dir, 'late.md')
    const d = await p.run.run({ op: 'download', id: P, name: 'notes.md' }, { ...noPanels, pickSaveAs: async () => out })
    let wrote = true
    try {
      readFileSync(out)
    } catch {
      wrote = false
    }
    const u = await p.run.run({ op: 'upload', id: P }, { ...noPanels, pickFiles: async () => [fileAt('notes.md', '# Notes\nBuy milk.\n')] })
    assert(!i.ok && failedOf(i).kind === 'unreachable' && !d.ok && !wrote && !u.ok && p.sent.length === 0, 'a connection that was replaced shows nothing, writes no file, and sends no upload')
  }
  // A connection replaced WHILE the bytes are out.
  {
    const p = probe()
    p.state.replaceDuringBytes = true
    const out = join(dir, 'late-2.md')
    const d = await p.run.run({ op: 'download', id: P, name: 'notes.md' }, { ...noPanels, pickSaveAs: async () => out })
    let wrote = true
    try {
      readFileSync(out)
    } catch {
      wrote = false
    }
    const q = probe()
    q.state.replaceDuringBytes = true
    const u = await q.run.run({ op: 'upload', id: P }, { ...noPanels, pickFiles: async () => [fileAt('notes.md', '# Notes\nBuy milk.\n'), fileAt('page.html', '<script>alert(1)</script>')] })
    assert(!d.ok && !wrote && !u.ok && q.sent.length === 1, 'a connection replaced while a file is coming down writes nothing; while one is going up, the rest are not sent and no answer is shown')
  }
  // A transport that fails.
  {
    const run = new ChatProjectContent({ request: async () => { throw new Error('boom') }, bytes: async () => { throw new Error('boom') }, available: () => true, isCurrent: () => true })
    const r = await run.run({ op: 'files', id: P }, noPanels)
    assert(!r.ok && failedOf(r).kind === 'unreachable', 'a call that cannot be made is "could not reach", never a thrown error')
  }
}

// ── the transport, against a server that misbehaves ───────────────────────────────────────────────────────────────────────────
async function transportChecks(): Promise<void> {
  const server = createServer((req, res) => {
    const url = req.url ?? ''
    if (url.endsWith('/files/short.bin')) {
      res.writeHead(200, { 'content-length': '1000', 'content-type': 'application/octet-stream' })
      res.write(Buffer.alloc(100, 1))
      setTimeout(() => res.socket?.destroy(), 20)
    } else if (url.endsWith('/files/chunked.bin')) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' }) // no length: chunked
      const t = setInterval(() => res.write(Buffer.alloc(1000, 2)), 2)
      res.on('close', () => clearInterval(t))
      setTimeout(() => res.end(), 400)
    } else if (url.endsWith('/files/declared.bin')) {
      res.writeHead(200, { 'content-length': '5000', 'content-type': 'application/octet-stream' })
      res.end(Buffer.alloc(5000, 3))
    } else if (url.endsWith('/files/exact.bin')) {
      res.writeHead(200, { 'content-length': '1000', 'content-type': 'application/octet-stream' })
      res.end(Buffer.alloc(1000, 4))
    } else if (url.endsWith('/files/gone.bin')) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"no such reference file","kind":"unknown_file"}')
    } else {
      res.writeHead(500).end()
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const rest = new RestClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'k')
  const get = (name: string, maxBytes = 1000): ReturnType<RestClient['projectsBytes']> => rest.projectsBytes('GET', `/api/chat-projects/${P}/files/${name}`, { maxBytes })
  const short = await get('short.bin')
  assert(short.status === 0 && short.bytes === null, 'a body that stops short of what it said is no answer, never a shorter file said to be whole')
  const chunked = await get('chunked.bin')
  assert(chunked.status === 413 && chunked.bytes === null, 'a body with no length that goes past the limit is refused as too large, and the rest is not read')
  const declared = await get('declared.bin')
  assert(declared.status === 413 && declared.bytes === null, 'a body that says it is over the limit is refused as too large before it is read')
  const exact = await get('exact.bin')
  assert(exact.status === 200 && exact.bytes?.byteLength === 1000 && exact.bytes.every((b) => b === 4), 'a file exactly at the limit is read whole')
  const gone = await get('gone.bin')
  assert(gone.status === 404 && (gone.body as { kind?: string }).kind === 'unknown_file' && gone.bytes === null, 'a refusal is read as the JSON it is')
  server.close()
  server.closeAllConnections()
}

// ── main wires it the way this file says ────────────────────────────────────────────────────────────────────────────────────────
{
  const src = (rel: string): string => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8')
  const main = src('src/main/index.ts')
  assert(/chatContent = new ChatProjectContent\(\{\s*request: \(method, path, body\) => conn\.projectsCall\(method, path, body\),\s*bytes: \(method, path, opts\) => conn\.projectsBytes\(method, path, opts\),\s*available: \(\) => projects\.state\(\)\.available,\s*isCurrent: \(\) => chatProjects === projects/.test(main) && (main.match(/new ChatProjectContent/g) ?? []).length === 1, 'one is made for each connection, asks through THAT connection, and is gated on the hub saying the Prometheus serves projects')
  const ipc = src('src/main/chat-projects-ipc.ts')
  assert(/const op = validContentOp\(raw\)\s*if \(!op\) return refusal\(400, null\)\s*const content = currentContent\(\)/.test(ipc) && !/ipcMain/.test(ipc), 'an op is validated in main before it reaches the class')
  const cls = src('src/main/chat-projects-content.ts')
  assert(!/dialog|BrowserWindow/.test(cls) && /pickFiles\(/.test(cls), 'the class opens no panel of its own: the window that asked supplies them')
}

void classChecks()
  .then(transportChecks)
  .catch((e) => assert(false, 'the class checks ran to the end', String(e)))
  .finally(() => rmSync(dir, { recursive: true, force: true }))
