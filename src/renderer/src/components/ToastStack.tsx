import { useEffect } from 'react'
import { AUTO_DISMISS_MS, expired, type Toast } from '@shared/toasts'

// The toast stack (match spec, step 19): bottom-right, 16px inset, stacking upward, max three.
// What earns one is decided by the caller — see @shared/toasts for the rule that keeps this from
// becoming a stream of confirmations for things already on screen.

export function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  // One timer for the whole stack rather than one per toast: the sweep is cheap, and per-toast
  // timers have to be cancelled on every re-render or they fire against a stale list.
  useEffect(() => {
    if (toasts.length === 0) return
    const t = setInterval(() => {
      for (const id of expired(toasts, Date.now())) onDismiss(id)
    }, 1000)
    return () => clearInterval(t)
  }, [toasts, onDismiss])

  if (toasts.length === 0) return null
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast is-${t.kind}`}>
          <span className="toast-dot" aria-hidden />
          <span className="toast-msg">{t.message}</span>
          {/* Errors carry no auto-dismiss, so they carry the only way out instead. */}
          {t.kind === 'error' ? (
            <button className="toast-action" onClick={() => onDismiss(t.id)}>
              Dismiss
            </button>
          ) : t.actionLabel ? (
            <button className="toast-action" onClick={() => onDismiss(t.id)}>
              {t.actionLabel}
            </button>
          ) : null}
        </div>
      ))}
    </div>
  )
}

export { AUTO_DISMISS_MS }
