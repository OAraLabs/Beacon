import { useEffect, useState } from 'react'

/**
 * Whether the connected Prometheus advertises that every approval request says `critical`
 * (ConnectionStatus.approvalCritical, set by main from each `subscribed` reply). Read from the
 * status this window is told about, and again on every change, so a window opened after the
 * reply arrived knows it too. Undefined until this Prometheus has said either way: the rule
 * (`answeredInApp`) treats that as doubt, and main settles it within seconds of connecting.
 */
export function useApprovalCriticalAdvertised(): boolean | undefined {
  const [advertised, setAdvertised] = useState<boolean | undefined>(undefined)
  useEffect(() => {
    const b = window.beacon
    if (!b) return
    let live = true
    const set = (s: { approvalCritical?: boolean } | null | undefined): void => {
      if (live) setAdvertised(typeof s?.approvalCritical === 'boolean' ? s.approvalCritical : undefined)
    }
    let told = false // a status event has arrived: the first read, if it lands later, is older news
    void b.connection.status().then((s) => (told ? undefined : set(s))).catch(() => undefined)
    const off = b.connection.onStatus((s) => {
      told = true
      set(s)
    })
    return () => {
      live = false
      off()
    }
  }, [])
  return advertised
}
