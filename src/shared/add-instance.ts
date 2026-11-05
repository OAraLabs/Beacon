// Add a Prometheus (docs/MULTI-PROMETHEUS.md §6), the form the title bar's switcher opens: what an answer means and how it reads.
// src/main/add-instance.ts asks (who answers, with no key; then the typed key) and keeps the new one only after a good answer.
//
// No Node/Electron imports (same rule as the rest of src/shared).

import type { PinnedIdentity } from './identity-challenge'

export type AddCheck =
  /** A Prometheus Beacon doesn't keep, and the typed key works. `pin`: its node key, when it proved who it is. */
  | { kind: 'ok'; name: string; proved: boolean; ai: string | null; fp: string | null; pin: PinnedIdentity | null }
  /** Beacon already keeps it (the one it is on, or another): nothing to add. */
  | { kind: 'kept'; id: string; label: string }
  | { kind: 'invalid'; message: string }
  /** An address Beacon will not use at all (plain to the internet). */
  | { kind: 'refused'; message: string }
  | { kind: 'unreachable' }
  /** It answered the identity question with a signature that doesn't check out. */
  | { kind: 'not-proved' }
  | { kind: 'key-refused' }

export interface AddRequest {
  apiBase: string
  wsUrl: string
  token: string
}

/** What Add answers: kept (and now the one Beacon is on), or why not. */
export type AddOutcome = { added: true; name: string } | { added: false; check: AddCheck }

export function isAddRequest(v: unknown): v is AddRequest {
  const r = v as AddRequest | null
  return !!r && typeof r === 'object' && typeof r.apiBase === 'string' && typeof r.wsUrl === 'string' && typeof r.token === 'string' && r.apiBase.length < 512 && r.wsUrl.length < 512 && r.token.length < 4096
}

/** The socket address for an address on Prometheus's usual port (8005 → 8010), or null: then it is typed, never guessed. */
export function wsFor(apiBase: string): string | null {
  try {
    const u = new URL(apiBase.trim())
    if (u.protocol !== 'http:' || u.port !== '8005') return null
    return `ws://${u.hostname.includes(':') ? `[${u.hostname}]` : u.hostname}:8010`
  } catch {
    return null
  }
}

/** Why the form's addresses can't be asked about at all, or null. */
export function addRequestProblem(r: AddRequest): string | null {
  const parse = (s: string): URL | null => {
    try {
      return new URL(s.trim())
    } catch {
      return null
    }
  }
  const api = parse(r.apiBase)
  const ws = parse(r.wsUrl)
  if (!api || !/^https?:$/.test(api.protocol)) return 'Use an address like http://localhost:8005.'
  if (api.protocol === 'https:') return "An encrypted address can't be added here yet. Use its http:// address (port 8005)."
  if (!ws || ws.protocol !== 'ws:') return 'Use a socket address like ws://localhost:8010.'
  if (/\s/.test(r.token)) return "The key can't contain spaces."
  return null
}

export function addCheckWords(c: AddCheck): { tone: 'ok' | 'warn' | 'err'; text: string } {
  switch (c.kind) {
    case 'ok':
      return c.proved
        ? { tone: 'ok', text: `${c.name}: it proved who it is, and the key works.${c.ai ? ` It's on ${c.ai}.` : ''}` }
        : { tone: 'warn', text: `${c.name}: the key works, but it can't prove who it is (an older Prometheus).${c.ai ? ` It's on ${c.ai}.` : ''}` }
    case 'kept':
      return { tone: 'warn', text: `Beacon already keeps this Prometheus, as ${c.label}. Nothing to add.` }
    case 'invalid':
    case 'refused':
      return { tone: 'err', text: c.message }
    case 'unreachable':
      return { tone: 'err', text: "Nothing answered at that address. Check that Prometheus is running there (oara daemon), then test again." }
    case 'not-proved':
      return { tone: 'err', text: "It answered, but its signature didn't check out, so Beacon sent it nothing." }
    case 'key-refused':
      return { tone: 'err', text: 'It refused that key. Copy it again (oara token show on that computer), then test again.' }
  }
}
