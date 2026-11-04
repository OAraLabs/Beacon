// Red first: not built yet.
import type { AddCheck } from '@shared/add-instance'
import type { PinnedIdentity } from '@shared/identity-challenge'
import type { RequestFn } from './pairing/http'
export interface AddRequest {
  apiBase: string
  wsUrl: string
  token: string
}
export interface AddDeps {
  request: RequestFn
  refusal: (apiBase: string, wsUrl: string) => Promise<string | null>
  verify: (message: string, signature: string, publicKey: string) => boolean
  nowS: () => number
  kept: () => Array<{ id: string; label: string; apiBase: string; fp: string | null; nodePub: string | null }>
  folderForAdd: (apiBase: string, fp: string | null) => string | null
  pinIdentity: (id: string, pin: PinnedIdentity) => void
  setKey: (id: string, token: string) => void
  saveInstance: (gw: { name: string; apiBase: string; wsUrl: string; pin: string | null }, id: string) => void
}
export async function checkNewInstance(_r: AddRequest, _d: AddDeps): Promise<AddCheck> {
  return { kind: 'unreachable' }
}
export async function addInstance(r: AddRequest, d: AddDeps): Promise<{ added: true; id: string; name: string; fp: string | null } | { added: false; check: AddCheck }> {
  return { added: false, check: await checkNewInstance(r, d) }
}
