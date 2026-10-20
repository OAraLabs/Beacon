import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import type { PreviewTarget } from '@shared/preview'

// Hermes preview context (Phase 7). Any component can open the global right-hand preview pane via
// usePreview().open(target); MainView renders the pane and the views call open() on click. Default
// value is a no-op so components that use it outside a provider don't crash.

interface PreviewCtx {
  target: PreviewTarget | null
  open: (t: PreviewTarget) => void
  close: () => void
}

const Ctx = createContext<PreviewCtx>({ target: null, open: () => undefined, close: () => undefined })

export function usePreview(): PreviewCtx {
  return useContext(Ctx)
}

export function PreviewProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<PreviewTarget | null>(null)
  const value = useMemo<PreviewCtx>(() => ({ target, open: setTarget, close: () => setTarget(null) }), [target])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
