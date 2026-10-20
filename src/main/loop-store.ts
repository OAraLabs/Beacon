import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { sanitizeProjects, type LoopProject } from '@shared/loop'

// Loop Manager project registry — persisted as `loop-projects.json` in userData, mirroring the
// window-state.ts pattern (Phase 0 finding 1): main owns the file handle; the renderer only ever
// sees the sanitized data via IPC. Missing/corrupt file → [] (degrade, never crash).

/** Load + sanitize the registry. Never throws — a malformed file reads as no projects. */
export function loadLoopProjects(file: string): LoopProject[] {
  try {
    if (!existsSync(file)) return []
    return sanitizeProjects(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return []
  }
}

/** Persist the registry (pretty JSON, best-effort — a write failure never breaks the app). Returns
 * the SANITIZED list actually written, so the caller echoes clean state back to the renderer. */
export function saveLoopProjects(file: string, projects: unknown): LoopProject[] {
  const clean = sanitizeProjects(projects)
  try {
    writeFileSync(file, JSON.stringify(clean, null, 2))
  } catch {
    // best-effort — never let persistence break the board
  }
  return clean
}
