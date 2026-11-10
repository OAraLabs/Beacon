// Red first: not built yet.
import type { WaitingRequest } from './join-owner'
export const OWNER_COMMAND = ''
export function ownerSteps(_o: { thisMac: boolean; instance: string }): { command: string; where: string; steps: string[] } {
  return { command: '', where: '', steps: [] }
}
export function joinNotice(known: ReadonlySet<string>, _r: WaitingRequest[], _o: { focused: boolean; instance: string | null }): { notice: { title: string; body: string } | null; known: ReadonlySet<string> } {
  return { notice: null, known }
}
