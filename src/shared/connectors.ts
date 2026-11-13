// MCP Connectors — pure wire model, shared by the Config tab, the dev stub in
// main, and the headless smoke.
//
// THE WIRE SHAPE IS BEACON'S SIDE OF Prometheus#332. The daemon endpoint does not exist yet; this
// module states exactly what Beacon expects so the daemon session can match it (or we adapt here,
// in one file). Foundation Spec §2.3a context: the daemon's MCP client is the sanctioned tool
// surface, and per-server `allowed_tools` (Prometheus#331) is a named prerequisite — so the
// allowlist is a first-class control in this model, not an afterthought.

import { isPrivateHost } from './daemon-api'

export const MCP_SERVERS_PATH = '/api/mcp/servers'

export type McpTransport = 'stdio' | 'http' | 'sse'
export type McpHealth = 'connected' | 'failed' | 'disabled' | 'unknown'

export interface McpToolInfo {
  name: string
  description?: string
  /** The server's readOnlyHint (#315: undeclared = NOT read-only; a non-read-only call needs
   * approval at the gate). Rendered as a small marker so the operator can see which is which. */
  readOnlyHint?: boolean
}

export interface McpServer {
  id: string
  name: string
  transport: McpTransport
  /** stdio: the command line. http/sse: the URL. Exactly one is meaningful per transport. */
  command?: string
  url?: string
  enabled: boolean
  /** True for `source: 'config'` (prometheus.yaml) servers — READ-ONLY over REST: the daemon
   * never writes its own yaml, so Beacon offers no mutation affordances on these cards. */
  readOnly?: boolean
  /** PROBED health, never config echo — a dead server must read failed, not as empty success. */
  health: McpHealth
  /** Why, when health is 'failed'. */
  healthDetail?: string
  tools: McpToolInfo[]
  /**
   * Per-server allowlist (#331). null = ALL tools allowed (the absent-field default, chosen
   * explicitly). An array — even an empty one — is authoritative: [] means "none".
   */
  allowedTools: string[] | null
  /** NAMES of the headers the daemon sends this server (its `header_names`). The values are the
   *  sign-in secret: the daemon never returns them, and this model has no field that could hold one. */
  headerNames: string[]
}

const asStr = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

/**
 * Tolerant wire → model, matched to the SHIPPED Prometheus#342 shape (captured live 2026-08-29):
 *   { wired, servers: [{ name, source: 'config'|'store', enabled, command, args: [...],
 *     connectionTimeoutMs, health: { state, transport, detail },
 *     tools: [{ tool_name, description, read_only_hint, registered_as }], allowed_tools? }] }
 * `name` IS the identity (no separate id); `source: 'config'` rows come from prometheus.yaml and
 * are READ-ONLY over REST — the daemon never writes its own yaml. Garbage rows are dropped, never
 * guessed at; a non-array yields []. The pre-#342 stub shape (flat health string, tools[].name)
 * still parses so old fixtures stay honest.
 */
export function parseMcpServers(raw: unknown): McpServer[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { servers?: unknown[] }).servers) ? (raw as { servers: unknown[] }).servers : null
  if (!list) return []
  const out: McpServer[] = []
  for (const r of list) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const id = asStr(o.name) ?? asStr(o.id)
    if (!id) continue
    // Live shape: health is an object; transport lives inside it. Flat strings still accepted.
    const h = o.health
    const healthState = h && typeof h === 'object' ? asStr((h as Record<string, unknown>).state) : asStr(h)
    const healthDetail =
      (h && typeof h === 'object' ? asStr((h as Record<string, unknown>).detail) : undefined) ??
      asStr(o.health_detail ?? o.healthDetail)
    const health: McpHealth =
      healthState === 'connected' || healthState === 'disabled'
        ? healthState
        : healthState === undefined
          ? 'unknown'
          : 'failed' // not_running / error / anything the daemon considers not-healthy
    const wireTransport =
      (h && typeof h === 'object' ? asStr((h as Record<string, unknown>).transport) : undefined) ?? asStr(o.transport)
    const transport: McpTransport = wireTransport === 'http' || wireTransport === 'sse' ? wireTransport : 'stdio'
    const args = Array.isArray(o.args) ? o.args.filter((a): a is string => typeof a === 'string') : []
    const command = asStr(o.command) ? [asStr(o.command), ...args].join(' ') : undefined
    const tools: McpToolInfo[] = Array.isArray(o.tools)
      ? o.tools
          .map((t): McpToolInfo | null => {
            if (typeof t === 'string') return { name: t }
            if (t && typeof t === 'object') {
              const to = t as Record<string, unknown>
              const name = asStr(to.tool_name) ?? asStr(to.name)
              if (name) {
                const info: McpToolInfo = { name, description: asStr(to.description) }
                if (typeof to.read_only_hint === 'boolean') info.readOnlyHint = to.read_only_hint
                return info
              }
            }
            return null
          })
          .filter((t): t is McpToolInfo => t !== null)
      : []
    const rawAllowed = (o.allowed_tools ?? o.allowedTools) as unknown
    const allowedTools = Array.isArray(rawAllowed) ? rawAllowed.filter((x): x is string => typeof x === 'string') : null
    out.push({
      id,
      name: id,
      transport,
      command,
      url: asStr(o.url),
      enabled: o.enabled !== false,
      readOnly: o.source === 'config',
      health: o.enabled === false && healthState === undefined ? 'disabled' : health,
      healthDetail: healthDetail || (healthState && health === 'failed' ? healthState : undefined),
      tools,
      allowedTools,
      headerNames: Array.isArray(o.header_names) ? o.header_names.filter((x): x is string => typeof x === 'string') : []
    })
  }
  return out
}

/** null allowlist = everything allowed; an array is authoritative (even empty). */
export function toolAllowed(allowedTools: string[] | null, toolName: string): boolean {
  return allowedTools === null || allowedTools.includes(toolName)
}

/**
 * The next allowlist after toggling one tool — THE load-bearing semantics of this file:
 * turning one tool OFF while the list is null (= all) must MATERIALIZE the full inventory minus
 * that tool, or the daemon would read the write as "allow only nothing-in-particular". Turning
 * the last excluded tool back ON collapses to null again, so "everything allowed" round-trips to
 * the absent-field default instead of pinning today's inventory forever.
 */
export function toggleTool(allowedTools: string[] | null, inventory: McpToolInfo[], toolName: string): string[] | null {
  const all = inventory.map((t) => t.name)
  const current = allowedTools === null ? all : allowedTools
  const next = current.includes(toolName) ? current.filter((n) => n !== toolName) : [...current, toolName]
  const coversAll = all.length > 0 && all.every((n) => next.includes(n))
  return coversAll ? null : next
}

/** One sentence per health state — the card never shows a bare enum value. */
export function healthLabel(s: McpServer): string {
  switch (s.health) {
    case 'connected':
      return `connected · ${s.tools.length} tool${s.tools.length === 1 ? '' : 's'}`
    case 'failed':
      return `unreachable${s.healthDetail ? ` — ${s.healthDetail}` : ''}`
    case 'disabled':
      return 'disabled'
    case 'unknown':
      return 'health unknown'
  }
}

// ── A server at an address (http / sse), and its sign-in token ──────────────────────────────────
//
// WHERE THE TOKEN GOES. The person types it into the form; it is sent once, in the body of the
// POST that defines the server, to Prometheus, which keeps it in its own store and sends it as a
// header to that server. Beacon does not write it to its settings, its cache or a log, clears it
// from the form when the POST answers, and can never show it again: the daemon's listing returns
// header NAMES only. `scrubSecret` exists because the one place a secret could still surface is a
// refusal that quotes what it was sent.


/** How the daemon talks to a server at an address. 'streamable-http' is what current servers
 *  speak; 'sse' is the older transport, and what the daemon assumes when none is named. */
export type UrlTransport = 'streamable-http' | 'sse'

export interface UrlServerForm {
  name: string
  url: string
  transport: UrlTransport
  /** The sign-in token, or '' for a server that needs none. */
  token: string
  /** The header that carries it. Authorization (as `Bearer <token>`) unless the server says otherwise. */
  headerName: string
}

export const DEFAULT_TOKEN_HEADER = 'Authorization'
const HEADER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/
const TOKEN_MAX = 4096
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/

/** Query names that carry a credential. An address is stored, listed and shown, so it is no place for one. */
const SECRET_QUERY_RE = /(^|[_-])(key|apikey|api_key|token|secret|sig|signature|auth|password|passwd|pwd)$/i
/** Visible ASCII and spaces: what an HTTP header value can carry everywhere. */
const TOKEN_CHARS_RE = /^[\x20-\x7e]+$/
/** Schemes a person may paste with the token. Anything else in Authorization is sent as Bearer. */
const SCHEME_RE = /^(Bearer|Basic|Token|ApiKey|Digest)\s+(\S.*)$/i

/** Why this form can't be sent, in words for the form, or '' when it can. */
export function urlServerProblem(f: UrlServerForm): string {
  if (!f.name.trim()) return 'Give the server a name.'
  const raw = f.url.trim()
  if (!raw) return 'Enter the server address.'
  if (/\s/.test(raw) || CONTROL_RE.test(raw)) return 'The address has a space in it.'
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return 'That is not an address. It should start with https://'
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'The address must start with https://'
  if (!u.hostname) return 'The address has no server name in it.'
  // A secret in the address is stored, listed and shown with it. The token field is the place.
  if (u.username || u.password) return 'Take the name and password out of the address, and put the token in the token field.'
  for (const k of u.searchParams.keys()) {
    if (SECRET_QUERY_RE.test(k)) return `Take "${k}=…" out of the address and put its value in the token field: an address is kept and shown as it is.`
  }
  // Plain http carries the token in the clear. Only to a private address, as PROMETHEUS sees it
  // (it is Prometheus that connects): its own computer, its home network, a tailnet.
  if (u.protocol === 'http:' && !isPrivateHost(u.hostname.replace(/^\[|\]$/g, ''))) return 'Use https:// for a server on the internet. An http:// address would send the token unprotected.'
  const token = f.token
  if (token) {
    if (!token.trim()) return 'The token is only spaces. Paste it again, or leave the field empty.'
    if (CONTROL_RE.test(token)) return 'The token has a line break or a hidden character in it. Paste it again.'
    if (!TOKEN_CHARS_RE.test(token)) return 'The token has a character that cannot be sent. Paste it again.'
    if (token.length > TOKEN_MAX) return 'That token is too long to be a token.'
    if (/^(Bearer|Basic|Token|ApiKey|Digest)$/i.test(token.trim())) return 'That is only the word in front of a token. Paste the token itself.'
    if (!HEADER_NAME_RE.test(f.headerName.trim())) return 'The header name can only have letters, digits and hyphens.'
  }
  return ''
}

/** The header value for a token: `Bearer <token>` in Authorization (left alone when the person
 *  pasted a known scheme with it), the token as it is in any other header. */
export function tokenHeaderValue(headerName: string, token: string): string {
  const t = token.trim()
  if (headerName.trim().toLowerCase() !== 'authorization') return t
  return SCHEME_RE.test(t) ? t : `Bearer ${t}`
}

/** The POST body for a server at an address. `headers` is present only when there is a token. */
export function urlServerBody(f: UrlServerForm): Record<string, unknown> {
  const body: Record<string, unknown> = { name: f.name.trim(), url: f.url.trim(), transport: f.transport }
  const header = f.headerName.trim() || DEFAULT_TOKEN_HEADER
  if (f.token.trim()) body.headers = { [header]: tokenHeaderValue(header, f.token) }
  return body
}

/** `text` with every appearance of each secret blanked. Too-short "secrets" (under 4 characters)
 *  are not used: they would blank ordinary words. */
export function scrubSecret(text: string, ...secrets: string[]): string {
  let out = text
  for (const s of secrets) {
    const t = s.trim()
    if (t.length >= 4) out = out.split(t).join('•••')
  }
  return out
}

const b64 = (s: string): string => {
  try {
    return btoa(s)
  } catch {
    return ''
  }
}

/**
 * A failed write's message with any secret the REQUEST carried blanked: every value under the
 * body's `headers` or `env`, and the token inside a `Scheme token` value. Used in main, where a
 * refusal first exists as text (Electron prints a rejected IPC handler's error, so a daemon that
 * quoted a header back would otherwise put the token in Beacon's own output), and again in the form.
 *
 * WHAT IT COVERS, exactly: the value as sent, JSON-escaped, URL-encoded and base64; and a value
 * cut short at the END of the message (the REST layer keeps 200 characters of a refusal, so an
 * echo can be cut mid-token). Only the daemon's words are touched: the `HTTP nnn: METHOD path —`
 * that Beacon itself wrote in front of them is left alone. It is a second line of defence, not the
 * first: Prometheus's own refusals name a header and never quote its value.
 */
export function scrubWriteError(message: string, body: unknown): string {
  if (!body || typeof body !== 'object') return message
  const values: string[] = []
  for (const key of ['headers', 'env']) {
    const map = (body as Record<string, unknown>)[key]
    if (!map || typeof map !== 'object') continue
    for (const v of Object.values(map as Record<string, unknown>)) {
      if (typeof v !== 'string') continue
      values.push(v.trim())
      const rest = SCHEME_RE.exec(v.trim())?.[2]
      if (rest) values.push(rest)
    }
  }
  const secrets = values.filter((v) => v.length >= 4)
  if (secrets.length === 0) return message
  const cut = message.indexOf(' — ')
  const head = cut >= 0 ? message.slice(0, cut + 3) : ''
  let said = cut >= 0 ? message.slice(cut + 3) : message
  const forms = new Set<string>()
  for (const v of secrets) for (const f of [v, JSON.stringify(v).slice(1, -1), encodeURIComponent(v), b64(v)]) if (f.length >= 4) forms.add(f)
  // Longest first, so `Bearer tok` goes as one piece before `tok` is looked for.
  const ordered = [...forms].sort((a, z) => z.length - a.length)
  said = scrubSecret(said, ...ordered)
  // A form cut off by the end of the message: blank the longest prefix of it that the message ends with.
  for (const f of ordered) {
    for (let n = f.length - 1; n >= 4; n--) {
      if (said.endsWith(f.slice(0, n))) {
        said = `${said.slice(0, said.length - n)}•••`
        break
      }
    }
  }
  return head + said
}

// ── Who may change the list ─────────────────────────────────────────────────────────────────────
// Prometheus lets only its MAIN KEY (the global token) add, change or remove a tool server: a
// stdio server is a program started on that computer, and the daemon does not hand that to a
// device key, an owner's included. Beacon holds the main key when it was connected with it in
// Settings → Connection → Advanced; a Beacon that joined by approval or a code holds a device key.

/** Whether this Beacon signs in with the main key, from GET /api/devices' answer: the main key is
 *  no device, so no row is its own. null when the answer cannot say (it is not a list). */
export function holdsMainKey(devices: unknown): boolean | null {
  if (!Array.isArray(devices)) return null
  return !devices.some((d) => !!d && typeof d === 'object' && (d as Record<string, unknown>).is_self === true)
}

/**
 * What the tab may offer, from what is known about the key:
 *   'asking'  the answer has not come: NO write control is offered. A click in that moment would be
 *             a write Prometheus refuses, from a Beacon that was about to be told so.
 *   'main'    the main key: everything.
 *   'device'  a device key: the note, and no write control.
 *   'unknown' the question could not be answered (the read failed, or was not a list): the form is
 *             offered, and a refusal is put in the same plain words.
 */
export type KeyKnowledge = 'asking' | 'main' | 'device' | 'unknown'
export function keyKnowledge(answer: { state: 'pending' } | { state: 'failed' } | { state: 'answered'; devices: unknown }): KeyKnowledge {
  if (answer.state === 'pending') return 'asking'
  if (answer.state === 'failed') return 'unknown'
  const main = holdsMainKey(answer.devices)
  return main === null ? 'unknown' : main ? 'main' : 'device'
}
export const offersWrites = (k: KeyKnowledge): boolean => k === 'main' || k === 'unknown'

export const MAIN_KEY_NOTE = {
  title: 'Adding or changing tool servers needs the main key',
  body: "This Beacon signs in to Prometheus with a device key. Prometheus only lets its main key add, change or remove tool servers, because a server can be a program that runs on that computer. You can still see which servers are connected and what tools they offer.",
  how: 'To manage them from here, connect this Beacon with the main key (the key Prometheus was set up with on its own computer) in Settings → Connection → Advanced. Or add the server on that computer, in prometheus.yaml.'
} as const

/** A failed write is one of these, and the form does something different for each. */
export type WriteFailureKind = 'main-key' | 'key-refused' | 'no-answer' | 'refused'

/**
 * A failed write, in words, with what kind of failure it was. `body` is what was sent, so anything
 * secret in it can be blanked from the daemon's reply.
 *   main-key     Prometheus said this needs its main key (its own 401 for these routes).
 *   key-refused  any other 401: this Beacon's key was not accepted at all.
 *   no-answer    Beacon stopped waiting or could not reach Prometheus. The write MAY have landed:
 *                Prometheus connects to a new server before it answers, which can take longer than
 *                Beacon waits. The caller reloads the list instead of telling anyone to try again.
 *   refused      Prometheus answered and said no; its reason follows.
 */
export function writeFailure(message: string, body?: unknown): { kind: WriteFailureKind; words: string } {
  // Electron wraps a rejected handler's error; the words start after its prefix.
  const m = scrubWriteError((message ?? '').replace(/^Error invoking remote method '[^']*': (?:Error: )?/, ''), body)
  const status = /^HTTP (\d{3})\b/.exec(m)?.[1]
  if (status === '401') {
    if (/global token/i.test(m)) return { kind: 'main-key', words: `${MAIN_KEY_NOTE.title}. ${MAIN_KEY_NOTE.how}` }
    return { kind: 'key-refused', words: "Prometheus did not accept this Beacon's key. Check the connection in Settings → Connection, then try again." }
  }
  if (!status && /fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|timeout|timed out|aborted|network/i.test(m)) {
    return { kind: 'no-answer', words: 'Prometheus did not answer in time. It may still be connecting to the server: check the list here before trying again.' }
  }
  const said = / — ([\s\S]*)$/.exec(m)?.[1] ?? m
  let detail = said
  try {
    const j = JSON.parse(said) as { error?: unknown }
    if (typeof j.error === 'string') detail = j.error
  } catch {
    /* not JSON (or cut short): use it as it is */
  }
  return { kind: 'refused', words: `Prometheus did not accept that: ${detail.slice(0, 240)}` }
}

/** Validate an add-form submission before any write. Returns '' when fine, else the problem. */
export function addServerProblem(req: { name: string; transport: McpTransport; command?: string; url?: string }): string {
  if (!req.name.trim()) return 'a name is required'
  if (req.transport === 'stdio') {
    if (!req.command?.trim()) return 'a stdio server needs a command'
    return ''
  }
  const url = req.url?.trim() ?? ''
  if (!url) return `an ${req.transport} server needs a URL`
  if (!/^https?:\/\//.test(url)) return 'the URL must start with http:// or https://'
  return ''
}

// ── Captured wire fixture ────────────────────────────────────────────────────
// The SHAPE captured from the live GET /api/mcp/servers on the deployed daemon (2026-08-29,
// running_sha b107c29), trimmed: context7 is verbatim-but-shortened; the store/failed rows are
// synthetic in the same shape so the smoke covers every card state. This replaced the pre-#342
// dev stub the tab was built against.
export function capturedMcpServers(): unknown {
  return {
    wired: true,
    servers: [
      {
        name: 'context7',
        source: 'config',
        enabled: true,
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp'],
        connectionTimeoutMs: 60000,
        health: { state: 'connected', transport: 'stdio', detail: '' },
        tools: [
          { tool_name: 'resolve-library-id', description: 'Resolves a package name to a library ID.', read_only_hint: true, registered_as: 'mcp__context7__resolve-library-id' },
          { tool_name: 'query-docs', description: 'Query documentation.', read_only_hint: true, registered_as: 'mcp__context7__query-docs' }
        ]
      },
      {
        name: 'sqlite',
        source: 'store',
        enabled: true,
        command: 'uvx',
        args: ['mcp-server-sqlite', '--db', '/path/to/vault/notes.db'],
        health: { state: 'connected', transport: 'stdio', detail: '' },
        tools: [
          { tool_name: 'query', description: 'Run a read-only SQL query', read_only_hint: true },
          { tool_name: 'execute', description: 'Run a mutating SQL statement', read_only_hint: false }
        ],
        allowed_tools: ['query']
      },
      {
        name: 'dead-server',
        source: 'store',
        enabled: true,
        command: 'npx',
        args: ['-y', 'nonexistent-mcp'],
        health: { state: 'not_running', transport: 'stdio', detail: 'spawn failed: ENOENT' },
        tools: []
      }
    ]
  }
}
