/**
 * Daemon-folders smoke (docs/MULTI-PROMETHEUS.md §2–§3): the move from one beacon.db to app.db + a folder per Prometheus, which
 * folder a Prometheus's things go in, the hold on a cache whose Prometheus hasn't said who it is, and that every settings key
 * in src/ is classified. Headless (ELECTRON_RUN_AS_NODE), over temp folders; no daemon.
 *
 *   npm run build && npm run smoke:daemon-folders
 *
 *   1. migration: a userData shaped like 0.4.9's (beacon.db with conversations, an outbox, settings of both kinds, a pinned
 *      connection) moves with a backup first, its MANIFEST matching the copy; a second launch changes nothing;
 *   2. a crash injected after each step (and seen to be injected) is finished by the next launch, nothing lost;
 *   3. a fresh install starts in the new layout, with no backup;
 *   4. folders: a pinned connection's legacy folder is bound to its fp at once; an unpinned one is bound by hello; another fp at
 *      the same address gets its own folder; the same fp at a new address keeps its folder;
 *   5. hold: a held cache writes nothing its connection says and sends nothing queued; release catches up;
 *   6. every settings key in src/ is classified Beacon-wide or per-Prometheus.
 */
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import type { ChatSendRequest, ChatSendResult, ConnectionStatus, SessionSummary } from '@shared/ipc'
import { classifiedScope, fpFromPin } from '@shared/daemon-profiles'
import { DRAFT_PREFIX } from '@shared/drafts'
import { THEME_KEY } from '@shared/theme'
import { SESSION_GROUPS_SETTING_KEY } from '@shared/session-groups'
import type { ConnectionManager } from './connection'
import { openCache } from './cache/db'
import { CacheRepo } from './cache/repo'
import { CacheService } from './cache/service'
import { DaemonFolders, InjectedCrash, LAYOUT_KEY, LEGACY_FOLDER_ID, type MigrationStep } from './cache/daemon-folders'

let failures = 0
function assert(cond: boolean, label: string): void {
  console.log(`[smoke] ${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}

const PIN = 'ab'.repeat(32)
const API = 'http://127.0.0.1:18201'
const SESSION = 'desktop:old-1'
const roots: string[] = []

function tempRoot(): string {
  const r = mkdtempSync(join(tmpdir(), 'beacon-daemon-folders-'))
  roots.push(r)
  return r
}

/** A userData as 0.4.9 left it: one beacon.db with a conversation, a queued message, settings of both kinds, a saved connection. */
function legacyUserData(pin: string | null): string {
  const root = tempRoot()
  const db = openCache(join(root, 'beacon.db'))
  const repo = new CacheRepo(db)
  repo.ensureSession(SESSION, 'desktop', 'An old conversation')
  repo.reconcileSession(SESSION, [{ rowId: 7, ordinal: 0, role: 'user', content: 'hello from before' }], 7)
  const cmid = 'cmid-1'
  const opt = repo.addOptimisticMessage(SESSION, 'user', 'queued before the move', cmid)
  repo.attachOutbox(SESSION, 'queued before the move', 'idem-1', cmid, opt)
  repo.setSetting(THEME_KEY, 'dusk')
  repo.setSetting(`${DRAFT_PREFIX}${SESSION}`, 'a draft from before')
  repo.setSetting(SESSION_GROUPS_SETTING_KEY, '[{"id":"g1"}]')
  repo.upsertGatewayProfile('mini', API, 'ws://127.0.0.1:18202', true, pin)
  db.close()
  return root
}

const sha = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex')
const tables = (path: string): string[] => {
  const db = new Database(path, { readonly: true })
  try {
    return (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map((r) => r.name)
  } finally {
    db.close()
  }
}

/** The layout after a finished move: what the checks in 1 and 2 share. */
function checkMoved(root: string, label: string): void {
  const folders = new DaemonFolders(root)
  try {
    assert(!existsSync(join(root, 'beacon.db')), `${label}: beacon.db is gone from where it was`)
    assert(existsSync(join(root, 'daemons', LEGACY_FOLDER_ID, 'cache.db')), `${label}: it is daemons/${LEGACY_FOLDER_ID}/cache.db now`)
    assert(folders.app.getSetting(LAYOUT_KEY) === '1', `${label}: app.db says the layout is in place`)
    assert(folders.getSetting(THEME_KEY) === 'dusk', `${label}: the theme moved into app.db`)
    assert(folders.getDefaultGatewayProfile()?.apiBase === API, `${label}: the saved connection moved into app.db`)
    assert(!tables(join(root, 'app.db')).includes('sessions') && !tables(join(root, 'app.db')).includes('outbox'), `${label}: app.db holds no conversation or outbox table`)
    const folder = folders.open({ apiBase: API, fp: fpFromPin(PIN) })
    assert(folder.id === LEGACY_FOLDER_ID, `${label}: the pinned Prometheus opens the legacy folder (got ${folder.id})`)
    assert(folder.repo.getSessions().some((s) => s.id === SESSION), `${label}: its conversation is there`)
    assert(folder.repo.outboxStatus().pending === 1, `${label}: its queued message is still queued (${folder.repo.outboxStatus().pending})`)
    assert(folders.getSetting(`${DRAFT_PREFIX}${SESSION}`) === 'a draft from before', `${label}: its draft is there`)
    assert(folders.getSetting(SESSION_GROUPS_SETTING_KEY) === '[{"id":"g1"}]', `${label}: its groups are there`)
  } finally {
    folders.close()
  }
}

class FakeConnection extends EventEmitter {
  readonly sent: ChatSendRequest[] = []
  constructor(private readonly sessions: string[]) {
    super()
  }
  getStatus(): ConnectionStatus {
    return { state: 'connected', gateway: 'fake' }
  }
  async listSessions(): Promise<SessionSummary[]> {
    return this.sessions.map((id) => ({ id, title: id, lastActive: Date.now(), messageCount: 1, watermark: 1 }))
  }
  async send(req: ChatSendRequest): Promise<ChatSendResult> {
    this.sent.push(req)
    return { runId: req.clientMsgId ?? '', status: 'accepted' }
  }
  async fetchHistory(): Promise<{ messages: []; watermark: number }> {
    return { messages: [], watermark: 0 }
  }
  async deleteSession(): Promise<void> {}
}

/** Every `*_KEY` / `*_PREFIX` string constant and every templated settings key in src/ (smokes aside). */
function settingsKeysInSource(): Array<{ where: string; name: string; value: string }> {
  const NOT_SETTINGS = new Set(['RELEASE_PATH_PREFIX', 'SESSION_WINDOW_ROUTE_PREFIX', 'AUTOMATED_KEY', 'HARNESS_KEY'])
  const files = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(join(d, e.name)) : /\.(ts|tsx)$/.test(e.name) && !/-smoke\.ts$/.test(e.name) ? [join(d, e.name)] : []
    )
  const out: Array<{ where: string; name: string; value: string }> = []
  for (const f of files('src')) {
    const text = readFileSync(f, 'utf8')
    for (const m of text.matchAll(/const ([A-Z0-9_]+(?:_KEY|_PREFIX))\s*(?::[^=]+)?=\s*['"]([^'"]+)['"]/g))
      if (!NOT_SETTINGS.has(m[1])) out.push({ where: f, name: m[1], value: m[2] })
    for (const m of text.matchAll(/(?:getSetting|setSetting|settings\.get|settings\.set)\(`([^$`]+)\$\{/g))
      out.push({ where: f, name: 'template', value: `${m[1]}x` })
  }
  return out
}

async function main(): Promise<void> {
  console.log('\n[smoke] === 1. migration ===')
  {
    const root = legacyUserData(PIN)
    const before = sha(join(root, 'beacon.db'))
    new DaemonFolders(root).close()
    const manifest = join(root, 'backup-pre-daemons', 'MANIFEST')
    const copy = join(root, 'backup-pre-daemons', 'beacon.db')
    assert(existsSync(manifest) && existsSync(copy), 'the backup was taken')
    const [name, size, digest] = existsSync(manifest) ? readFileSync(manifest, 'utf8').trim().split(' ') : []
    assert(name === 'beacon.db' && Number(size) === statSync(copy).size && digest === sha(copy), 'its MANIFEST matches the copy (name, size, SHA-256)')
    assert(digest === before, 'the copy is beacon.db as it was before the move')
    checkMoved(root, 'moved')
    const manifestAt = statSync(manifest).mtimeMs
    const cacheSha = sha(join(root, 'daemons', LEGACY_FOLDER_ID, 'cache.db'))
    new DaemonFolders(root).close()
    assert(statSync(manifest).mtimeMs === manifestAt && readFileSync(manifest, 'utf8').includes(before), 'a second launch leaves the backup alone')
    assert(readdirSync(join(root, 'daemons')).join() === LEGACY_FOLDER_ID, 'a second launch makes no new folder')
    assert(sha(join(root, 'daemons', LEGACY_FOLDER_ID, 'cache.db')) === cacheSha, "a second launch doesn't touch the moved cache")
  }

  console.log('\n[smoke] === 1b. a partial beacon.db with no saved connection ===')
  {
    // Only a conversation, as a profile run on an environment-given gateway (or a probe's seed) can leave it: no settings table,
    // no saved connection.
    const root = tempRoot()
    const db = new Database(join(root, 'beacon.db'))
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, gateway TEXT, title TEXT, last_active INTEGER, message_count INTEGER DEFAULT 0, watermark INTEGER DEFAULT 0)`)
    db.prepare(`INSERT INTO sessions (id, gateway, title, last_active) VALUES (?, 'desktop', 'seeded', ?)`).run(SESSION, Date.now())
    db.close()
    const folders = new DaemonFolders(root)
    assert(folders.app.getSetting(LAYOUT_KEY) === '1' && existsSync(join(root, 'daemons', LEGACY_FOLDER_ID, 'cache.db')), 'it moves all the same')
    const first = folders.open({ apiBase: 'http://127.0.0.1:18400', fp: null })
    assert(first.id === LEGACY_FOLDER_ID && first.repo.getSessions().some((s) => s.id === SESSION), `the first connection, at any address, claims it (${first.id})`)
    assert(folders.open({ apiBase: 'http://127.0.0.1:18401', fp: null }).id !== LEGACY_FOLDER_ID, 'once claimed, another address does not')
    folders.close()
  }

  console.log('\n[smoke] === 2. a crash after each step is finished by the next launch ===')
  for (const step of ['backup', 'app', 'move'] as MigrationStep[]) {
    const root = legacyUserData(PIN)
    let injected = false
    try {
      new DaemonFolders(root, { crashAfter: step })
    } catch (err) {
      injected = err instanceof InjectedCrash
    }
    assert(injected, `the crash after "${step}" was injected`)
    checkMoved(root, `after a crash at "${step}"`)
  }

  console.log('\n[smoke] === 3. a fresh install ===')
  {
    const root = tempRoot()
    const folders = new DaemonFolders(root)
    assert(folders.app.getSetting(LAYOUT_KEY) === '1', 'starts in the new layout')
    assert(!existsSync(join(root, 'backup-pre-daemons')) && !existsSync(join(root, 'beacon.db')), 'with no backup and no beacon.db')
    assert(folders.getSetting(`${DRAFT_PREFIX}x`) === null, "with no Prometheus open, a Prometheus's setting reads as absent")
    folders.setSetting(`${DRAFT_PREFIX}x`, 'nowhere to go')
    assert(folders.getSetting(`${DRAFT_PREFIX}x`) === null && folders.app.getSetting(`${DRAFT_PREFIX}x`) === null, "and writing one puts it nowhere, app.db included")
    folders.close()
  }

  console.log('\n[smoke] === 4. which folder ===')
  {
    const root = legacyUserData(null)
    const folders = new DaemonFolders(root)
    const X = '1'.repeat(16)
    const Y = '2'.repeat(16)
    const first = folders.open({ apiBase: API, fp: null })
    assert(first.id === LEGACY_FOLDER_ID, `an unpinned connection, before hello, opens the folder at its address (${first.id})`)
    assert(folders.bind(LEGACY_FOLDER_ID, X) === LEGACY_FOLDER_ID, 'hello binds the legacy folder to the fp that answered')
    assert(folders.bind(LEGACY_FOLDER_ID, X) === LEGACY_FOLDER_ID, 'the same fp again: the same folder')
    const other = folders.bind(LEGACY_FOLDER_ID, Y)
    assert(other !== LEGACY_FOLDER_ID, `another fp at the same address gets its own folder (${other})`)
    const y = folders.open({ apiBase: API, fp: Y })
    assert(y.id === other && !y.repo.getSessions().some((s) => s.id === SESSION), "it opens empty: none of the legacy folder's conversations")
    const moved = folders.open({ apiBase: 'http://127.0.0.1:18299', fp: X })
    assert(moved.id === LEGACY_FOLDER_ID && moved.repo.getSessions().some((s) => s.id === SESSION), 'the same fp at a new address keeps its folder')
    const fresh = folders.open({ apiBase: 'http://127.0.0.1:18300', fp: null })
    assert(fresh.id.startsWith('new-'), `a new address, before hello: a new folder (${fresh.id})`)
    const Z = '3'.repeat(16)
    assert(folders.bind(fresh.id, Z) === fresh.id, 'which hello then binds')
    assert(folders.bind(fresh.id, X) === LEGACY_FOLDER_ID, "a bound fp's folder wins over the new one")
    folders.close()
  }
  {
    const root = legacyUserData(PIN)
    const folders = new DaemonFolders(root)
    assert(folders.open({ apiBase: 'http://127.0.0.1:18301', fp: fpFromPin(PIN) }).id === LEGACY_FOLDER_ID, "a pinned connection's legacy folder is bound to its fp from the start")
    folders.close()
  }

  console.log('\n[smoke] === 5. hold ===')
  {
    const root = legacyUserData(null)
    const folders = new DaemonFolders(root)
    const folder = folders.open({ apiBase: API, fp: null })
    const conn = new FakeConnection(['desktop:someone-else'])
    const cache = new CacheService(folder.repo, conn as unknown as ConnectionManager, { held: true })
    assert((await cache.drainOutbox()).length === 0 && conn.sent.length === 0, 'held: the queued message is not sent')
    const listed = await cache.listSessions()
    assert(!listed.some((s) => s.id === 'desktop:someone-else'), "held: the connection's sessions are not written into the folder")
    const r = await cache.send({ sessionId: SESSION, message: 'typed while held' })
    assert(r.status === 'queued' && conn.sent.length === 0, `held: a new message is queued, not sent (${r.status})`)
    let refused = false
    await cache.reconcile(SESSION).catch(() => (refused = true))
    assert(refused, 'held: history is not fetched into the folder')
    cache.release()
    await new Promise((res) => setTimeout(res, 50))
    assert(conn.sent.length === 2, `released: both queued messages go out (${conn.sent.length})`)
    folders.close()
  }

  console.log('\n[smoke] === 6. every settings key in src/ is classified ===')
  {
    const keys = settingsKeysInSource()
    assert(keys.length >= 34, `the scan found the settings keys (${keys.length}; fewer than 34 means it stopped reading them)`)
    const missing = keys.filter((k) => classifiedScope(k.value) === null)
    assert(missing.length === 0, `none unclassified${missing.length ? `: ${missing.map((k) => `${k.name}='${k.value}' (${k.where})`).join(', ')}` : ''}`)
    assert(classifiedScope('made-up:key') === null, 'a key nobody classified reads as unclassified (the check can fail)')
  }

  for (const r of roots) rmSync(r, { recursive: true, force: true })
  console.log(`\n[smoke] ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

void main().catch((err) => {
  console.error('[smoke] crashed:', err)
  process.exit(1)
})
