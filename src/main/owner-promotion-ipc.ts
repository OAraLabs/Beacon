import { IPC } from '@shared/ipc'
import { OWNER_SETTINGS_COPY, type OwnerOutcome } from '@shared/owner-promotion'
import type { OwnerPromotion } from './owner-promotion'
import { handleFromShell } from './shell-windows'

// Settings → Make this Beacon an owner IPC (@shared/owner-promotion): the page sends the one-time code; the address, the request and
// the owner token are main's (src/main/owner-promotion.ts). The answer says owner or why not, never the token.
export function registerOwnerPromotionHandlers(promotion: OwnerPromotion): void {
  handleFromShell(IPC.OWNER_PROMOTE, async (_e, code: unknown): Promise<OwnerOutcome> =>
    typeof code === 'string' ? promotion.redeem(code) : { kind: 'refused', message: OWNER_SETTINGS_COPY.shape, detail: 'not a string' }
  )
}
