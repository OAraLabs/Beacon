// A key Beacon holds for one Prometheus is only ever sent to that Prometheus (docs/MULTI-PROMETHEUS.md §2 rule 2): where it may go is
// decided by comparing ORIGINS (scheme, host, port), never by trusting a URL a response handed back.
//
// No Node/Electron imports (same rule as the rest of src/shared).

/** The origin of a URL ("http://127.0.0.1:8005"), or null when it is not one. */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null
  } catch {
    return null
  }
}

/** Whether `url` is on the same origin as `base`: the only place the key minted for `base` may go. */
export function sameOrigin(url: string, base: string): boolean {
  const a = originOf(url)
  return a !== null && a === originOf(base)
}
