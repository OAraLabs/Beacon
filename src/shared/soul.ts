// Soul — GET /api/soul (Prometheus 0.9.21+): the persona (SOUL.md) the daemon puts into every prompt, for the
// owner to read. Read-only here, as on the phone (beacon-ios SoulView); there is no write route.
//
// What the daemon says about the FILE comes as a status, and four of them are not failures but true statements about
// the persona, so the view shows them instead of "couldn't load":
//
//   404 {"error":"not_found"}           the route is there and there is no SOUL.md yet
//   409 {"error":"not_a_regular_file"}  SOUL.md is a link; the daemon opens it without following one
//   413 {"error":"too_large","limit":N} over the daemon's cap, refused unread
//   503 {"error":"unreadable"}          there, and the daemon cannot read it
//
// And one that looks like the first and is not: a Prometheus that predates the route answers it as it answers any path
// it has never heard of, FastAPI's 404 {"detail":"Not Found"}. Told by its BODY, never by the status alone: a client that
// read the status would tell every older daemon "you have no persona file", which is exactly what it would be wrong about.
// Anything else (a 403, no answer, a body that is not what the daemon sends) stays an error, with a retry.

export const SOUL_PATH = '/api/soul'

export interface SoulDocument {
  content: string
  bytes: number
  /** Epoch seconds: the file's modification time. */
  modifiedAt: number
}

export type SoulAnswer =
  | { kind: 'document'; document: SoulDocument }
  | { kind: 'noPersona' }
  | { kind: 'daemonTooOld' }
  | { kind: 'linked' }
  | { kind: 'tooLarge'; limit: number | null }
  | { kind: 'unreadable' }
  /** 401 or 403: the daemon will not show this device its persona (a revoked key, or a device that may only chat). Trying again changes nothing. */
  | { kind: 'refused' }
  /** Something that is not a statement about the file: the view says so and offers to try again. */
  | { kind: 'failed' }

/** The 200 body. `failed` when it is not what the daemon sends. */
export function parseSoul(body: unknown): SoulAnswer {
  if (!body || typeof body !== 'object') return { kind: 'failed' }
  const b = body as Record<string, unknown>
  const { content, bytes, modified_at: at } = b
  if (typeof content !== 'string') return { kind: 'failed' }
  if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 0) return { kind: 'failed' }
  if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) return { kind: 'failed' }
  return { kind: 'document', document: { content, bytes, modifiedAt: at } }
}

/** The answer a failed read stands for. `message` is the error as the bridge throws it ("HTTP 404: GET /api/soul — {body}"). */
export function soulFromError(err: unknown): SoulAnswer {
  const message = err instanceof Error ? err.message : String(err)
  const m = /HTTP (\d{3}): GET \/api\/soul(?:\s|—|-)+([\s\S]*)$/.exec(message)
  if (!m) return { kind: 'failed' }
  const status = Number(m[1])
  if (status === 401 || status === 403) return { kind: 'refused' }
  let obj: Record<string, unknown> | null = null
  try {
    const parsed: unknown = JSON.parse(m[2].trim())
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) obj = parsed as Record<string, unknown>
  } catch {
    obj = null
  }
  const code = typeof obj?.error === 'string' ? obj.error : null
  if (status === 404 && code === 'not_found') return { kind: 'noPersona' }
  if (status === 404 && code === null) return obj?.detail === 'Not Found' ? { kind: 'daemonTooOld' } : { kind: 'failed' }
  if (status === 409 && code === 'not_a_regular_file') return { kind: 'linked' }
  if (status === 413 && code === 'too_large') {
    const limit = obj?.limit
    return { kind: 'tooLarge', limit: typeof limit === 'number' && Number.isInteger(limit) && limit > 0 ? limit : null }
  }
  if (status === 503 && code === 'unreadable') return { kind: 'unreadable' }
  return { kind: 'failed' }
}

/** What to tell a person when there is no persona to show; null when there is one. */
export function soulSentence(a: SoulAnswer): string | null {
  switch (a.kind) {
    case 'document':
      return null
    case 'noPersona':
      return 'This Prometheus has no persona file yet.'
    case 'daemonTooOld':
      return 'This Prometheus is too old to show its persona. It arrives with its next update.'
    case 'linked':
      return "The persona file is a link, so Prometheus won't read it. Replace it with the file itself."
    case 'tooLarge':
      return a.limit === null ? 'The persona file is too large to show here.' : `The persona file is over ${soulSize(a.limit, true)}, which is too large to show here.`
    case 'unreadable':
      return "Prometheus couldn't read its persona file."
    case 'refused':
      return "Prometheus won't show its persona to this device."
    case 'failed':
      return "Beacon couldn't read the persona just now."
  }
}

/** An empty SOUL.md is a persona with nothing in it: not a missing one, and not a blank screen. */
export function soulEmptyLine(d: SoulDocument): string | null {
  return d.content.trim() === '' ? 'The persona file is empty.' : null
}

/** A persona is a few KB; a long one is clipped and says how much. */
export const SOUL_DISPLAY_LIMIT = 100_000

export function soulShown(d: SoulDocument, limit = SOUL_DISPLAY_LIMIT): { text: string; note: string | null } {
  const chars = [...d.content]
  if (chars.length <= limit) return { text: d.content, note: null }
  const n = (v: number): string => v.toLocaleString('en-US')
  return { text: chars.slice(0, limit).join(''), note: `Showing the first ${n(limit)} of ${n(chars.length)} characters.` }
}

/** `whole`: say 256 KB, not 256.0 KB, when the size is a round number of KB (the daemon's cap is). */
export function soulSize(bytes: number, whole = false): string {
  if (bytes === 1) return '1 byte'
  if (bytes < 1024) return `${bytes} bytes`
  if (whole && bytes % 1024 === 0 && bytes < 1_048_576) return `${bytes / 1024} KB`
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1_048_576).toFixed(1)} MB`
}

/** The file's own modification day, UTC: the phone's format. */
export function soulEdited(modifiedAt: number): string {
  const d = new Date(modifiedAt * 1000)
  if (Number.isNaN(d.getTime())) return 'Edited at a time Prometheus did not say'
  return `Edited ${d.toISOString().slice(0, 10)}`
}
