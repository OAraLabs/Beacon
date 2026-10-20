// What a CONVERSATION produced — pure (no DOM, no Node, no IO), shared by the dock's progress pane
// and the headless smoke.
//
// WHY THIS IS SO NARROW. "Outputs" invites a file list, and the surface that sounds exactly right —
// the artifacts outbox at /api/artifacts — cannot supply one: it is a flat directory scan with no
// producer field, no session parameter anywhere in the stack, and a live capture showed `path`
// equal to `name` on every row. Beacon's existing per-conversation artifact association is a
// SUBSTRING MATCH of the artifact's basename against the assistant's message text, which this
// project has repeatedly refused as a proxy. /api/tools/recent cannot be scoped either — the
// tool_calls table has no session_id column at all.
//
// So the only honest answer is derived from the transcript, which IS session-keyed by construction:
// the agent's own tool calls. A `write_file` in this conversation is a file this conversation
// produced. Anything else would be a guess wearing a list's clothing.

import { partsFromContentJson, type ContentPart } from './parts'

/**
 * Tool names whose CALL means the agent wrote a file.
 *
 * Deliberately a small allow-list rather than a pattern: `read_file` and `list_files` also carry a
 * `path`, and matching on "has a path" would report reads as outputs. Verified against the live
 * registry — `write_file` and `edit_file` are the file-producing builtins; the module name is
 * `file_write`, which is exactly the transposition that made the documents tree unreachable for
 * weeks (Prometheus#507), so match the TOOL name, never the module's.
 */
export const FILE_WRITING_TOOLS: readonly string[] = ['write_file', 'edit_file']

export interface ProducedFile {
  /** The path exactly as the agent passed it — absolute, daemon-side. Displayed, never dereferenced. */
  path: string
  /** Which tool produced it, so the row can say "written" vs "edited" without guessing. */
  tool: string
  /** Transcript position of the LAST call that touched it — the list is newest-last. */
  ordinal: number
}

/** A message as the daemon serves it. Only the three fields this module reads are required. */
export interface OutputMessage {
  content_json?: string | null
  content?: string | null
  ordinal?: number
}

function pathOf(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null
  const p = (args as { path?: unknown }).path
  return typeof p === 'string' && p.trim() ? p.trim() : null
}

/** The file-writing calls in one message's parts. Exported for the smoke; the caller wants the fold. */
export function producedInParts(parts: readonly ContentPart[], ordinal: number): ProducedFile[] {
  const out: ProducedFile[] = []
  for (const part of parts) {
    if (part.type !== 'toolCall') continue
    const tool = part.name ?? ''
    if (!FILE_WRITING_TOOLS.includes(tool)) continue
    const path = pathOf(part.args)
    // A file-writing call with no readable path is DROPPED rather than rendered as a blank row.
    // The alternative — an entry saying nothing — reads as a file whose name failed to load.
    if (path) out.push({ path, tool, ordinal })
  }
  return out
}

/**
 * Everything this conversation produced, oldest first, one row per PATH.
 *
 * Writing the same file twice is one output, not two: the list answers "what exists because of this
 * conversation", and the second write did not make a second file. The last call wins so the tool
 * shown is the one that left the file in its current state.
 */
export function producedFiles(messages: readonly OutputMessage[]): ProducedFile[] {
  const byPath = new Map<string, ProducedFile>()
  messages.forEach((m, i) => {
    const parts = partsFromContentJson(m.content_json, m.content ?? '')
    for (const f of producedInParts(parts, m.ordinal ?? i)) byPath.set(f.path, f)
  })
  return [...byPath.values()].sort((a, b) => a.ordinal - b.ordinal)
}

/** Just the file name, for a row that cannot show a daemon-absolute path in 320px. */
export function baseName(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : path
}

/**
 * The empty state's words, named after the REASON rather than the absence.
 *
 * "No outputs yet" would be false in the way that matters: the agent may well have published
 * plenty, into an outbox that is shared across every conversation and cannot be attributed to any
 * one of them. The reader needs to know where those went, not to conclude nothing happened.
 */
export const OUTPUTS_EMPTY = {
  noneInThisConversation:
    'Nothing produced in this conversation yet. Files the agent publishes to its outbox are shared ' +
    'across all conversations and carry no record of which one made them, so they are not listed ' +
    'here — see Workspace › Artifacts for that shared list.',
  noConversation:
    'Outputs follow a conversation. Open one and the files its agent writes appear here.'
}
