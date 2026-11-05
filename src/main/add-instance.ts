// Add a Prometheus (docs/MULTI-PROMETHEUS.md §6), from the title bar's switcher: who answers at the address is asked with no key
// (hello, then the identity challenge with nothing pinned), Beacon refuses any Prometheus it already keeps (by node key, fp or
// address), and only then is the typed key tried, on /api/status alone. Add asks all of it again and keeps the new one only after a
// good answer, in a folder of its own (DaemonFolders.folderForAdd). Nothing here can read or write another Prometheus's key: the
// only key it holds is the one typed, and the only writes are to the new folder. Connecting to it is main's (index.ts).
import { addRequestProblem, type AddCheck, type AddRequest } from '@shared/add-instance'
import type { PinnedIdentity, Verdict } from '@shared/identity-challenge'
import { aiLabel } from '@shared/instance-watch'
import { askHello } from './discovery'
import { createProver } from './identity'
import type { RequestFn } from './pairing/http'

export type { AddRequest } from '@shared/add-instance'

export interface AddDeps {
  /** No key, no redirect (requestSmall). */
  request: RequestFn
  /** Words when Beacon won't use the address at all (plain to the internet), or null. */
  refusal: (apiBase: string, wsUrl: string) => Promise<string | null>
  verify: (message: string, signature: string, publicKey: string) => boolean
  nowS: () => number
  /** Every Prometheus Beacon keeps, the one it is on included. */
  kept: () => Array<{ id: string; label: string; apiBase: string; fp: string | null; nodePub: string | null }>
  folderForAdd: (apiBase: string, fp: string | null) => string | null
  pinIdentity: (id: string, pin: PinnedIdentity) => void
  setKey: (id: string, token: string) => void
  saveInstance: (gw: { name: string; apiBase: string; wsUrl: string; pin: string | null }, id: string) => void
  /** hello at a REST base (no key); the default asks over plain http. */
  hello?: (apiBase: string) => Promise<{ fp: string | null; name: string | null } | null>
}

const origin = (s: string): string => {
  try {
    const u = new URL(s.trim())
    return `${u.protocol}//${u.host}`
  } catch {
    return s.trim()
  }
}

async function helloAt(apiBase: string): Promise<{ fp: string | null; name: string | null } | null> {
  try {
    const u = new URL(apiBase)
    const h = await askHello({ host: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port || 80) })
    return typeof h === 'string' ? null : { fp: typeof h.fp === 'string' ? h.fp : null, name: typeof h.name === 'string' && h.name.trim() ? h.name.trim() : null }
  } catch {
    return null
  }
}

/** What answers at the address, and whether the typed key works there. Writes nothing. */
export async function checkNewInstance(req: AddRequest, deps: AddDeps): Promise<AddCheck> {
  const problem = addRequestProblem(req)
  if (problem) return { kind: 'invalid', message: problem }
  const apiBase = origin(req.apiBase)
  const wsUrl = req.wsUrl.trim()
  const refused = await deps.refusal(apiBase, wsUrl)
  if (refused) return { kind: 'refused', message: refused }

  const hello = await (deps.hello ?? helloAt)(apiBase)
  const seen: { verdict: Verdict | null } = { verdict: null }
  await createProver({
    apiBase,
    request: deps.request,
    pinned: () => null,
    tlsSpki: null,
    verify: deps.verify,
    nowS: deps.nowS,
    onVerdict: (v) => {
      seen.verdict = v
      return undefined
    }
  })({ waiting: () => undefined, stopped: () => true })
  const v = seen.verdict
  if (!hello && (v === null || v.kind === 'unreachable')) return { kind: 'unreachable' }
  if (v?.kind === 'refused') return { kind: 'not-proved' }
  const pin = v?.kind === 'first' ? { instanceId: v.instanceId, nodePub: v.nodePub } : null

  // One Beacon already keeps, by what proves it, then by what names it, then by where it is.
  const kept = deps.kept()
  const same =
    (pin ? kept.find((k) => k.nodePub === pin.nodePub) : undefined) ??
    (hello?.fp ? kept.find((k) => k.fp === hello.fp) : undefined) ??
    kept.find((k) => origin(k.apiBase) === apiBase)
  if (same) return { kind: 'kept', id: same.id, label: same.label }

  const token = req.token.trim()
  const r = await deps.request({ method: 'GET', url: `${apiBase}/api/status`, headers: token ? { authorization: `Bearer ${token}` } : {}, timeoutMs: 5_000 })
  if (r === 'unreachable' || r === 'too-big' || r === 'wrong-key') return { kind: 'unreachable' }
  if (r.status === 401) return { kind: 'key-refused' }
  if (r.status !== 200 && r.status !== 403) return { kind: 'unreachable' }
  const body = (r.status === 200 ? r.json : null) as { provider?: unknown; model?: unknown } | null
  const host = (() => {
    try {
      return new URL(apiBase).host
    } catch {
      return apiBase
    }
  })()
  return { kind: 'ok', name: hello?.name ?? host, proved: pin !== null, ai: body ? aiLabel(body.provider, body.model) : null, fp: hello?.fp ?? null, pin }
}

/** Ask again, then keep it: a folder of its own, its pin, the typed key, its record (active). Never touches another Prometheus. */
export async function addInstance(req: AddRequest, deps: AddDeps): Promise<{ added: true; id: string; name: string; fp: string | null } | { added: false; check: AddCheck }> {
  const check = await checkNewInstance(req, deps)
  if (check.kind !== 'ok') return { added: false, check }
  const apiBase = origin(req.apiBase)
  const id = deps.folderForAdd(apiBase, check.fp)
  if (!id) return { added: false, check: { kind: 'kept', id: '', label: apiBase } }
  if (check.pin) deps.pinIdentity(id, check.pin)
  deps.setKey(id, req.token.trim())
  deps.saveInstance({ name: check.name, apiBase, wsUrl: req.wsUrl.trim(), pin: null }, id)
  return { added: true, id, name: check.name, fp: check.fp }
}
