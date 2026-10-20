import { useCallback, useEffect, useState } from 'react'
import type { SetupResume, SetupStatus } from '@shared/ipc'
import { onboardingEntry, parseBrowsing, parseKnown, ONBOARDING_BROWSING_KEY, ONBOARDING_KNOWN_KEY, ONBOARDING_LAN_ASKED_KEY, type OnboardingContext, type OnboardingEntry } from '@shared/onboarding'
import { SetupWizard } from './components/SetupWizard'
import { ApprovePrompt } from './components/ApprovePrompt'
import { Onboarding } from './components/onboarding/Onboarding'
import { MainView } from './components/MainView'
import { AppChrome } from './components/AppChrome'
import { ConnectionSettings } from './components/ConnectionSettings'
import { UnreachableBanner } from './components/UnreachableBanner'
import { loadAndApplyTheme } from './theme/apply-theme'

type Mode = 'loading' | 'setup' | 'app'

export default function App() {
  const [mode, setMode] = useState<Mode>('loading')
  const [currentAddress, setCurrentAddress] = useState<string | undefined>()
  const [resume, setResume] = useState<SetupResume | undefined>()
  // The v0.4.0 first run: which screen it opens on, or 'legacy' for the existing wizard (the gate is
  // closed, a setup is part-way, or a dev build chose "Use the old setup").
  const [entry, setEntry] = useState<OnboardingEntry>('legacy')
  const [forceLegacy, setForceLegacy] = useState(false)
  const [onboardingCtx, setOnboardingCtx] = useState<OnboardingContext>({ explainLan: false, known: {} })
  const [helloTimeoutMs, setHelloTimeoutMs] = useState(120_000)
  // Bumped when setup starts over, so the wizard remounts with fresh state instead of the old step.
  const [wizardGen, setWizardGen] = useState(0)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // The section Settings opens at ("Make this Beacon an owner", from an owner-only note), or the top.
  const [settingsAt, setSettingsAt] = useState<string | null>(null)
  const [connGen, setConnGen] = useState(0)

  const checkSetup = useCallback(async (keepAddress?: string) => {
    const b = window.beacon
    if (!b) {
      setMode('app')
      return
    }
    const s: SetupStatus = await b.setup.status().catch(() => ({ needsSetup: false }))
    setCurrentAddress(s.currentAddress ?? keepAddress)
    setResume(s.resume)
    const browsing = s.needsSetup && s.onboarding === true ? parseBrowsing(await b.settings.get(ONBOARDING_BROWSING_KEY).catch(() => null)) : false
    setEntry(onboardingEntry({ visible: s.onboarding === true, resume: s.resume !== undefined, browsing, resumeHere: s.resume?.here === true && s.resume.paired, resumeTrade: s.resume?.trade === true }))
    if (s.helloTimeoutMs) setHelloTimeoutMs(s.helloTimeoutMs)
    if (s.needsSetup && s.onboarding === true) {
      const [asked, known] = await Promise.all([b.settings.get(ONBOARDING_LAN_ASKED_KEY).catch(() => null), b.settings.get(ONBOARDING_KNOWN_KEY).catch(() => null)])
      setOnboardingCtx({ explainLan: s.localNetworkPrompt === true && asked !== '1', known: parseKnown(known) })
    }
    setMode(s.needsSetup ? 'setup' : 'app')
  }, [])

  // Start over (from a resumed setup) and Set up again (Settings): forget the saved connection,
  // then show setup from Welcome with the old address still typed in, for convenience.
  const startOver = useCallback(async () => {
    const keep = currentAddress
    await window.beacon?.setup.forget().catch(() => undefined)
    setForceLegacy(false)
    setSettingsOpen(false)
    await checkSetup(keep)
    // After the status has landed: a remount before it would initialise from the stale `resume`.
    setWizardGen((g) => g + 1)
  }, [currentAddress, checkSetup])

  useEffect(() => {
    void checkSetup()
  }, [checkSetup])

  // Codex re-skin: apply the persisted theme (LVX/NOX) on mount — flips the tokens on <html>.
  useEffect(() => {
    void loadAndApplyTheme()
  }, [])

  // Open Connection Settings from the app menu (⌘,) OR a panel's "Open Settings" button (a 401 state).
  // A successful save fires beacon:connection-changed → bump the key so MainView remounts and every
  // panel refetches against the rebuilt connection (no stale Not-authorized after fixing the token).
  useEffect(() => {
    const onOpen = (e: Event): void => {
      const section = (e as CustomEvent<{ section?: unknown } | null>).detail?.section
      setSettingsAt(typeof section === 'string' ? section : null)
      setSettingsOpen(true)
    }
    const onChanged = (): void => setConnGen((g) => g + 1)
    window.addEventListener('beacon:open-settings', onOpen)
    window.addEventListener('beacon:connection-changed', onChanged)
    const off = window.beacon?.connection.onOpenSettings(() => {
      setSettingsAt(null)
      setSettingsOpen(true)
    })
    return () => {
      window.removeEventListener('beacon:open-settings', onOpen)
      window.removeEventListener('beacon:connection-changed', onChanged)
      off?.()
    }
  }, [])

  if (mode === 'loading') return <div className="loading">Loading…</div>
  // Phase 2: the stepped wizard is the first-run path; the old quick form stays reachable inside it
  // as "Quick connect (advanced)".
  // "Use the old setup" asks main again first: a connection the new flow has just made (Prometheus set up on this Mac, still in setup
  // mode) is then a part-way setup, and the old wizard picks it up there instead of starting from its Welcome.
  if (mode === 'setup' && entry !== 'legacy' && !forceLegacy)
    return <Onboarding key={wizardGen} entry={entry} ctx={onboardingCtx} helloTimeoutMs={helloTimeoutMs} onLegacy={() => void checkSetup().then(() => setForceLegacy(true))} onFinished={() => void checkSetup()} />
  if (mode === 'setup')
    return (
      <SetupWizard
        key={wizardGen}
        currentAddress={currentAddress}
        resume={resume}
        onConnected={() => void checkSetup()}
        onStartOver={() => void startOver()}
      />
    )
  return (
    <>
      <AppChrome />
      <MainView key={connGen} />
      <UnreachableBanner
        onChangeConnection={() => {
          setSettingsAt('connection') // the address and key, open: that is what changing the connection means
          setSettingsOpen(true)
        }}
        onConnectAgain={() => void startOver()}
      />
      <ApprovePrompt />
      {settingsOpen ? (
        <ConnectionSettings
          at={settingsAt}
          onClose={() => {
            setSettingsOpen(false)
            void checkSetup()
          }}
          onSetUpAgain={() => void startOver()}
        />
      ) : null}
    </>
  )
}
