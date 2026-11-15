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
  /** Its conversations this Prometheus lists and has in no project: the ones to file. */
  sessions: string[]
  /** Its conversations this Prometheus lists that are ALREADY in a project there (somebody filed them, here or on the phone): left exactly where they are. */
  already: string[]
  /** Assigned in the local store but not in this Prometheus's list: not filed, and counted as left unfiled. */
  missing: string[]
}

/**
 * Which projects to make on this Prometheus, and which conversations to file in each.
 *   * every project of its own store, in display order, EMPTY ONES AND ONES WHOSE CONVERSATIONS ARE ELSEWHERE INCLUDED (a name a person
 *     chose is not dropped; a folder wholly on another Prometheus leaves a project of that name here too, which is the name kept on each side);
 *   * a project of ANOTHER store only when this Prometheus lists at least one of its conversations, and then only those;
 *   * a conversation is planned once: its own store's filing wins over another's.
 * `listed` is this Prometheus's session list: conversation id → the project it is in there, or null. A conversation already in a project on the
 * Prometheus is never filed again by the move: the daemon would replace that filing, and the person (or another Beacon) put it there.
 */
export function planMigration(o: {
  own: ProjectStore
  others: ReadonlyArray<{ folderId: string; store: ProjectStore }>
  listed: ReadonlyMap<string, string | null>
}): PlannedProject[] {
  const out: PlannedProject[] = []
  const planned = new Set<string>()
  const sessionsOf = (s: ProjectStore, id: string): string[] => Object.entries(s.assign).filter(([, pid]) => pid === id).map(([sid]) => sid)
  for (const p of o.own.projects) {
    const ids = sessionsOf(o.own, p.id)
    for (const id of ids) planned.add(id)
    out.push({
      key: importKey(p.id),
      localId: p.id,
      name: p.name,
      origin: 'own',
      sessions: ids.filter((id) => o.listed.has(id) && o.listed.get(id) === null),
      already: ids.filter((id) => typeof o.listed.get(id) === 'string'),
      missing: ids.filter((id) => !o.listed.has(id))
    })
  }
  for (const f of o.others) {
    for (const p of f.store.projects) {
      const ids = sessionsOf(f.store, p.id).filter((id) => o.listed.has(id) && !planned.has(id))
      const toFile = ids.filter((id) => o.listed.get(id) === null)
      if (toFile.length === 0) {
        // Nothing of this project is here to file (all already in a project, or none listed): no project is made for it on this Prometheus.
        for (const id of ids) planned.add(id)
        continue
      }
      for (const id of ids) planned.add(id)
      out.push({ key: importKey(`${f.folderId}:${p.id}`), localId: p.id, name: p.name, origin: f.folderId, sessions: toFile, already: ids.filter((id) => typeof o.listed.get(id) === 'string'), missing: [] })
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
  /** Conversations that could not be filed here and stay unfiled (not on this Prometheus, or not ones it files); their local copy is kept. */
  leftovers: number
  /** Conversations already in a project on the Prometheus, left exactly where they are. */
  alreadyFiled: number
  /** Projects the Prometheus would not take (its name); their local copy is kept. */
  skippedProjects: number
  /** Why it did not finish, in words; null otherwise. */
  message: string | null
  /** This run did the work (as opposed to finding it already done), so the person is told once. */
  fresh: boolean
}

/** The one line the person is told when the move has finished, or null when there is nothing to say. */
export function migrationNote(m: MigrationState): string | null {
  if (m.status === 'blocked' || m.status === 'incomplete') return m.message
  if (m.status !== 'done' || !m.fresh || (m.projects === 0 && m.moved === 0 && m.skippedProjects === 0)) return null
  const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`
  const what = `${plural(m.projects, 'project', 'projects')}${m.moved > 0 ? ` and ${plural(m.moved, 'conversation', 'conversations')}` : ''}`
  const parts = [`Your projects moved to this Prometheus (${what}).`]
  if (m.alreadyFiled > 0) parts.push(`${plural(m.alreadyFiled, 'conversation was', 'conversations were')} already in a project there and ${m.alreadyFiled === 1 ? 'was' : 'were'} left where ${m.alreadyFiled === 1 ? 'it is' : 'they are'}.`)
  if (m.leftovers > 0) parts.push(`${plural(m.leftovers, 'conversation', 'conversations')} couldn't be filed here and ${m.leftovers === 1 ? 'stays' : 'stay'} unfiled: ${m.leftovers === 1 ? 'it may' : 'they may'} be on another Prometheus, or gone.`)
  if (m.skippedProjects > 0) parts.push(`${plural(m.skippedProjects, 'project', 'projects')} couldn't be moved: Prometheus wouldn't take ${m.skippedProjects === 1 ? 'its name' : 'their names'}.`)
  parts.push('The copy on this computer is kept.')
  return parts.join(' ')
}

export const MIGRATION_WORDS = {
  blockedFolder: "Prometheus can't make folders for projects yet (its projects folder isn't usable), so your projects stay here for now.",
  incomplete: "Beacon couldn't finish moving your projects to Prometheus. They stay as they are here, and it will try again."
} as const
