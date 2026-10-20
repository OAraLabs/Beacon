// beacon:// deep links, INBOUND (PARITY-PLAN A4) — pure parse + policy, shared by main and the
// headless smoke.
//
// Trust stance: an inbound URL is UNTRUSTED INPUT that any web page, chat message, or QR code can
// mint. So the route table is an allowlist of harmless intents, and the one route that could do
// damage is refused BY NAME: `beacon://pair?host=…&token=…` exists for phones to consume
// (src/shared/devices.ts mints it) — the desktop must never accept one, because a link that can
// repoint the connection or plant a credential is a phishing primitive. Refusals are visible
// (caller notifies), never silent drops.

export type DeepLinkAction =
  | { kind: 'open'; sessionId: string }
  | { kind: 'refused'; reason: string }

/** Session ids on the wire look like `beacon:<uuid>` / `desktop:<uuid>` / `voice:beacon` —
 * printable, no whitespace, and never long. Anything outside that shape is refused, not repaired. */
function validSessionId(id: string): boolean {
    // Control characters and whitespace are refused outright; everything printable passes.
  // eslint-disable-next-line no-control-regex
  return id.length > 0 && id.length <= 128 && !/[\s\u0000-\u001f\u007f]/.test(id)
}

/**
 * Classify one URL. Returns null for anything that is not a beacon:// URL at all (argv is full of
 * ordinary arguments); a DeepLinkAction for everything that is. Unknown routes and malformed
 * links come back as `refused` with a reason — the caller surfaces it, because a link that
 * silently does nothing is indistinguishable from a broken feature.
 */
export function parseDeepLink(raw: string): DeepLinkAction | null {
  if (typeof raw !== 'string' || !raw.toLowerCase().startsWith('beacon://')) return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return { kind: 'refused', reason: 'malformed beacon:// link' }
  }
  const route = u.host.toLowerCase()
  if (route === 'open') {
    const sessionId = u.searchParams.get('session') ?? ''
    if (!validSessionId(sessionId)) return { kind: 'refused', reason: 'beacon://open needs a valid ?session=<id>' }
    return { kind: 'open', sessionId }
  }
  if (route === 'pair')
    return {
      kind: 'refused',
      reason:
        'pairing links are consumed by phones — Beacon mints beacon://pair and never accepts one; a link must not be able to repoint the connection'
    }
  return { kind: 'refused', reason: `unknown beacon:// route "${route}"` }
}

/** The first beacon:// argument in an argv, or null. Windows/Linux deliver deep links this way
 * (cold start and second-instance both); everything else in argv is flags and paths. */
export function firstDeepLinkInArgv(argv: readonly string[]): string | null {
  for (const a of argv) if (typeof a === 'string' && a.toLowerCase().startsWith('beacon://')) return a
  return null
}
