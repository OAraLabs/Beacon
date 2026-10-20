// IntegrationClient — RestClient's sibling for contract integrations.
// Same conventions, deliberately: global fetch, AbortSignal.timeout, bearer
// only when a token exists, and EVERY non-2xx throws with the load-bearing
// `HTTP <status>:` prefix so httpStatusFromError/isAuthError keep classifying
// across the IPC boundary (see rest.ts:57-59).

import { IntegrationEntry, IntegrationManifest, IntegrationStatus, ManifestProblem, classifyHealth, isAllowedIntegrationPath, parseManifest } from '../shared/integrations'

const TIMEOUT_MS = 8_000

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200)
  } catch {
    return '<unreadable body>'
  }
}

export class IntegrationClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string | null,
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.token) h.Authorization = `Bearer ${this.token}`
    return h
  }

  async get(relPath: string): Promise<unknown> {
    if (!isAllowedIntegrationPath(relPath)) throw new Error(`illegal integration path: ${relPath}`)
    const res = await fetch(`${this.baseUrl}${relPath}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: GET ${relPath} — ${await safeText(res)}`)
    return res.json()
  }

  async invoke(relPath: string, method: string, body?: unknown): Promise<unknown> {
    if (!isAllowedIntegrationPath(relPath)) throw new Error(`illegal integration path: ${relPath}`)
    const m = method === 'PUT' || method === 'DELETE' ? method : 'POST'
    const res = await fetch(`${this.baseUrl}${relPath}`, {
      method: m,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${m} ${relPath} — ${await safeText(res)}`)
    return res.json()
  }
}

/** Holds one client per enabled registry entry; rebuilt on registry save. */
export class IntegrationsManager {
  private clients = new Map<string, IntegrationClient>()
  private manifests = new Map<string, IntegrationManifest>()
  private problems = new Map<string, ManifestProblem>()

  constructor(private entries: IntegrationEntry[], tokenFor: (entry: IntegrationEntry) => string | null) {
    for (const e of entries) {
      if (e.enabled) this.clients.set(e.id, new IntegrationClient(e.baseUrl, tokenFor(e)))
    }
  }

  list(): IntegrationEntry[] {
    return this.entries
  }

  client(id: string): IntegrationClient | null {
    return this.clients.get(id) ?? null
  }

  manifest(id: string): IntegrationManifest | null {
    return this.manifests.get(id) ?? null
  }

  /** Probe every enabled entry CONCURRENTLY (one dead host must not hang the
   *  tab — testConnection precedent). Returns renderer-safe statuses. */
  async statuses(): Promise<IntegrationStatus[]> {
    return Promise.all(
      this.entries.map(async (entry): Promise<IntegrationStatus> => {
        if (!entry.enabled) return { entry, manifest: null, problem: null, health: { state: 'disabled' } }
        const client = this.clients.get(entry.id)!
        let manifest = this.manifests.get(entry.id) ?? null
        let problem: ManifestProblem | null = this.problems.get(entry.id) ?? null
        if (!manifest && !problem) {
          try {
            const parsed = parseManifest(await client.get('/integration/manifest'))
            manifest = parsed.manifest
            problem = parsed.problem
            if (manifest) this.manifests.set(entry.id, manifest)
            if (problem) this.problems.set(entry.id, problem)
          } catch (err) {
            return { entry, manifest: null, problem: null, health: { state: 'unreachable', detail: String(err).slice(0, 200) } }
          }
        }
        if (problem) {
          const health = problem.kind === 'version'
            ? ({ state: 'version-mismatch', got: problem.got, want: problem.want } as const)
            : ({ state: 'error', detail: problem.detail } as const)
          return { entry, manifest: null, problem, health }
        }
        try {
          const health = classifyHealth(await client.get(manifest!.health_endpoint))
          return { entry, manifest, problem: null, health }
        } catch (err) {
          return { entry, manifest, problem: null, health: { state: 'unreachable', detail: String(err).slice(0, 200) } }
        }
      }),
    )
  }
}
