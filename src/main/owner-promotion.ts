// Settings → "Make this Beacon an owner", the main-process half (@shared/owner-promotion, Prometheus #748): POST /api/pair/owner at the
// connected Prometheus with the one-time code, and the owner token it answers kept in place of the API token (`keep`: the keychain
// entry every way of connecting writes, then the connection brought up again with it). The token never reaches the page.
//
// The route is public: no credential is sent with it (the API token goes nowhere it is not needed). A pinned (home-network, TLS)
// connection is pinned here too: the global fetch routes through the pins (src/main/tls-pin.ts), and a computer answering with
// another key is 'wrong-key' and is sent nothing.
import { OWNER_ROUTE, OWNER_SETTINGS_COPY as C, normaliseOwnerCode, readRedeem, type OwnerOutcome } from '@shared/owner-promotion'
import type { RequestFn } from './pairing/http'

export interface OwnerPromotionDeps {
  /** The connected Prometheus's REST base (null when not connected). */
  base: () => string | null
  request: RequestFn
  deviceName: () => Promise<string>
  platform: 'macos' | 'linux' | 'windows'
  /** Keep the owner token in place of the current credential and reconnect with it. Throws when it could not be kept, and then
   *  leaves the old credential as it was. */
  keep: (token: string) => void
}

export class OwnerPromotion {
  constructor(private readonly deps: OwnerPromotionDeps) {}

  async redeem(typed: string): Promise<OwnerOutcome> {
    const code = normaliseOwnerCode(typed)
    if (!code) return { kind: 'refused', message: C.shape, detail: 'not 8 digits' }
    const base = this.deps.base()
    if (!base) return { kind: 'refused', message: C.notConnected, detail: 'not connected' }
    const r = await this.deps.request({
      method: 'POST',
      url: `${base}${OWNER_ROUTE}`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, device_name: await this.deps.deviceName(), platform: this.deps.platform }),
      timeoutMs: 15_000
    })
    if (r === 'wrong-key') return { kind: 'refused', message: C.wrongComputer, detail: 'the computer presented another key than the pinned one' }
    if (typeof r === 'string') return { kind: 'refused', message: C.failed, detail: r }
    const read = readRedeem(r.status, r.json)
    if (read.kind === 'refused') return read
    try {
      this.deps.keep(read.token)
    } catch (e) {
      return { kind: 'refused', message: C.notKept, detail: e instanceof Error ? e.message : String(e) }
    }
    return { kind: 'owner', name: read.name }
  }
}
