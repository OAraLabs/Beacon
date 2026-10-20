// Editing the addresses of a connection that carries a pin (Settings, ⌘,). docs/MULTI-COMPUTER-v0.4.md §3.3: a pinned profile
// never falls back to plain HTTP, and §3.4: there is no "continue anyway". Saving the form must be neither.
//
// No Node/Electron imports (same rule as the rest of src/shared).

export type PinnedEdit = { ok: true; pin: string | null } | { ok: false; error: string }

export const PINNED_NEEDS_TLS =
  'This computer was connected securely, so its addresses have to start with https:// and wss://. To connect to it another way, forget it and set up again.'

/** What saving these addresses does to the saved connection's pin. A pinned connection keeps its pin, at any address: the key is
 *  what identifies the computer, so a new address (another IP, after a router change) is held to the same key, and another
 *  computer there gets the card. Its addresses stay https:// and wss://. An unpinned connection is as before. */
export function pinnedEdit(currentPin: string | null | undefined, apiBase: string, wsUrl: string): PinnedEdit {
  if (!currentPin) return { ok: true, pin: null }
  const scheme = (u: string): string | null => {
    try {
      return new URL(u).protocol
    } catch {
      return null
    }
  }
  if (scheme(apiBase) !== 'https:' || scheme(wsUrl) !== 'wss:') return { ok: false, error: PINNED_NEEDS_TLS }
  return { ok: true, pin: currentPin }
}
