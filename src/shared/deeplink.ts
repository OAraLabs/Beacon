// beacon:// deep links, INBOUND — pure parse + policy, shared by main and the
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
  // One word of the plain characters session ids are made of. Anything else is refused, not
  // repaired: an id is also a place a link could try to carry a sentence, a path, or characters
  // that reshape how it reads.
  return /^[A-Za-z0-9][A-Za-z0-9:_.@+=|/-]{0,127}$/.test(id) && !id.includes('..') && !id.includes('//')
}

/** Parameter names that could hold words for the assistant. Refused on every route. */
const TEXT_PARAMS = new Set(['text', 'prompt', 'message', 'msg', 'q', 'query', 'body', 'content', 'instructions', 'instruction', 'input', 'ask', 'say', 'draft', 'command', 'cmd', 'run'])

/**
 * What Beacon shows when it refuses a link: fixed words, the same for every refused link. Nothing
 * the link says is in them (not its address, not its route, not a reason built from either):
 * anyone can make a beacon:// link, and a notification under Beacon's name is not theirs to write.
 * Why a link was refused is in main's log.
 */
export const LINK_BLOCKED_NOTICE = { title: 'Link blocked', body: 'Beacon blocked a link it does not open. Nothing was opened or sent.' } as const

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
  // A LINK NEVER CARRIES WORDS FOR THE ASSISTANT. Anyone can mint a beacon:// link (a web page, a
  // chat message, a QR code), so a link may say WHERE to go and nothing else. `open` is the one
  // route there is (an unknown route is refused and named, below, whatever it carries), and on it
  // a parameter that could hold text is refused by name, with the whole link: a link that is half
  // obeyed ("opened the conversation, ignored the text") teaches people that such links work.
  if (route === 'open') {
    for (const k of u.searchParams.keys()) {
      // The reason is fixed words: nothing the link itself says is repeated in a REASON, so a
      // link cannot write a line of its own into the log through one.
      if (TEXT_PARAMS.has(k.toLowerCase())) return { kind: 'refused', reason: 'a link cannot carry text for your assistant' }
    }
    // Exactly one thing: which conversation. Nothing else rides along, in the query, the path or
    // after a #.
    const extra = [...u.searchParams.keys()].find((k) => k !== 'session')
    if (extra !== undefined) return { kind: 'refused', reason: 'beacon://open takes only ?session=<id>' }
    if (u.searchParams.getAll('session').length > 1 || (u.pathname !== '' && u.pathname !== '/') || u.hash !== '' || u.username !== '' || u.password !== '' || u.port !== '') {
      return { kind: 'refused', reason: 'beacon://open takes only ?session=<id>' }
    }
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
