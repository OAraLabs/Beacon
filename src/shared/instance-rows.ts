// Red first: the decisions are not built yet.
import type { InstanceSummary } from './ipc'

export type RowDot = 'green' | 'amber' | 'grey' | 'red'
export interface InstanceRowView {
  id: string
  name: string
  dot: RowDot
  words: string
  ai: string | null
  note: string | null
  current: boolean
}
export const ADD_PROMETHEUS = ''
export const UNPROVED_NOTE = ''
export function instanceRows(_list: InstanceSummary[], _clock?: (ms: number) => string): InstanceRowView[] | null {
  return []
}
export function activeName(_list: InstanceSummary[]): string | null {
  return ''
}
export function windowTitle(_list: InstanceSummary[]): string {
  return ''
}
export function composerPlaceholder(_list: InstanceSummary[]): string {
  return ''
}
export function unreachableLine(_list: InstanceSummary[], _host: string): string {
  return ''
}
