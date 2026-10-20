import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { SetupProbeResult, SetupResume } from '@shared/ipc'
import { isAuthError } from '@shared/daemon-api'
import { PAIRING_CODE_LENGTH, PAIR_POLL_INTERVAL_MS, isValidPairingCode } from '@shared/pairing'
import { BEACON_SMOKE_GATEWAY } from '@shared/session-sources'
import {
  CONNECT_DIAGNOSIS_LABELS,
  FIRST_FLIGHT_ITEMS,
  FIRST_FLIGHT_OFFERED_KEY,
  WIZARD_STEPS,
  WIZARD_STEP_LABELS,
  diagnoseConnect,
  escTarget,
  gatewayConfigureFields,
  initialWizardData,
  nextStep,
  prevStep,
  resumeNotice,
  resumedWizardData,
  STALE_PAIRING_LABEL,
  slackPairError,
  stepAfterConnect,
  stepStatus,
  validateStep,
  type ConnectDiagnosis,
  type WizardData,
  type WizardStepId,
  modelConfigureFields,
  type CloudPreset
} from '@shared/setup-wizard'
import { SETUP_LINKS } from '@shared/setup-links'
import { FirstRunSetup } from './FirstRunSetup'

// The stepped first-run wizard (Onboarding Phase 2) — the flagship path from "installed the daemon"
// to a working chat. Wraps the Phase 1 pairing machinery + the daemon's remote-drivable setup API
// (/api/setup/detect|configure|complete). The old single form stays reachable as
// "Quick connect (advanced)" — zero regression for users who know what they're doing.
//
// All step ORDER / skip / validation logic is pure @shared/setup-wizard (headless-smoked);
// this component owns only fetch effects + rendering.

interface Props {
  currentAddress?: string
  /** A setup that stopped part-way (main's launch probe found the saved Prometheus in setup mode). */
  resume?: SetupResume
  onConnected: () => void
  /** Forget the saved connection and begin again from Welcome (App owns the forget + remount). */
  onStartOver: () => void
}

interface DetectedBackend {
  name: string
  provider: string
  base_url: string
  models: string[]
  latency_ms: number
}

const PERSONA_SEEDS: readonly string[] = [
  'Precise and terse — answers first, no filler.',
  'Warm and curious — explains its thinking as it goes.',
  'Dry wit — competent, with a raised eyebrow.'
]

type ApplyPhase = 'idle' | 'configuring' | 'completing' | 'waking' | 'ready' | 'error'
type SmokePhase = 'idle' | 'sending' | 'waiting' | 'ok' | 'error'

export function SetupWizard({ currentAddress, resume, onConnected, onStartOver }: Props) {
  const [quick, setQuick] = useState(false) // "Quick connect (advanced)" escape hatch
  const [data, setData] = useState<WizardData>(() => (resume ? resumedWizardData(resume) : { ...initialWizardData() }))
  const [error, setError] = useState<string | null>(null)
  const [confirmStartOver, setConfirmStartOver] = useState(false)

  // Connect step
  const [address, setAddress] = useState(currentAddress ?? '')
  const [method, setMethod] = useState<'code' | 'token'>('code')
  const [token, setToken] = useState('')
  const [code, setCode] = useState('')
  const [connectBusy, setConnectBusy] = useState(false)
  const [diagnosis, setDiagnosis] = useState<ConnectDiagnosis | null>(null)

  // Model step
  const [backends, setBackends] = useState<DetectedBackend[] | null>(null)
  const [detectBusy, setDetectBusy] = useState(false)
  const [customUrl, setCustomUrl] = useState('')
  const [cloudPresets, setCloudPresets] = useState<CloudPreset[]>([]) // GET /api/setup/detect cloud_providers (Prom PR 374)
  const [activeModel, setActiveModel] = useState<string | null>(null) // configured daemons

  // Gateways step (SPRINT G3) — which of the three optional entries is expanded.
  const [openGateways, setOpenGateways] = useState<Set<GatewayKey>>(new Set())
  const toggleGateway = (key: GatewayKey): void => {
    setOpenGateways((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // Apply + smoke steps
  const [applyPhase, setApplyPhase] = useState<ApplyPhase>('idle')
  const [smokePhase, setSmokePhase] = useState<SmokePhase>('idle')
  const [smokeReply, setSmokeReply] = useState('')
  const cancelled = useRef(false)
  useEffect(() => () => {
    cancelled.current = true
  }, [])

  const busy = connectBusy || detectBusy || applyPhase === 'configuring' || applyPhase === 'completing' || applyPhase === 'waking' || smokePhase === 'sending' || smokePhase === 'waiting'

  const patch = useCallback((p: Partial<WizardData>) => setData((d) => ({ ...d, ...p })), [])
  const go = useCallback(
    (step: WizardStepId | null) => {
      if (step) {
        setError(null)
        patch({ step })
      }
    },
    [patch]
  )

  // Esc = back one step, where safe (pure rule: shared/setup-wizard.escTarget).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || quick) return
      go(escTarget(data.step, data, busy))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [data, busy, quick, go])

  // ── Connect step actions ──────────────────────────────────────────────────

  async function runTest(): Promise<void> {
    const b = window.beacon
    const addr = address.trim()
    if (!b || !addr || connectBusy) return
    setConnectBusy(true)
    setDiagnosis(null)
    setError(null)
    try {
      // Setup-mode first (cheap + decisive), then the regular REST probe for the tri-state.
      const probe: SetupProbeResult = await b.setup.probe({ address: addr })
      if (probe.setupMode) {
        setDiagnosis('setup-mode')
        setMethod('code')
        return
      }
      const test = await b.connection.test({
        apiBase: `http://${hostOnly(addr)}:8005`,
        token: token.trim() || undefined,
        useSavedToken: false
      })
      setDiagnosis(diagnoseConnect({ setupMode: probe.setupMode ? true : null, testOk: test.ok, testCode: test.code }))
    } catch (e) {
      setError(String(e))
    } finally {
      setConnectBusy(false)
    }
  }

  async function connectWithToken(): Promise<void> {
    const b = window.beacon
    const addr = address.trim()
    if (!b || !addr || connectBusy) return
    setConnectBusy(true)
    setError(null)
    try {
      const probe = await b.setup.probe({ address: addr })
      if (probe.setupMode) {
        setDiagnosis('setup-mode')
        setMethod('code')
        setError('This daemon has no configuration yet — pair with the 6-digit code from its terminal.')
        return
      }
      const test = await b.connection.test({
        apiBase: `http://${hostOnly(addr)}:8005`,
        token: token.trim() || undefined,
        useSavedToken: false
      })
      if (!test.ok) {
        setDiagnosis(diagnoseConnect({ setupMode: null, testOk: false, testCode: test.code }))
        setError(test.label)
        return
      }
      const res = await b.setup.save({ address: addr, token: token.trim() || undefined })
      if (!res.ok) {
        setError(res.error ?? 'Failed to connect.')
        return
      }
      setDiagnosis('connected')
      patch({ connected: true, daemonMode: 'configured', resumeConfigured: false })
      go(stepAfterConnect({ daemonMode: 'configured', resumeConfigured: false }))
    } catch (e) {
      setError(String(e))
    } finally {
      setConnectBusy(false)
    }
  }

  async function pairWithCode(): Promise<void> {
    const b = window.beacon
    const addr = address.trim()
    const c = code.trim()
    if (!b || !addr || connectBusy) return
    if (!isValidPairingCode(c)) {
      setError(`The pairing code is exactly ${PAIRING_CODE_LENGTH} digits.`)
      return
    }
    setConnectBusy(true)
    setError(null)
    try {
      const res = await b.setup.pair({ address: addr, code: c })
      if (!res.ok) {
        setError(res.error ?? 'Pairing failed.')
        return
      }
      // Resume detection: has /api/setup/configure already run on this daemon?
      const probe = await b.setup.probe({ address: addr }).catch(() => null)
      const resume = probe?.configured === true
      patch({ connected: true, daemonMode: 'setup', resumeConfigured: resume })
      go(stepAfterConnect({ daemonMode: 'setup', resumeConfigured: resume }))
    } catch (e) {
      setError(String(e))
    } finally {
      setConnectBusy(false)
    }
  }

  // ── Model step effects ────────────────────────────────────────────────────

  useEffect(() => {
    const b = window.beacon
    if (!b || data.step !== 'model') return
    if (data.daemonMode === 'configured') {
      // Already configured → show the active model (GET /api/models, Prom #71).
      void b.daemon
        .get('/api/models')
        .then((raw) => {
          const body = raw as { models?: { key?: string; model?: string; is_default?: boolean }[] } | null
          const def = body?.models?.find((m) => m.is_default)
          setActiveModel(def?.model ?? body?.models?.[0]?.model ?? null)
        })
        .catch(() => setActiveModel(null))
      return
    }
    if (backends === null && !detectBusy) void detect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.step, data.daemonMode])

  async function detect(baseUrl?: string): Promise<void> {
    const b = window.beacon
    if (!b || detectBusy) return
    setDetectBusy(true)
    setError(null)
    try {
      const path = baseUrl
        ? `/api/setup/detect?base_url=${encodeURIComponent(baseUrl.trim())}`
        : '/api/setup/detect'
      const raw = (await b.daemon.get(path)) as { backends?: DetectedBackend[]; cloud_providers?: CloudPreset[] } | null
      const found = raw?.backends ?? []
      if (Array.isArray(raw?.cloud_providers)) setCloudPresets(raw.cloud_providers) // absent on a pre-PR 374 daemon → no cloud cards
      if (baseUrl) {
        // Custom probe: merge (replace same-URL entries) so local results stay visible.
        setBackends((prev) => {
          const kept = (prev ?? []).filter((x) => !found.some((f) => f.base_url === x.base_url))
          return [...kept, ...found]
        })
        if (found.length === 0) setError(`${baseUrl.trim()} did not answer like an inference server.`)
        else selectBackend(found[0])
      } else {
        setBackends(found)
        if (found.length > 0 && !data.baseUrl) selectBackend(found[0])
      }
    } catch (e) {
      if (stalePairing(e)) return
      setError(String(e))
      if (!baseUrl) setBackends([])
    } finally {
      setDetectBusy(false)
    }
  }

  /** A setup-mode Prometheus refusing the saved pairing (it was set up again since, e.g. reinstalled):
   *  no step past Connect can work, so go back there and say how to pair again. True if handled. */
  function stalePairing(e: unknown): boolean {
    if (!isAuthError(e) || data.daemonMode !== 'setup') return false
    setBackends(null)
    setMethod('code')
    patch({ connected: false, daemonMode: 'unknown', resumeConfigured: false })
    go('connect')
    setError(STALE_PAIRING_LABEL)
    return true
  }

  function selectBackend(be: DetectedBackend): void {
    patch({ backendKind: 'local', provider: be.provider, baseUrl: be.base_url, model: be.models[0] ?? '', apiKey: '', cloudKeyPresent: false, cloudKeyEnv: '' })
  }

  function selectCloud(preset: CloudPreset): void {
    // Cloud presets take NO base_url (the daemon refuses one); the model defaults to the preset's.
    patch({ backendKind: 'cloud', provider: preset.provider, baseUrl: '', model: preset.default_model, apiKey: '', cloudKeyPresent: preset.key_present, cloudKeyEnv: preset.api_key_env })
  }

  // ── Apply & wake ──────────────────────────────────────────────────────────

  async function applyAndWake(): Promise<void> {
    const b = window.beacon
    if (!b || busy) return
    setError(null)
    try {
      // A resumed half-done wizard (configure ran, complete didn't) with no fresh answers only
      // needs the complete call; otherwise (re-)POST configure — the daemon is idempotent.
      if (!(data.resumeConfigured && !data.model)) {
        setApplyPhase('configuring')
        await b.daemon.write('/api/setup/configure', {
          // Local vs cloud body from ONE pure builder (headless-smoked) — cloud sends no base_url and
          // the api_key only when typed (Prometheus PR 374).
          ...modelConfigureFields(data),
          ...(data.agentName.trim() ? { agent_name: data.agentName.trim() } : {}),
          ...(data.persona.trim() ? { persona: data.persona.trim() } : {}),
          // SPRINT G3: telegram/slack/discord fields, only for gateways the
          // user actually filled in (pure helper, headless-smoked).
          ...gatewayConfigureFields(data)
        })
      }
      setApplyPhase('completing')
      await b.daemon.write('/api/setup/complete', {})
      setApplyPhase('waking')
      // Reuse Phase 1's pairPoll machinery: the ONLY ready signal is /api/status 200 with the token.
      const deadline = Date.now() + 180_000
      while (!cancelled.current) {
        const res = await b.setup.pairPoll().catch(() => ({ state: 'waiting' as const }))
        if (res.state === 'ready') break
        if (Date.now() > deadline) throw new Error('The daemon never answered /api/status — check its terminal for errors.')
        await sleep(PAIR_POLL_INTERVAL_MS)
      }
      if (cancelled.current) return
      // The daemon restarted into its real self — redial the WS so chat works right away.
      await b.connection.reconnect().catch(() => undefined)
      setApplyPhase('ready')
      patch({ applied: true })
    } catch (e) {
      if (stalePairing(e)) {
        setApplyPhase('idle')
        return
      }
      setApplyPhase('error')
      setError(errText(e))
    }
  }

  // ── Smoke test ────────────────────────────────────────────────────────────

  async function runSmoke(): Promise<void> {
    const b = window.beacon
    if (!b || busy) return
    setError(null)
    setSmokeReply('')
    setSmokePhase('sending')
    try {
      // The daemon surface Beacon already uses: POST /api/sessions → POST /api/chat/send →
      // poll the durable messages route for the assistant reply (REST-only round-trip).
      //
      // Declares `beacon-verify`, NOT `beacon`: this leaves a real session behind on
      // every first run, so it is debris by construction and belongs behind the
      // Automated chip. The existing `-verify` suffix rule puts it there.
      const created = (await b.daemon.write('/api/sessions', { gateway: BEACON_SMOKE_GATEWAY })) as {
        session_id?: string
      } | null
      const sid = created?.session_id
      if (!sid) throw new Error('POST /api/sessions returned no session_id.')
      await b.daemon.write('/api/chat/send', {
        session_id: sid,
        message: 'Hello! One-line hello back, please — this is the setup smoke test.'
      })
      setSmokePhase('waiting')
      const deadline = Date.now() + 120_000
      while (!cancelled.current) {
        await sleep(2_000)
        const raw = (await b.daemon
          .get(`/api/sessions/${encodeURIComponent(sid)}/messages?since=0`)
          .catch(() => null)) as { messages?: { role?: string; content?: string }[] } | null
        const reply = raw?.messages?.find((m) => m.role === 'assistant' && (m.content ?? '').trim())
        if (reply) {
          setSmokeReply((reply.content ?? '').trim())
          setSmokePhase('ok')
          patch({ smokeOk: true })
          return
        }
        if (Date.now() > deadline) throw new Error('No reply within two minutes — the model may still be loading. You can retry, or continue and try chatting later.')
      }
    } catch (e) {
      setSmokePhase('error')
      setError(errText(e))
    }
  }

  // ── Finish ────────────────────────────────────────────────────────────────

  async function finish(): Promise<void> {
    // Arm the Mission-home "First flight" checklist (b.settings — the panels' store).
    await window.beacon?.settings.set(FIRST_FLIGHT_OFFERED_KEY, '1').catch(() => undefined)
    onConnected()
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  if (quick) {
    return (
      <div className="setup wiz-quick">
        <div>
          <button className="wiz-link" onClick={() => setQuick(false)}>
            ← Back to guided setup
          </button>
          <FirstRunSetup currentAddress={currentAddress} onConnected={onConnected} />
        </div>
      </div>
    )
  }

  const stepGate = validateStep(data.step, data)
  const next = nextStep(data.step, data)
  const prev = prevStep(data.step, data)

  return (
    <div className="setup">
      <div className="setup-card wiz-card">
        <div className="setup-brand">
          <span className="brand-dot" /> Beacon · setup
        </div>
        <div className="wiz-body">
          <nav className="wiz-rail" aria-label="Setup steps">
            {WIZARD_STEPS.map((s, i) => {
              const skipped = stepStatus(s, data) === 'skipped'
              const cls =
                s === data.step ? 'wiz-step active' : skipped ? 'wiz-step skipped' : 'wiz-step'
              return (
                <div key={s} className={cls}>
                  <span className="wiz-dot">{i + 1}</span>
                  <span>
                    {WIZARD_STEP_LABELS[s]}
                    {skipped ? <em> · already configured</em> : null}
                  </span>
                </div>
              )
            })}
          </nav>

          <div className="wiz-pane">
            {resume && !data.applied ? (
              <div className="wiz-resume setup-sub" style={{ marginTop: 0 }}>
                {resumeNotice(resume, currentAddress)}{' '}
                {confirmStartOver ? (
                  <>
                    <span style={{ display: 'block', marginTop: 6 }}>
                      Beacon forgets this connection on this Mac. To pair again you&apos;ll need a new code: restart{' '}
                      <code>oara daemon</code> on its computer.
                    </span>
                    <span style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                      <button className="setup-test" onClick={onStartOver} disabled={busy}>
                        Forget and start over
                      </button>
                      <button className="setup-test" onClick={() => setConfirmStartOver(false)}>
                        Cancel
                      </button>
                    </span>
                  </>
                ) : (
                  <button className="wiz-link" onClick={() => setConfirmStartOver(true)} disabled={busy}>
                    Start over
                  </button>
                )}
              </div>
            ) : null}
            {data.step === 'welcome' ? (
              <>
                <h1>Welcome aboard</h1>
                <p className="setup-sub">
                  <strong>Prometheus</strong> is a local-first agent daemon: your model, your hardware, your data —
                  it persists, remembers, and acts on your machine. <strong>Beacon</strong> is its cockpit: chat,
                  activity, files, coding runs, and mission control in one window. This short setup connects the two
                  and gets you to a working chat.
                </p>
                <p className="setup-sub">
                  You&apos;ll need the address of the machine running <code>oara daemon</code> (formerly{' '}
                  <code>prometheus daemon</code>, which still works) — and either its API token or the 6-digit pairing
                  code it printed at startup.
                </p>
                <p className="setup-sub">
                  Don&apos;t have Prometheus yet?{' '}
                  <a href={SETUP_LINKS.guide} target="_blank" rel="noreferrer" style={{ color: 'var(--c-arc)' }}>
                    The setup guide ↗
                  </a>{' '}
                  shows how to install it and start it, then come back here.
                </p>
              </>
            ) : null}

            {data.step === 'connect' ? (
              <>
                <h1>Connect to your daemon</h1>
                <div className="setup-tabs" role="tablist" aria-label="Connection method">
                  <button
                    role="tab"
                    aria-selected={method === 'code'}
                    className={method === 'code' ? 'setup-tab active' : 'setup-tab'}
                    onClick={() => setMethod('code')}
                  >
                    Pairing code
                  </button>
                  <button
                    role="tab"
                    aria-selected={method === 'token'}
                    className={method === 'token' ? 'setup-tab active' : 'setup-tab'}
                    onClick={() => setMethod('token')}
                  >
                    API token
                  </button>
                </div>
                <label className="setup-field">
                  Gateway address
                  <input
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    placeholder="host:8005  ·  Tailscale host or LAN IP"
                    autoFocus
                    spellCheck={false}
                    disabled={data.connected}
                  />
                </label>
                {method === 'token' ? (
                  <label className="setup-field">
                    API token <span className="opt">optional</span>
                    <input
                      type="password"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      placeholder="PROMETHEUS_API_TOKEN, or leave blank"
                      spellCheck={false}
                    />
                  </label>
                ) : (
                  <label className="setup-field">
                    Pairing code
                    <input
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, PAIRING_CODE_LENGTH))}
                      placeholder="6 digits from the daemon's terminal"
                      inputMode="numeric"
                      spellCheck={false}
                      disabled={data.connected}
                    />
                  </label>
                )}
                {diagnosis ? (
                  <div className={diagnosis === 'connected' ? 'setup-test-ok' : diagnosis === 'setup-mode' ? 'wiz-note' : 'setup-error'}>
                    {CONNECT_DIAGNOSIS_LABELS[diagnosis]}
                  </div>
                ) : null}
                {data.connected ? <div className="setup-test-ok">Connected ✓</div> : null}
                <div className="wiz-row">
                  <button className="setup-test" onClick={() => void runTest()} disabled={connectBusy || !address.trim()}>
                    {connectBusy ? <Spinner /> : null} Test
                  </button>
                  <button
                    className="setup-connect"
                    style={{ flex: 1, width: 'auto' }}
                    onClick={() => void (method === 'token' ? connectWithToken() : pairWithCode())}
                    disabled={connectBusy || data.connected || !address.trim() || (method === 'code' && !isValidPairingCode(code.trim()))}
                  >
                    {connectBusy ? <Spinner /> : null}
                    {data.connected ? 'Connected' : connectBusy ? (method === 'code' ? 'Pairing…' : 'Connecting…') : method === 'code' ? 'Pair' : 'Connect'}
                  </button>
                </div>
                <p className="setup-foot">
                  Not sure what to enter?{' '}
                  <a href={SETUP_LINKS.guide} target="_blank" rel="noreferrer" style={{ color: 'var(--c-arc)' }}>
                    How do I set up Prometheus? ↗
                  </a>
                </p>
                <p className="setup-foot">
                  Know your way around?{' '}
                  <button className="wiz-link" onClick={() => setQuick(true)}>
                    Quick connect (advanced)
                  </button>
                </p>
              </>
            ) : null}

            {data.step === 'model' ? (
              data.daemonMode === 'configured' ? (
                <>
                  <h1>Model</h1>
                  <p className="setup-sub">
                    This daemon is already configured{activeModel ? (
                      <>
                        {' '}and running <code>{activeModel}</code>
                      </>
                    ) : null}
                    . Identity and gateways were set up on the host, so those steps are skipped. Per-session model
                    switching lives in the chat composer once you&apos;re in.
                  </p>
                </>
              ) : (
                <>
                  <h1>Pick a model</h1>
                  <p className="setup-sub">
                    Backends detected on the daemon&apos;s machine{detectBusy ? ' — probing…' : ''}:
                  </p>
                  {detectBusy && backends === null ? (
                    <div className="wiz-note">
                      <Spinner /> Probing llama.cpp · Ollama · LM Studio · vLLM…
                    </div>
                  ) : null}
                  {backends !== null && backends.length === 0 ? (
                    <div className="wiz-note">
                      No local inference server answered. Start one (e.g. <code>ollama serve</code>) and re-detect, or
                      point at a custom URL below.
                    </div>
                  ) : null}
                  {(backends ?? []).map((be) => (
                    <label key={be.base_url} className="wiz-backend">
                      <input
                        type="radio"
                        name="backend"
                        checked={data.baseUrl === be.base_url}
                        onChange={() => selectBackend(be)}
                      />
                      <span className="wiz-backend-name">
                        {be.name} <em>{be.base_url} · {Math.round(be.latency_ms)}ms</em>
                      </span>
                      {data.baseUrl === be.base_url && be.models.length > 0 ? (
                        <select value={data.model} onChange={(e) => patch({ model: e.target.value })}>
                          {be.models.map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                        </select>
                      ) : null}
                    </label>
                  ))}
                  {cloudPresets.length > 0 ? (
                    <>
                      <p className="setup-sub" style={{ marginTop: 14 }}>
                        Or a cloud provider — the key is sent once to the daemon and stored in its env file, never here:
                      </p>
                      {cloudPresets.map((cp) => {
                        const active = data.backendKind === 'cloud' && data.provider === cp.provider
                        return (
                          <label key={`cloud:${cp.provider}`} className="wiz-backend">
                            <input type="radio" name="backend" checked={active} onChange={() => selectCloud(cp)} />
                            <span className="wiz-backend-name">
                              {cp.provider} <em>{cp.key_present ? `key on the daemon (${cp.api_key_env})` : `needs ${cp.api_key_env}`}</em>
                            </span>
                            {active ? (
                              <span style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
                                <input
                                  className="wiz-inline-input"
                                  value={data.model}
                                  onChange={(e) => patch({ model: e.target.value })}
                                  placeholder={cp.default_model}
                                  spellCheck={false}
                                />
                                <input
                                  className="wiz-inline-input"
                                  type="password"
                                  value={data.apiKey}
                                  onChange={(e) => patch({ apiKey: e.target.value })}
                                  placeholder={cp.key_present ? `API key (optional — the daemon already holds ${cp.api_key_env})` : `API key (${cp.api_key_env})`}
                                  autoComplete="off"
                                  spellCheck={false}
                                />
                              </span>
                            ) : null}
                          </label>
                        )
                      })}
                    </>
                  ) : null}
                  <div className="wiz-row" style={{ marginTop: 10 }}>
                    <input
                      className="wiz-inline-input"
                      value={customUrl}
                      onChange={(e) => setCustomUrl(e.target.value)}
                      placeholder="Custom base URL, e.g. http://gpu-box:8080"
                      spellCheck={false}
                    />
                    <button className="setup-test" onClick={() => void detect(customUrl)} disabled={detectBusy || !customUrl.trim()}>
                      {detectBusy ? <Spinner /> : null} Probe
                    </button>
                    <button className="setup-test" onClick={() => void detect()} disabled={detectBusy} title="Re-run local detection">
                      Re-detect
                    </button>
                  </div>
                </>
              )
            ) : null}

            {data.step === 'identity' ? (
              <>
                <h1>Name your agent</h1>
                <label className="setup-field">
                  Agent name
                  <input
                    value={data.agentName}
                    onChange={(e) => patch({ agentName: e.target.value })}
                    spellCheck={false}
                    autoFocus
                  />
                </label>
                <div className="setup-field">
                  Persona seed <span className="opt">optional</span>
                  <div className="wiz-chips">
                    {PERSONA_SEEDS.map((p) => (
                      <button
                        key={p}
                        className={data.persona === p ? 'wiz-chip active' : 'wiz-chip'}
                        onClick={() => patch({ persona: data.persona === p ? '' : p })}
                      >
                        {p.split(' — ')[0]}
                      </button>
                    ))}
                  </div>
                  <textarea
                    className="wiz-textarea"
                    value={data.persona}
                    onChange={(e) => patch({ persona: e.target.value })}
                    placeholder="…or describe it in your own words (optional)"
                    rows={2}
                  />
                </div>
                <p className="setup-foot">
                  This writes the agent&apos;s SOUL.md on the daemon — its name and voice. You can edit it later.
                </p>
              </>
            ) : null}

            {data.step === 'gateways' ? (
              <>
                <h1>Gateways <span className="opt">optional</span></h1>
                <p className="setup-sub">
                  Reach your agent from chat apps you already use. Every entry is optional — enable any,
                  all, or none (you can add one later with <code>oara setup --gateway-only</code> on
                  the daemon).
                </p>

                <GatewaySection
                  title="Telegram"
                  hint="bot token from @BotFather (/newbot — takes a minute)"
                  open={openGateways.has('telegram')}
                  filled={Boolean(data.telegramToken.trim())}
                  onToggle={() => toggleGateway('telegram')}
                >
                  <p className="setup-foot">
                    Message{' '}
                    <a href={SETUP_LINKS.botfather} target="_blank" rel="noreferrer" style={{ color: 'var(--c-arc)' }}>
                      @BotFather ↗
                    </a>{' '}
                    on Telegram, send <code>/newbot</code>, and paste the token it gives you.
                  </p>
                  <label className="setup-field">
                    Bot token
                    <input
                      type="password"
                      value={data.telegramToken}
                      onChange={(e) => patch({ telegramToken: e.target.value })}
                      placeholder="123456789:ABC…"
                      spellCheck={false}
                    />
                  </label>
                </GatewaySection>

                <GatewaySection
                  title="Slack"
                  hint="Socket Mode app — needs BOTH tokens"
                  open={openGateways.has('slack')}
                  filled={Boolean(data.slackBotToken.trim() || data.slackAppToken.trim())}
                  onToggle={() => toggleGateway('slack')}
                >
                  <p className="setup-foot">
                    Create an app at{' '}
                    <a href={SETUP_LINKS.slackApps} target="_blank" rel="noreferrer" style={{ color: 'var(--c-arc)' }}>
                      api.slack.com/apps ↗
                    </a>
                    , enable Socket Mode, install it to
                    your workspace, then copy both tokens.
                  </p>
                  <label className="setup-field">
                    Bot token (xoxb-…)
                    <input
                      type="password"
                      value={data.slackBotToken}
                      onChange={(e) => patch({ slackBotToken: e.target.value })}
                      placeholder="xoxb-…"
                      spellCheck={false}
                    />
                  </label>
                  <label className="setup-field">
                    App token (xapp-…)
                    <input
                      type="password"
                      value={data.slackAppToken}
                      onChange={(e) => patch({ slackAppToken: e.target.value })}
                      placeholder="xapp-…"
                      spellCheck={false}
                    />
                  </label>
                  <label className="setup-field">
                    Channel IDs <span className="opt">optional — comma-separated whitelist</span>
                    <input
                      value={data.slackChannels}
                      onChange={(e) => patch({ slackChannels: e.target.value })}
                      placeholder="C0123456789, C0987654321 — blank allows any channel"
                      spellCheck={false}
                    />
                  </label>
                  {slackPairError(data) ? <div className="setup-error">{slackPairError(data)}</div> : null}
                </GatewaySection>

                <GatewaySection
                  title="Discord"
                  hint="bot token from the developer portal"
                  open={openGateways.has('discord')}
                  filled={Boolean(data.discordToken.trim())}
                  onToggle={() => toggleGateway('discord')}
                >
                  <p className="setup-foot">
                    1. Create an app at{' '}
                    <a href={SETUP_LINKS.discordApps} target="_blank" rel="noreferrer" style={{ color: 'var(--c-arc)' }}>
                      discord.com/developers/applications ↗
                    </a>{' '}
                    and add a Bot.
                    <br />
                    2. Enable the Message Content Intent (Bot → Privileged Gateway Intents).
                    <br />
                    3. Invite it with the <code>bot</code> + <code>applications.commands</code> scopes.
                  </p>
                  <label className="setup-field">
                    Bot token
                    <input
                      type="password"
                      value={data.discordToken}
                      onChange={(e) => patch({ discordToken: e.target.value })}
                      placeholder="Bot token from the Bot tab"
                      spellCheck={false}
                    />
                  </label>
                  <label className="setup-field">
                    Guild IDs <span className="opt">optional — comma-separated; blank = DMs-only</span>
                    <input
                      value={data.discordGuildIds}
                      onChange={(e) => patch({ discordGuildIds: e.target.value })}
                      placeholder="123456789012345678"
                      spellCheck={false}
                    />
                  </label>
                </GatewaySection>

                <button
                  className="setup-test wiz-skip-all"
                  onClick={() => {
                    patch({
                      telegramToken: '',
                      slackBotToken: '',
                      slackAppToken: '',
                      slackChannels: '',
                      discordToken: '',
                      discordGuildIds: ''
                    })
                    go(next)
                  }}
                >
                  Skip all — chat from Beacon only for now
                </button>
              </>
            ) : null}

            {data.step === 'apply' ? (
              <>
                <h1>Apply &amp; wake</h1>
                <p className="setup-sub">
                  {data.resumeConfigured && !data.model
                    ? 'This daemon was already configured (a previous run got this far) — finishing wakes it up.'
                    : 'Writes the configuration + identity on the daemon, then flips it from setup mode into the real thing.'}
                </p>
                <ul className="wiz-tasks">
                  <ApplyTask label="Write configuration" state={taskState(applyPhase, 'configuring')} />
                  <ApplyTask label="Verify & flip to the real daemon" state={taskState(applyPhase, 'completing')} />
                  <ApplyTask label="Wait for /api/status (the daemon waking up)" state={taskState(applyPhase, 'waking')} />
                </ul>
                {applyPhase === 'ready' ? <div className="setup-test-ok">The daemon is up ✓</div> : null}
                {applyPhase !== 'ready' ? (
                  <button className="setup-connect" onClick={() => void applyAndWake()} disabled={busy}>
                    {busy ? <Spinner /> : null}
                    {applyPhase === 'idle' || applyPhase === 'error' ? 'Apply & wake' : 'Working…'}
                  </button>
                ) : null}
              </>
            ) : null}

            {data.step === 'smoke' ? (
              <>
                <h1>Smoke test</h1>
                <p className="setup-sub">One real round-trip: Beacon sends a hello, your agent answers.</p>
                {smokePhase === 'ok' ? (
                  <div className="setup-test-ok">
                    <strong>Reply received ✓</strong>
                    <div className="wiz-reply">{smokeReply}</div>
                  </div>
                ) : (
                  <button className="setup-connect" onClick={() => void runSmoke()} disabled={busy}>
                    {busy ? <Spinner /> : null}
                    {smokePhase === 'sending'
                      ? 'Sending…'
                      : smokePhase === 'waiting'
                        ? 'Waiting for the reply… (first load can take a while)'
                        : smokePhase === 'error'
                          ? 'Retry smoke test'
                          : 'Send a test message'}
                  </button>
                )}
              </>
            ) : null}

            {data.step === 'finish' ? (
              <>
                <h1>You&apos;re flying</h1>
                <p className="setup-sub">
                  Setup is done{data.smokeOk ? ' and the chat loop is proven' : ''}. Mission home has a short
                  first-flight checklist waiting:
                </p>
                <ul className="wiz-tasks">
                  {FIRST_FLIGHT_ITEMS.map((i) => (
                    <li key={i.id} className="wiz-task">
                      <span className="wiz-dot">○</span> {i.label}
                    </li>
                  ))}
                </ul>
                <button className="setup-connect" onClick={() => void finish()}>
                  Enter Beacon
                </button>
              </>
            ) : null}

            {error ? <div className="setup-error" style={{ marginTop: 12 }}>{error}</div> : null}

            <div className="wiz-nav">
              <button className="setup-test" onClick={() => go(prev)} disabled={!prev || busy} style={{ visibility: prev ? 'visible' : 'hidden' }}>
                ← Back
              </button>
              {data.step !== 'finish' ? (
                <button
                  className="setup-connect"
                  style={{ width: 'auto', padding: '9px 22px' }}
                  onClick={() => go(next)}
                  disabled={!next || stepGate !== null || busy}
                  title={stepGate ?? undefined}
                >
                  Next →
                </button>
              ) : null}
            </div>
            {stepGate && data.step !== 'welcome' ? <p className="setup-foot">{stepGate}</p> : null}
          </div>
        </div>
      </div>
    </div>
  )
}

function Spinner() {
  return <span className="wiz-spinner" aria-label="working" />
}

type GatewayKey = 'telegram' | 'slack' | 'discord'

/** One collapsible optional-gateway entry (SPRINT G3). Header toggles the
 * body; a filled entry shows a ✓ so collapsed state stays honest. */
function GatewaySection({
  title,
  hint,
  open,
  filled,
  onToggle,
  children
}: {
  title: string
  hint: string
  open: boolean
  filled: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <div className={open ? 'wiz-gw open' : 'wiz-gw'}>
      <button className="wiz-gw-head" onClick={onToggle} aria-expanded={open}>
        <span className="wiz-dot">{filled ? '✓' : open ? '−' : '+'}</span>
        <span className="wiz-gw-title">
          {title} <em>{hint}</em>
        </span>
      </button>
      {open ? <div className="wiz-gw-body">{children}</div> : null}
    </div>
  )
}

function ApplyTask({ label, state }: { label: string; state: 'todo' | 'busy' | 'done' }) {
  return (
    <li className={`wiz-task ${state}`}>
      <span className="wiz-dot">{state === 'done' ? '✓' : state === 'busy' ? <Spinner /> : '○'}</span> {label}
    </li>
  )
}

/** Task-row state from the apply pipeline phase (phases run strictly in order). */
function taskState(phase: ApplyPhase, task: 'configuring' | 'completing' | 'waking'): 'todo' | 'busy' | 'done' {
  const order: ApplyPhase[] = ['configuring', 'completing', 'waking']
  const p = order.indexOf(phase)
  const t = order.indexOf(task)
  if (phase === 'ready') return 'done'
  if (p < 0) return 'todo' // idle / error
  if (t < p) return 'done'
  if (t === p) return 'busy'
  return 'todo'
}

function hostOnly(address: string): string {
  return address
    .trim()
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
