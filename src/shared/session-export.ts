// Pure conversation-export model — shared by main (which writes the file) and the headless smoke.
// No DOM, no fs.
//
// Nothing exported a conversation before this. The transcript lived in the daemon's LCM store and
// in Beacon's cache, and the only way to get any of it out was the per-message copy button.
//
// Two formats, for two different readers, and the difference is deliberate:
//   markdown — for a person. Tool calls are summarized to one line; arguments and outputs are NOT
//              inlined, because a transcript drowned in JSON is not readable, and pretending
//              otherwise is how an export gets written once and never opened.
//   json     — for a machine. Faithful: every row, every tool call with its arguments and output,
//              plus the durable rowid so an export can be correlated back to the daemon's store.
//
// Both carry the same header facts, so a markdown file can always be traced to the session and
// the moment it was taken.

import { partsFromContentJson, type ContentPart } from './parts'

export type ExportFormat = 'markdown' | 'json'

/** The subset of a cached row an export needs. Matches HistoryMessage structurally. */
export interface ExportableMessage {
  rowId: number | null
  role: string
  content: string
  contentJson?: string | null
  createdAt?: number
}

export interface ExportMeta {
  sessionId: string
  title?: string
  gateway?: string
  /** epoch ms — when the export was taken, not when the conversation happened. */
  exportedAt: number
  appVersion?: string
}

/** The JSON envelope's version. Bump only for a breaking shape change. */
export const EXPORT_SCHEMA = 1

const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

/**
 * `2026-08-27 13:45 UTC` — a transcript wants a readable stamp, not an ISO string per line.
 *
 * The zone is SPELLED OUT rather than implied. The app itself shows no per-message time, so there
 * is nothing on screen for this to contradict — but a bare `2026-08-27 13:45` in a file someone
 * reads a month later is read as local time, and being silently five hours out is exactly the
 * class of quiet wrongness this export exists to avoid.
 */
function stamp(ms?: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return ''
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`
}

/**
 * Filesystem-safe name. A session id carries a colon (`telegram:123`) and can carry a slash, so it
 * is sanitized rather than trusted — the id is data from the daemon, and a path is not a place to
 * find out otherwise.
 */
export function exportFilename(sessionId: string, format: ExportFormat, whenMs: number): string {
  const safe =
    (sessionId || 'session')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      // No `..` survives. A separator is already gone by the line above, so this cannot traverse
      // either way — but a name carrying `..` invites someone to assume it can, and the daemon's
      // session id is data, not a promise.
      .replace(/\.{2,}/g, '.')
      // A leading dot would make it a hidden file; a leading dash reads as a CLI flag.
      .replace(/^[.\-]+|[.\-]+$/g, '')
      .slice(0, 60) || 'session'
  const d = new Date(whenMs)
  const p = (n: number): string => String(n).padStart(2, '0')
  const when = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`
  return `beacon-${safe}-${when}.${format === 'json' ? 'json' : 'md'}`
}

/** Text of a row as the UI would show it — the same parser the renderer uses, so they cannot drift. */
function partsOf(m: ExportableMessage): ContentPart[] {
  return partsFromContentJson(m.contentJson ?? null, m.content ?? '')
}

function textOf(parts: ContentPart[]): string {
  return parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .join('')
    .trim()
}

/** One-line summary of a tool call for the human format. Arguments are NAMED, never dumped. */
function toolLine(p: ContentPart): string {
  const name = p.name || 'tool'
  const args = p.args && typeof p.args === 'object' ? Object.keys(p.args as Record<string, unknown>) : []
  return args.length > 0 ? `_tool: ${name}(${args.join(', ')})_` : `_tool: ${name}_`
}

const ROLE_LABEL: Record<string, string> = { user: 'You', assistant: 'Prometheus', system: 'System' }

/**
 * A conversation as readable markdown. Rows that carry no text and no tool call are DROPPED —
 * they render as nothing in the app too (a persisted tool-plumbing row), and an export full of
 * empty headings would misrepresent the conversation as having gaps it does not have.
 */
export function toMarkdown(meta: ExportMeta, messages: ExportableMessage[]): string {
  const out: string[] = []
  out.push(`# ${meta.title || meta.sessionId}`)
  out.push('')
  out.push(`- **Session:** \`${meta.sessionId}\``)
  if (meta.gateway) out.push(`- **Gateway:** ${meta.gateway}`)
  out.push(`- **Exported:** ${iso(meta.exportedAt)}${meta.appVersion ? ` by Beacon ${meta.appVersion}` : ''}`)
  out.push(`- **Messages:** ${messages.length}`)
  out.push('')
  out.push('> Times are UTC. Tool calls are summarized to one line — export as JSON for arguments and output.')
  out.push('')
  out.push('---')
  out.push('')

  for (const m of messages) {
    const parts = partsOf(m)
    const body = textOf(parts)
    const tools = parts.filter((p) => p.type === 'toolCall')
    if (!body && tools.length === 0) continue
    const when = stamp(m.createdAt)
    out.push(`### ${ROLE_LABEL[m.role] ?? m.role}${when ? ` · ${when}` : ''}`)
    out.push('')
    for (const t of tools) out.push(toolLine(t), '')
    if (body) {
      out.push(body)
      out.push('')
    }
  }
  return out.join('\n')
}

/** The machine format: faithful, correlatable, and versioned. */
export function toJson(meta: ExportMeta, messages: ExportableMessage[]): string {
  return JSON.stringify(
    {
      schema: EXPORT_SCHEMA,
      exportedAt: iso(meta.exportedAt),
      app: meta.appVersion ? `beacon ${meta.appVersion}` : 'beacon',
      session: { id: meta.sessionId, title: meta.title ?? null, gateway: meta.gateway ?? null },
      messages: messages.map((m) => {
        const parts = partsOf(m)
        return {
          // The durable LCM rowid — what makes an exported turn correlatable back to the daemon.
          // null on an optimistic row that never got one.
          rowId: m.rowId,
          role: m.role,
          at: typeof m.createdAt === 'number' && m.createdAt > 0 ? iso(m.createdAt) : null,
          text: textOf(parts),
          toolCalls: parts
            .filter((p) => p.type === 'toolCall')
            .map((p) => ({ id: p.id ?? null, name: p.name ?? null, args: p.args ?? null })),
          toolResults: parts
            .filter((p) => p.type === 'toolResult')
            .map((p) => ({ toolUseId: p.toolUseId ?? null, output: p.output ?? '', error: p.error === true }))
        }
      })
    },
    null,
    2
  )
}

/** Build whichever format was asked for. One entry point so the two cannot diverge in the caller. */
export function renderExport(format: ExportFormat, meta: ExportMeta, messages: ExportableMessage[]): string {
  return format === 'json' ? toJson(meta, messages) : toMarkdown(meta, messages)
}
