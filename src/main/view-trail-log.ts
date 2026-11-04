// Appends @shared/view-trail's line to <profile>/logs/view-trail.log, kept to its last VIEW_TRAIL_MAX_CHARS. Written in every build,
// packaged ones included: the question it answers came from a packaged build.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { keepTail, VIEW_TRAIL_MAX_CHARS } from '@shared/view-trail'

export function appendViewTrail(file: string, line: unknown): void {
  if (typeof line !== 'string' || line.length === 0 || line.length > 4096 || /[\r\n]/.test(line)) return
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, line + '\n', { mode: 0o600 })
    const text = readFileSync(file, 'utf8')
    if (text.length > VIEW_TRAIL_MAX_CHARS) writeFileSync(file, keepTail(text, VIEW_TRAIL_MAX_CHARS), { mode: 0o600 })
  } catch (e) {
    console.warn('[view-trail] could not write the log:', (e as Error).message)
  }
}
