// Red first: not built yet.
export interface ViewStep {
  at: number
  from: string | null
  to: string
  how: 'mount' | 'change'
  input: string | null
  inputAgoMs: number | null
}
export const VIEW_TRAIL_KEEP = 0
export function pushStep(t: ViewStep[], _s: ViewStep): ViewStep[] {
  return t
}
export function trailLine(_o: { at: number; opener: string; view: string; rendererUpMs: number; steps: ViewStep[] }): string {
  return ''
}
export function inputLabel(_i: { kind: 'key'; key: string; meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean } | { kind: 'click'; label: string }): string {
  return ''
}
export function keepTail(t: string, _max: number): string {
  return t
}
