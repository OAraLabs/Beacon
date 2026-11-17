// What the sidebar does with a Prometheus's projects (@shared/chat-projects), decided here so a smoke can hold it still: which
// projects it draws (the daemon's or this computer's), what a filing answer turns into (a done note, a question, or a refusal), and
// the words for each.
//
// ONE RULE FIRST. The daemon's projects replace the local ones only when ALL of these are true, and in every other case the sidebar is
// exactly what it was:
//   * the Prometheus says it serves projects, and this Beacon is its owner (a device that may only chat is told nothing);
//   * and either the local projects have been moved to it (`chat-projects:migrated:v1`, set once, per Prometheus, by the move), or
//     there are no local projects to move.
// A Beacon with local projects and a Prometheus that has not had them moved keeps its local ones, and never deletes them.
//
// No Node/Electron imports (same rule as the rest of src/shared).

import type { ChatProjectsResult, ChatProjectsState, ChatProject } from './chat-projects'
import type { ProjectHint, ProjectStore } from './session-projects'

/** Set once, in this Prometheus's folder, when the local projects have been moved to it and the move confirmed: `{"done":true,...}`.
 *  The local copy is kept (never deleted); from then on it is not read or written for grouping, only for dismissed suggestions. */
export const CHAT_PROJECTS_MIGRATED_KEY = 'chat-projects:migrated:v1'

/** Whether a stored `chat-projects:migrated:v1` says the move is done. Anything else, unreadable or absent, is "not done". */
export function parseMigrated(raw: string | null | undefined): boolean {
  if (!raw) return false
  try {
    const v = JSON.parse(raw) as { done?: unknown } | null
    return !!v && typeof v === 'object' && v.done === true
  } catch {
    return false
  }
}

/** Local projects that would have to be moved: any project, or any conversation filed in one. */
export function localHasProjects(local: ProjectStore): boolean {
  return local.projects.length > 0 || Object.keys(local.assign).length > 0
}

/** Set (once, per Prometheus) the first time it is seen serving projects. A Prometheus that served them and now says nothing (offline,
 *  or still connecting) is waited for rather than taken for one that never did. */
export const CHAT_PROJECTS_SERVED_KEY = 'chat-projects:served:v1'

/** `wait`: not known yet. The local projects are drawn as they are, but nothing that would make or change a project is done: a
 *  project made here in that moment would become the local projects that keep the Prometheus's from ever being drawn. */
export type ProjectsMode = 'local' | 'daemon' | 'wait'

/**
 * Which projects the sidebar draws.
 *   * `wait` while anything this rule needs is still being read; while the local projects are being moved to the Prometheus; while a Prometheus that has served projects before (or has had the
 *     local ones moved to it) is not answering now; and while the Prometheus's own answer is still on its way AND there are no local
 *     projects yet (the one moment a project made here could keep its projects from ever being drawn). With local projects already
 *     there and a Prometheus that has never served any, nothing waits: it is local, at once, as it always was;
 *   * `local` for a Prometheus that has never served them, and one that does but this Beacon may not change (not its owner), and one
 *     that does while the local projects have not been moved to it;
 *   * `daemon` once all of the rule at the top of this file is true.
 */
export function projectsMode(o: { state: ChatProjectsState; migrated: boolean | null; local: ProjectStore | null; servedBefore: boolean | null }): ProjectsMode {
  const { state, migrated, local, servedBefore } = o
  if (migrated === null || local === null || servedBefore === null) return 'wait'
  if (!state.available) {
    if (migrated || servedBefore) return 'wait'
    return !state.known && !localHasProjects(local) ? 'wait' : 'local'
  }
  if (!state.list) return 'wait' // it serves them; its list is still being read
  // The local projects are being moved: an edit now would not be in what is moved, and the move would then hide it.
  if (state.migration?.status === 'running') return 'wait'
  if (state.list.role !== 'owner') return 'local'
  return migrated || !localHasProjects(local) ? 'daemon' : 'local'
}

/**
 * The stored local store with its `dismissed` replaced and NOTHING else changed: every project, every filing and every field it
 * has, including any this version would drop on reading it. Null when what is stored cannot be read as an object (nothing is written
 * over it). With nothing stored, a store holding only the dismissals.
 */
export function writeDismissedOnly(stored: string | null | undefined, dismissed: Record<string, string>): string | null {
  if (stored === null || stored === undefined || stored === '') return JSON.stringify({ projects: [], assign: {}, dismissed })
  let v: unknown
  try {
    v = JSON.parse(stored)
  } catch {
    return null
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  return JSON.stringify({ ...(v as Record<string, unknown>), dismissed })
}

/** The store the sidebar draws, from the daemon's projects and filings, plus the dismissals that stay on this computer. */
export function storeFromDaemon(state: ChatProjectsState, dismissed: Record<string, string>): ProjectStore {
  return {
    projects: (state.list?.projects ?? []).map((p) => ({ id: p.id, name: p.name })),
    assign: { ...state.filings },
    dismissed: { ...dismissed }
  }
}

/** The suggestions the daemon makes, in the shape the sidebar already draws. */
export function hintsFromDaemon(state: ChatProjectsState): Record<string, ProjectHint> {
  const out: Record<string, ProjectHint> = {}
  for (const [sid, s] of Object.entries(state.suggestions)) out[sid] = { key: s.key, label: s.label, share: s.share, calls: s.calls }
  return out
}

/** The last two parts of a folder, for a sentence: `…/projects-root/kitchen-remodel`. The whole path is in the tooltip. */
export function shortFolder(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`
}

/** A question the daemon asked back about a filing. The person answers; nothing is decided for them. */
export interface FilingQuestion {
  kind: 'workspace' | 'device'
  sessionId: string
  /** What the conversation is called, for the sentence. */
  title: string
  projectId: string
  projectName: string
  /** The project's folder, when known (an owner is told). */
  projectFolder: string | null
  /** `workspace`: the folder somebody chose for the conversation. */
  workspace: string | null
}

export type FilingOutcome =
  | { kind: 'done'; note: string | null }
  | { kind: 'ask'; question: FilingQuestion }
  | { kind: 'say'; message: string }

/**
 * What a filing's answer turns into. `keep` is what was sent: a filing that left the conversation's folder alone.
 *   * done: a note that says where the conversation works now (a conversation moved into a project works in its folder);
 *   * the two questions the daemon can ask back become questions with the folder in them;
 *   * anything else is the refusal's own sentence.
 */
export function filingOutcome(
  result: ChatProjectsResult,
  ctx: { sessionId: string; title: string; project: Pick<ChatProject, 'id' | 'name' | 'folder'> | null; keep: boolean; unfiling: boolean }
): FilingOutcome {
  if (result.ok) {
    if (ctx.unfiling) {
      const here = typeof result.workspace === 'string' && result.workspace ? `It works in ${shortFolder(result.workspace)}.` : "It works in Prometheus's own workspace."
      return { kind: 'done', note: `Taken out of the project. ${here}` }
    }
    const where = ctx.project?.name ? `“${ctx.project.name}”` : 'the project'
    if (ctx.keep) return { kind: 'done', note: `Filed in ${where}. Its own folder was left as it was.` }
    return {
      kind: 'done',
      note: typeof result.workspace === 'string' && result.workspace ? `Moved to ${where}. It now works in ${shortFolder(result.workspace)}.` : `Moved to ${where}.`
    }
  }
  if ((result.kind === 'workspace_set' || result.kind === 'device_session') && ctx.project) {
    return {
      kind: 'ask',
      question: {
        kind: result.kind === 'workspace_set' ? 'workspace' : 'device',
        sessionId: ctx.sessionId,
        title: ctx.title,
        projectId: ctx.project.id,
        projectName: ctx.project.name,
        projectFolder: ctx.project.folder || null,
        workspace: result.workspace ?? null
      }
    }
  }
  return { kind: 'say', message: result.message }
}

/** The words of a question, and its choices. A choice is a flag set on the filing it is sent with; Cancel sends nothing. */
export function questionWords(q: FilingQuestion): { text: string; choices: Array<{ label: string; send: { keep?: boolean; replace?: boolean }; primary?: boolean }> } {
  const name = q.title || 'This conversation'
  if (q.kind === 'workspace') {
    const there = q.workspace ? ` (${shortFolder(q.workspace)})` : ''
    return {
      text: `${name} already works in a folder that was chosen for it${there}. Move it into “${q.projectName}”, so it works in the project's folder, or just file it there and leave its folder alone?`,
      choices: [
        { label: 'Leave its folder alone', send: { keep: true }, primary: true },
        { label: "Use the project's folder", send: { replace: true } }
      ]
    }
  }
  // A conversation that belongs to a phone that can only chat: binding a folder to it would let it change files there. That is not
  // offered here; it can be filed as a label, and the folder question stays with whoever owns that phone.
  return {
    text: `${name} belongs to a phone that can only chat. It can be filed in “${q.projectName}”, but it will keep working where it does now.`,
    choices: [{ label: 'File it, leave its folder alone', send: { keep: true }, primary: true }]
  }
}

/** Said when a change in a batch was filed as a label because the daemon asked about its folder: nothing was decided for the person. */
export function batchNote(n: number): string {
  return n === 1
    ? 'One conversation already had a folder chosen for it, so it was filed without changing its folder.'
    : `${n} conversations already had a folder chosen for them, so they were filed without changing their folders.`
}

/** What a batch of filings did, in one note (each filing's own note would replace the one before it). */
export function batchSummary(o: { project: string; folder: string | null; moved: number; labelled: number; refused: number; why: string | null }): string {
  const parts: string[] = []
  if (o.moved > 0) parts.push(`Moved ${o.moved} conversation${o.moved === 1 ? '' : 's'} to “${o.project}”${o.folder ? `. ${o.moved === 1 ? 'It now works' : 'They now work'} in ${shortFolder(o.folder)}` : ''}.`)
  if (o.labelled > 0) parts.push(batchNote(o.labelled))
  if (o.refused > 0) parts.push(`${o.refused} could not be filed${o.why ? `: ${o.why}` : '.'}`)
  return parts.join(' ')
}
