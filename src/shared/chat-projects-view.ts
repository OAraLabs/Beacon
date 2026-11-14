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

export type ProjectsMode = 'local' | 'daemon'

/** Which projects the sidebar draws. `local` until everything above is known and true: while anything is still being read, it is local. */
export function projectsMode(o: { state: ChatProjectsState; migrated: boolean | null; local: ProjectStore | null }): ProjectsMode {
  const { state, migrated, local } = o
  if (!state.available || !state.list || state.list.role !== 'owner') return 'local'
  if (migrated === null || local === null) return 'local'
  return migrated || !localHasProjects(local) ? 'daemon' : 'local'
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
    if (ctx.unfiling) return { kind: 'done', note: null }
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
