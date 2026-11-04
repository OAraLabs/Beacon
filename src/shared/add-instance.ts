// Red first: not built yet.
import type { PinnedIdentity } from './identity-challenge'
export type AddCheck =
  | { kind: 'ok'; name: string; proved: boolean; ai: string | null; fp: string | null; pin: PinnedIdentity | null }
  | { kind: 'kept'; id: string; label: string }
  | { kind: 'invalid'; message: string }
  | { kind: 'refused'; message: string }
  | { kind: 'unreachable' }
  | { kind: 'not-proved' }
  | { kind: 'key-refused' }
export function wsFor(_apiBase: string): string | null {
  return null
}
export function addCheckWords(_c: AddCheck): { tone: 'ok' | 'warn' | 'err'; text: string } {
  return { tone: 'err', text: '' }
}
