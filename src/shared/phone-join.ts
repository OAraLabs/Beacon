// Red first: not built yet.
export interface TailnetNode {
  name: string
  ips: string[]
}
export interface Tailnet {
  self: TailnetNode | null
  peers: TailnetNode[]
}
export function parseTailnet(_j: unknown): Tailnet | null {
  return null
}
export function shortTailnetName(_d: string): string | null {
  return null
}
export type JoinHost = { ok: true; host: string } | { ok: false; why: string }
export function joinHost(_a: string, _t: Tailnet | null): JoinHost {
  return { ok: false, why: '' }
}
export function joinUrl(_h: string, _n: string, _name: string): string {
  return ''
}
export type JoinCode = { ok: true; url: string; host: string } | { ok: false; why: string }
export function joinCode(_o: { apiBase: string; nodePub: string | null; name: string; tailnet: Tailnet | null; mode: string | null }): JoinCode {
  return { ok: false, why: '' }
}
