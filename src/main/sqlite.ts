import Database from 'better-sqlite3'

/**
 * Step-1 proof ONLY: confirm the `better-sqlite3` native module loads and runs under
 * Electron's ABI. The real cache schema (sessions / messages / outbox / gateway_profiles
 * / settings — spec §3.3) is Step 3; nothing here persists.
 */
export function proveSqlite(): string {
  const db = new Database(':memory:')
  try {
    const { v } = db.prepare('select sqlite_version() as v').get() as { v: string }
    const line = `better-sqlite3 loaded OK under Electron (Node ABI ${process.versions.modules}) — sqlite ${v}`
    console.log(`[sqlite] ${line}`)
    return line
  } finally {
    db.close()
  }
}
