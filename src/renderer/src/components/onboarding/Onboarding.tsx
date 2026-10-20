import { useEffect, useRef, useState } from 'react'
import {
  CONNECTS_FROM,
  ONBOARDING_BROWSING_KEY,
  ONBOARDING_LAN_ASKED_KEY,
  PENDING_SCREENS,
  canGoBack,
  effectiveWhere,
  initialOnboardingState,
  onboardingReduce,
  recommendedWhere,
  whereChoices,
  searchModeFor,
  selectedComputer,
  type OnboardingContext,
  type OnboardingEntry,
  type OnboardingEvent,
  type OnboardingState
} from '@shared/onboarding'
import { COPY } from '@shared/onboarding-strings'
import { SETUP_LINKS } from '@shared/setup-links'
import { AppChrome } from '../AppChrome'
import { CheckingMac } from './CheckingMac'
import { ChooseComputer } from './ChooseComputer'
import { ConfirmSetup } from './ConfirmSetup'
import { ConnectCloud } from './ConnectCloud'
import { Finishing } from './Finishing'
import { PasteKey } from './PasteKey'
import { SignInOpenRouter } from './SignInOpenRouter'
import { ThinkHow } from './ThinkHow'
import { ChooseWhere } from './ChooseWhere'
import { ByAddress } from './ByAddress'
import { Approval } from './Approval'
import { Connected } from './Connected'
import { Differs } from './Differs'
import { Hello } from './Hello'
import { Installing } from './Installing'
import { LanExplain } from './LanExplain'
import { Looking } from './Looking'
import { NoJoin } from './NoJoin'
import { NothingFound } from './NothingFound'
import { Pending } from './Pending'
import { Tour } from './Tour'
import { Unconnected } from './Unconnected'
import { Welcome } from './Welcome'

interface Props {
  entry: Exclude<OnboardingEntry, 'legacy'>
  /** What the start-up read: whether macOS's Local Network step is still to be explained, and which
   *  computers this Mac knows. */
  ctx: OnboardingContext
  /** Hand over to the existing wizard (a dev build's way out of a screen that is not built yet). */
  onLegacy: () => void
  /** Onboarding is finished (the first reply arrived and "Start chatting" was chosen): on to the app. */
  onFinished: () => void
  /** How long the first message waits for an answer before saying so. */
  helloTimeoutMs: number
}

// The v0.4.0 first run (docs/ONBOARDING-v0.4.0.md). Every transition is @shared/onboarding's; this
// component draws the current screen, listens for Esc, remembers "Not now" and that B1 was shown, and runs
// the search path B needs. A search is a quiet one (this Mac only) while Welcome and the question show,
// and a full one on B2 and B3; it is never running while B1 is still explaining why Beacon wants to look.
export function Onboarding({ entry, ctx, onLegacy, onFinished, helloTimeoutMs }: Props): React.JSX.Element {
  const [state, setState] = useState<OnboardingState>(() => initialOnboardingState(entry, ctx))
  const heading = useRef<HTMLDivElement>(null)
  // A3c-1 opens with Other options showing when a card on the sign-in offered them.
  const [othersOpen, setOthersOpen] = useState(false)

  const send = (e: OnboardingEvent): void => {
    const next = onboardingReduce(state, e)
    if (next === state) return
    // "Not now" is remembered on the way into the empty home and forgotten on the way out, so a
    // relaunch opens where this person left off (a Welcome screen for someone just looking would be a nag).
    if (next.screen === 'UNCONNECTED' && state.screen !== 'UNCONNECTED') void window.beacon?.settings.set(ONBOARDING_BROWSING_KEY, '1').catch(() => undefined)
    if (state.screen === 'UNCONNECTED' && next.screen !== 'UNCONNECTED') void window.beacon?.settings.set(ONBOARDING_BROWSING_KEY, '0').catch(() => undefined)
    // Continue on B1 is what asks macOS for permission (the search starts); it is explained once.
    if (state.screen === 'B1' && next.screen === 'B2') void window.beacon?.settings.set(ONBOARDING_LAN_ASKED_KEY, '1').catch(() => undefined)
    setState(next)
  }

  // Esc = Back, wherever Back exists. Setting it up on this Mac answers Esc itself: Back there may first ask "Stop setting up?".
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && canGoBack(state) && state.screen !== 'A-inst') setState((s) => onboardingReduce(s, { type: 'back' }))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state])

  // A new screen takes keyboard focus at its top, so a keyboard or screen-reader user starts reading
  // the new screen instead of stranded on a control that has just disappeared.
  useEffect(() => {
    const h1 = heading.current?.querySelector<HTMLElement>('h1')
    if (!h1) return
    h1.tabIndex = -1 // focusable by script, not a tab stop
    h1.focus({ preventScroll: true })
  }, [state.screen])

  // The search the current screen wants. Starting one stops the last (main enforces one at a time), and an
  // update from an older search is dropped by its session number.
  const mode = searchModeFor(state)
  useEffect(() => {
    const d = window.beacon?.discovery
    if (!d || mode === null) return
    let latest = 0
    const off = d.onUpdate((u) => {
      if (u.session < latest) return
      latest = u.session
      setState((s) => onboardingReduce(s, mode === 'quiet' ? { type: 'quiet', computers: u.computers } : { type: 'results', computers: u.computers, lan: u.lan, done: u.done }))
    })
    void d
      .start({ quiet: mode === 'quiet' })
      .then((r) => {
        if (r) latest = Math.max(latest, r.session)
      })
      .catch(() => undefined)
    return () => {
      off()
      void d.stop().catch(() => undefined)
    }
  }, [mode, state.searchGen])

  const back = (): void => send({ type: 'back' })
  const s = state.screen
  const where = effectiveWhere(state)
  const renderScreen = (): React.JSX.Element => {
    if (PENDING_SCREENS.includes(s)) return <Pending screen={s} onBack={back} onUseOld={onLegacy} onConnected={() => send({ type: 'connected' })} />
    switch (s) {
      case 'W1':
        return <Welcome onStart={() => send({ type: 'start' })} />
      case 'W2':
        return (
          <ChooseWhere
            choices={whereChoices(state.found)}
            where={where}
            recommended={recommendedWhere(state.found)}
            foundName={state.found[0]?.name ?? null}
            onChoose={(w) => send({ type: 'choose', where: w })}
            onContinue={() => send({ type: 'continue' })}
            onBack={back}
          />
        )
      case 'C1':
        return <Tour onSetItUp={() => send({ type: 'setItUp' })} onNotNow={() => send({ type: 'notNow' })} onBack={back} />
      case 'UNCONNECTED':
        return <Unconnected onSetItUp={() => send({ type: 'setItUp' })} />
      case 'B1':
        return <LanExplain onContinue={() => send({ type: 'lanExplained' })} onBack={back} />
      case 'B2':
        return <Looking onBack={back} />
      case 'B3':
        return (
          <ChooseComputer
            computers={state.computers}
            selected={state.selected}
            known={state.known}
            onSelect={(id) => send({ type: 'select', id })}
            onConnect={() => send({ type: 'continue' })}
            onNotSeeing={() => send({ type: 'notSeeing' })}
            onByAddress={() => send({ type: 'toAddress' })}
            onBack={back}
          />
        )
      case 'B-empty':
        return (
          <NothingFound
            lan={state.lan}
            outdated={state.outdated}
            onLookAgain={() => send({ type: 'lookAgain' })}
            onSetUpHere={() => send({ type: 'setItUpHere' })}
            onByAddress={() => send({ type: 'toAddress' })}
            onOpenSettings={() => void window.beacon?.discovery.openLocalNetworkSettings().catch(() => undefined)}
            onBack={back}
          />
        )
      case 'B-adv':
        return <ByAddress onFound={(computer) => send({ type: 'typed', computer })} onBack={back} />
      case 'B-differs':
        return <Differs name={selectedComputer(state)?.name ?? ''} onBack={back} onProceed={() => send({ type: 'proceed' })} />
      case 'F1':
        return <Hello timeoutMs={helloTimeoutMs} onDone={() => send({ type: 'helloDone' })} onFinish={onFinished} onBack={back} onThisMac={where === 'new'} />
      case 'A1':
        return (
          <CheckingMac
            verdict={state.mac}
            onChecked={(verdict) => setState((st) => onboardingReduce(st, { type: 'macChecked', verdict }))}
            onRecheck={() => send({ type: 'recheck' })}
            onElsewhere={() => send({ type: 'connectElsewhere' })}
            onConnectToIt={() => send({ type: 'useRunningHere' })}
            onOpenStorage={() => void window.beacon?.pathA.openStorageSettings().catch(() => undefined)}
            onBack={back}
          />
        )
      case 'A-confirm':
        return <ConfirmSetup onConfirm={() => send({ type: 'confirmSetup' })} onBack={back} />
      case 'A-inst':
        return (
          <Installing
            onInstalled={(daemon) => setState((st) => onboardingReduce(st, { type: 'installed', daemon }))}
            onBack={() => setState((st) => onboardingReduce(st, { type: 'back' }))}
            onSkipToHello={CONNECTS_FROM.includes('A-inst') ? () => setState((st) => onboardingReduce(st, { type: 'connected' })) : null}
          />
        )
      case 'B4': {
        const c = selectedComputer(state)
        if (!c) throw new Error('onboarding: the wait for approval was reached with no computer chosen')
        return <Approval computer={c} onApproved={() => setState((st) => onboardingReduce(st, { type: 'approved' }))} onBack={back} onOtherWay={onLegacy} />
      }
      case 'B-nojoin':
        return <NoJoin name={selectedComputer(state)?.name ?? ''} onBack={back} onOtherWay={onLegacy} />
      case 'B-ok':
        return <Connected name={selectedComputer(state)?.name ?? ''} onSayHello={() => send({ type: 'continue' })} />
      case 'A2':
        return <ThinkHow onContinue={() => send({ type: 'continue' })} onBack={back} />
      case 'A3c-1':
        return (
          <ConnectCloud
            showOthers={othersOpen}
            onSignIn={() => send({ type: 'continue' })}
            onOtherKey={(company) => send({ type: 'otherKey', company })}
            onBack={() => {
              setOthersOpen(false)
              back()
            }}
          />
        )
      case 'A3c-or':
        return (
          <SignInOpenRouter
            onSignedIn={() => setState((st) => onboardingReduce(st, { type: 'signedIn' }))}
            onBack={(others) => {
              setOthersOpen(!!others)
              back()
            }}
          />
        )
      case 'A3c-2':
        return state.company ? (
          <PasteKey company={state.company} onAccepted={() => setState((st) => onboardingReduce(st, { type: 'keyAccepted' }))} onBack={back} />
        ) : (
          (() => {
            throw new Error('onboarding: a key was asked for with no company chosen')
          })()
        )
      case 'A5':
        return <Finishing onSetUp={() => setState((st) => onboardingReduce(st, { type: 'setUp' }))} />
    }
  }

  return (
    <div className="onb-root">
      <AppChrome palette={false} />
      <div className="setup onb">
        <div className="setup-card onb-card" data-screen={s} ref={heading}>
          {s !== 'W1' ? (
            <a className="onb-help wiz-link" href={SETUP_LINKS.guide} target="_blank" rel="noreferrer">
              {COPY.main.common.help} ↗
            </a>
          ) : null}
          <div className="setup-brand">
            <span className="brand-dot" /> Beacon
          </div>
          {renderScreen()}
        </div>
      </div>
    </div>
  )
}
