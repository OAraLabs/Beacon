// MCP Connectors (PARITY-PLAN B1) — pure wire model, shared by the Config tab, the dev stub in
// main, and the headless smoke.
//
// THE WIRE SHAPE IS BEACON'S SIDE OF Prometheus#332. The daemon endpoint does not exist yet; this
// module states exactly what Beacon expects so the daemon session can match it (or we adapt here,
// in one file). Foundation Spec §2.3a context: the daemon's MCP client is the sanctioned tool
// surface, and per-server `allowed_tools` (Prometheus#331) is a named prerequisite — so the
// allowlist is a first-class control in this model, not an afterthought.

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
      allowedTools
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
