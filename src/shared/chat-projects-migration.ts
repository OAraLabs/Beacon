// Moving the projects kept on this computer to the Prometheus they belong to (docs: the desktop paste from the Prometheus side, §3).
//
// THE RULE (the owner's): each local folder's conversations go to the Prometheus they belong to; a folder with conversations on more than one
// Prometheus is SPLIT, keeping its name on each side; nothing is dropped; the local copy is kept until the move is confirmed, and is
// never deleted after it.
//
// Beacon holds one Prometheus at a time, and a local store is kept per Prometheus (src/shared/daemon-profiles.ts). So the move runs for
// the Prometheus Beacon is connected to, whenever that is, and a Prometheus that is offline or has no projects keeps its part locally
// until it is the one Beacon is on. A conversation belongs to the Prometheus that LISTS it: a Prometheus's session list is durable and
// complete, so one it does not list is not there (gone, or on another). Each Prometheus is asked about every local store, so a folder that
// spans two ends up on both, and nothing needs remembering between them: the local stores are never deleted, and every step is safe to
// repeat. No project is ever deleted on a Prometheus by the move.
//
// Pure (no Node/Electron), so a smoke can hold the plan still.

import { importKey } from './chat-projects'
import type { ProjectStore } from './session-projects'

export interface PlannedProject {
  /** `import_key` for the daemon: `beacon-desktop:<local id>`, and for another store's `beacon-desktop:<folder>:<local id>`. Null when the id can't make one. */
  key: string | null
  localId: string
  name: string
  /** `own`: this Prometheus's own store. Otherwise the id of the folder whose store it is. */
  origin: 'own' | string
  /** Its conversations this Prometheus lists: the ones to file. */
  sessions: string[]
  /** Assigned in the local store but not in this Prometheus's list: not filed, and counted as left unfiled. */
  missing: string[]
}

/**
 * Which projects to make on this Prometheus, and which conversations to file in each.
 *   * every project of its own store, in display order, EMPTY ONES AND ONES WHOSE CONVERSATIONS ARE ELSEWHERE INCLUDED (a name a person
 *     chose is not dropped; a folder wholly on another Prometheus leaves a project of that name here too, which is the name kept on each side);
 *   * a project of ANOTHER store only when this Prometheus lists at least one of its conversations, and then only those;
 *   * a conversation is planned once: its own store's filing wins over another's.
 * `listed` is the ids in this Prometheus's session list.
 */
export function planMigration(o: {
  own: ProjectStore
  others: ReadonlyArray<{ folderId: string; store: ProjectStore }>
  listed: ReadonlySet<string>
}): PlannedProject[] {
  const out: PlannedProject[] = []
  const planned = new Set<string>()
  const sessionsOf = (s: ProjectStore, id: string): string[] => Object.entries(s.assign).filter(([, pid]) => pid === id).map(([sid]) => sid)
  for (const p of o.own.projects) {
    const ids = sessionsOf(o.own, p.id)
    for (const id of ids) planned.add(id)
    out.push({ key: importKey(p.id), localId: p.id, name: p.name, origin: 'own', sessions: ids.filter((id) => o.listed.has(id)), missing: ids.filter((id) => !o.listed.has(id)) })
  }
  for (const f of o.others) {
    for (const p of f.store.projects) {
      const ids = sessionsOf(f.store, p.id).filter((id) => o.listed.has(id) && !planned.has(id))
      if (ids.length === 0) continue
      for (const id of ids) planned.add(id)
      out.push({ key: importKey(`${f.folderId}:${p.id}`), localId: p.id, name: p.name, origin: f.folderId, sessions: ids, missing: [] })
    }
  }
  return out
}

export type MigrationStatus = 'running' | 'done' | 'blocked' | 'incomplete'

/** What the window is told about the move. */
export interface MigrationState {
  status: MigrationStatus
  /** Projects made on, or found already on, this Prometheus. */
  projects: number
  /** Conversations filed. */
  moved: number
  /** Conversations Prometheus does not have (or runs itself) that stay unfiled; their local copy is kept. */
  leftovers: number
  /** Why it did not finish, in words; null otherwise. */
  message: string | null
  /** This run did the work (as opposed to finding it already done), so the person is told once. */
  fresh: boolean
}

/** The one line the person is told when the move has finished, or null when there is nothing to say. */
export function migrationNote(m: MigrationState): string | null {
  if (m.status === 'blocked' || m.status === 'incomplete') return m.message
  if (m.status !== 'done' || !m.fresh || (m.projects === 0 && m.moved === 0)) return null
  const what = `${m.projects} project${m.projects === 1 ? '' : 's'}${m.moved > 0 ? ` and ${m.moved} conversation${m.moved === 1 ? '' : 's'}` : ''}`
  const left = m.leftovers > 0 ? ` ${m.leftovers} conversation${m.leftovers === 1 ? ' stays' : 's stay'} unfiled: Prometheus no longer has ${m.leftovers === 1 ? 'it' : 'them'}.` : ''
  return `Your projects moved to this Prometheus (${what}).${left} The copy on this computer is kept.`
}

export const MIGRATION_WORDS = {
  blockedFolder: "Prometheus can't make folders for projects yet (its projects folder isn't usable), so your projects stay here for now.",
  incomplete: "Beacon couldn't finish moving your projects to Prometheus. They stay as they are here, and it will try again."
} as const
