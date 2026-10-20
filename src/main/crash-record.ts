// The durable renderer-crash record. Electron-free on purpose: only node:fs and node:path, so a
// headless smoke can load the REAL functions rather than a copy of them.
//
// WHY A FILE AND NOT A CACHE TABLE. The cache is disposable and rebuilt from the daemon, so a crash
// record stored there is lost exactly when it is most worth keeping — after a bad enough crash that
// someone clears the cache to rule it out. Neither existing table fits either: socket_events
// describes the connection, watchdog_events describes reply stalls, and ui_events is dev-gated and
// dropped from packaged builds entirely (so the one build where a crash record matters most is the
// one with no ui_events). Same shape as window-state.json: a small userData file main owns.
//
// WHAT IT IS FOR. "Did the crashes start after the update?" is unanswerable from a console nobody
// can read in a packaged build. appVersion on every row is what makes it answerable.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CRASH_RECORD_MAX, appendCrashRecord, type CrashRecord } from '@shared/renderer-recovery'

export const CRASH_RECORD_FILE = 'renderer-crashes.json'

/** Absolute path of the record, given a userData dir. Exported so a notice can name the file. */
export function crashRecordPath(dir: string): string {
  return join(dir, CRASH_RECORD_FILE)
}

/**
 * Read the durable crash record, newest-first.
 *
 * A missing file, a non-array body, or a half-written one all read as `[]`. That is not leniency for
 * its own sake: this file is written from inside a crash handler, so the most likely way for it to be
 * corrupt is a crash DURING the write — and a reader that threw on that would take down the recovery
// it exists to support. Every row is shape-checked, so a truncated object cannot reach a caller that
 * expects `at` to be a number.
 */
export function readCrashRecords(dir: string): CrashRecord[] {
  try {
    const p = crashRecordPath(dir)
    if (!existsSync(p)) return []
    const parsed: unknown = JSON.parse(readFileSync(p, 'utf8'))
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isCrashRecord)
  } catch {
    return []
  }
}

/** The row shape this file holds. Anything else is dropped rather than passed through. */
export function isCrashRecord(value: unknown): value is CrashRecord {
  if (!value || typeof value !== 'object') return false
  const r = value as Partial<CrashRecord>
  return typeof r.at === 'number' && typeof r.reason === 'string' && typeof r.appVersion === 'string'
}

/**
 * Append one crash and write the capped record. Never throws: losing the record is bad, crashing
 * inside the crash handler is worse.
 *
 * Reads first, so concurrent-ish writes across launches accumulate rather than truncate. This is not
 * a locking guarantee — it is one process writing a small file it owns.
 */
export function recordCrash(dir: string, next: CrashRecord): CrashRecord[] {
  const records = appendCrashRecord(readCrashRecords(dir), next)
  try {
    writeFileSync(crashRecordPath(dir), JSON.stringify(records, null, 2), 'utf8')
  } catch {
    // Swallowed deliberately, mirroring recordSocketEvent's rule: diagnostics must not take down the
    // thing they describe. The console line the caller already emitted stays the fallback record.
  }
  return records
}

export { CRASH_RECORD_MAX }
