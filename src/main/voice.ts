/**
 * Voice turns — main half (feat/voice-turns).
 *
 * THE PROCESS SPLIT IS A HARD CONSTRAINT, NOT STYLE (spec v2 delta): capture
 * (getUserMedia/AudioContext) lives in the renderer — main has no DOM, no
 * media devices. Main owns what only main may know: the oara integration's
 * base URL and its bearer (registry + keychain blob, never renderer-visible).
 *
 * The renderer hands main pcm16 base64 over IPC; main POSTs
 * {session_id:'voice:beacon', audio_base64, audio_format:'pcm16',
 * sample_rate:16000} to {baseUrl}/bridge/voice and returns the parsed body.
 * Statuses are passed through verbatim — the renderer's parseVoiceOutcome is
 * the single mapper to a visible state (complete/no_speech/timeout/error).
 *
 * AUDIO TRANSIT: raw mic audio crosses tailnet to your own box, bearer-gated
 * — the stack's existing trust model. Stated so the reasoning isn't
 * reconstructed later (spec; q-in-querystring note, same class).
 */

import { vadPortOr } from '@shared/hands-free'
import { join } from 'path'
import { app } from 'electron'
import { IPC } from '@shared/ipc'
import { VOICE_SAMPLE_RATE, VOICE_SESSION_ID, type BridgeVoiceResponse } from '@shared/voice'
import { NdjsonBuffer, VOICE_PATH, VOICE_STREAM_PATH, streamUnsupported, type VoiceStreamEvent } from '@shared/voice-stream'
import type { BridgeTranscribeResponse } from '@shared/dictation'
import { OARA_INTEGRATION_ID, VOICE_NOT_CONNECTED, oaraEntry } from '@shared/voice-gate'
import { loadIntegrations } from './integrations-store'
import { checkOaraBridge } from './oara-check'
import { CredentialStore, electronSafeStorageCipher } from './credentials'
import { handleFromShell } from './shell-windows'
const VOICE_TIMEOUT_S = 120 // bridge cap is 600; 120 covers a long agent turn without hanging the UI path

interface VoiceTurnArgs {
  audioBase64?: unknown
}

function registry(): ReturnType<typeof loadIntegrations> {
  return loadIntegrations(join(app.getPath('userData'), 'integrations.json'))
}

/** Resolve base URL + bearer for the oara entry, or a named error the renderer surfaces LOUD. */
export function resolveOaraEndpoint(): { baseUrl: string; token: string | null; vadPort: number } {
  const entry = oaraEntry(registry())
  if (!entry) throw new Error(VOICE_NOT_CONNECTED)
  const token =
    entry.authRef === 'stored'
      ? new CredentialStore(join(app.getPath('userData'), `integration-${OARA_INTEGRATION_ID}.bin`), electronSafeStorageCipher()).getToken()
      : null
  // The VAD port is this integration's own setting: `"options": { "vadPort": 8013 }` on the oara entry.
  return { baseUrl: entry.baseUrl.replace(/\/$/, ''), token, vadPort: vadPortOr(entry.options?.vadPort) }
}


async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300)
  } catch {
    return ''
  }
}

function voiceBody(audioBase64: string): string {
  return JSON.stringify({
    session_id: VOICE_SESSION_ID,
    audio_base64: audioBase64,
    audio_format: 'pcm16',
    sample_rate: VOICE_SAMPLE_RATE,
    timeout_s: VOICE_TIMEOUT_S
  })
}

function voiceHttpError(res: Response, body: string, path: string): Error {
  return new Error(
    res.status === 401
      ? `voice: oara auth FAILED (401) — check the oara integration token${body ? `: ${body}` : ''}`
      : `voice: HTTP ${res.status} from ${path}${body ? ` — ${body}` : ''}`
  )
}

export function registerVoiceHandlers(): void {
  // Whether the voice controls exist at all. Reads the registry, touches nothing on the network:
  // configured is a fact about this install, not about whether the bridge is up right now.
  handleFromShell(IPC.VOICE_CONFIGURED, async (): Promise<boolean> => oaraEntry(registry()) !== null)

  // The pre-microphone check (see checkOaraBridge). Throws the named reason; resolves when OAra
  // Voice answered, which is the only case in which the renderer goes on to ask for the mic.
  handleFromShell(IPC.VOICE_PREFLIGHT, async (): Promise<boolean> => {
    const { baseUrl, token } = resolveOaraEndpoint()
    await checkOaraBridge(baseUrl, token)
    return true
  })

  // STREAMING turn (oara-voice #12): POST /bridge/voice/stream, forward each NDJSON line to the
  // renderer as it arrives, resolve with the `done` envelope. A 404/405 means the middleware
  // predates the route → fall back to /bridge/voice (joined WAV in the response) and SAY so with a
  // `fallback` event; any other status is a real failure and is thrown with the bridge's words.
  handleFromShell(IPC.VOICE_TURN_STREAM, async (e, args: VoiceTurnArgs): Promise<BridgeVoiceResponse> => {
    const audioBase64 = typeof args?.audioBase64 === 'string' ? args.audioBase64 : ''
    if (audioBase64.length < 8) throw new Error('voice turn rejected: no audio captured')
    const { baseUrl, token } = resolveOaraEndpoint()
    const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }
    const emit = (ev: VoiceStreamEvent): void => {
      if (!e.sender.isDestroyed()) e.sender.send(IPC.VOICE_STREAM_EVENT, ev)
    }
    const res = await fetch(`${baseUrl}${VOICE_STREAM_PATH}`, {
      method: 'POST',
      headers,
      body: voiceBody(audioBase64),
      signal: AbortSignal.timeout((VOICE_TIMEOUT_S + 10) * 1000)
    })
    if (streamUnsupported(res.status)) {
      emit({ type: 'fallback', reason: `this OAra voice bridge has no ${VOICE_STREAM_PATH} (older than oara-voice#12) — using ${VOICE_PATH}` })
      const plain = await fetch(`${baseUrl}${VOICE_PATH}`, {
        method: 'POST',
        headers,
        body: voiceBody(audioBase64),
        signal: AbortSignal.timeout((VOICE_TIMEOUT_S + 10) * 1000)
      })
      if (!plain.ok) throw voiceHttpError(plain, await safeText(plain), VOICE_PATH)
      return (await plain.json()) as BridgeVoiceResponse
    }
    if (!res.ok || !res.body) throw voiceHttpError(res, await safeText(res), VOICE_STREAM_PATH)

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    const buf = new NdjsonBuffer()
    let done: Extract<VoiceStreamEvent, { type: 'done' }> | null = null
    const handle = (evs: VoiceStreamEvent[], malformed: string[]): void => {
      for (const m of malformed) console.warn('[voice-stream] malformed line ignored:', m)
      for (const ev of evs) {
        emit(ev)
        if (ev.type === 'done') done = ev
      }
    }
    for (;;) {
      const { value, done: eof } = await reader.read()
      if (eof) break
      const r = buf.push(decoder.decode(value, { stream: true }))
      handle(r.events, r.malformed)
    }
    const tail = buf.flush()
    handle(tail.events, tail.malformed)
    if (!done) throw new Error(`voice: ${VOICE_STREAM_PATH} ended without a done line — the turn's outcome is unknown`)
    const d = done as Extract<VoiceStreamEvent, { type: 'done' }>
    return {
      status: d.status,
      transcript: d.transcript,
      speak: d.speak,
      full: d.full,
      audio_base64: null,
      audio_error: d.audio_error ?? null,
      stage_ms: d.stage_ms as BridgeVoiceResponse['stage_ms']
    }
  })

  // DICTATION (B6) — the STT-only sibling of a voice turn. Deliberately posts
  // to /bridge/transcribe, whose request model has NO session_id: dictation
  // cannot start a conversation even if this code were wrong (oara-voice#3).
  handleFromShell(IPC.VOICE_DICTATE, async (_e, args: VoiceTurnArgs): Promise<BridgeTranscribeResponse> => {
    const audioBase64 = typeof args?.audioBase64 === 'string' ? args.audioBase64 : ''
    if (audioBase64.length < 8) throw new Error('dictation rejected: no audio captured')
    const { baseUrl, token } = resolveOaraEndpoint()
    const res = await fetch(`${baseUrl}/bridge/transcribe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({
        audio_base64: audioBase64,
        audio_format: 'pcm16',
        sample_rate: VOICE_SAMPLE_RATE
      })
    })
    if (!res.ok) {
      const body = await safeText(res)
      // 404 is the SKEW case, not a generic failure: a voice bridge older than
      // oara-voice#3 has no /bridge/transcribe. Say so, or the user debugs
      // their microphone for an hour over a middleware that needs updating.
      if (res.status === 404) {
        throw new Error(
          'dictation unavailable: this OAra voice bridge has no /bridge/transcribe — update the middleware (oara-voice#3)'
        )
      }
      throw new Error(
        res.status === 401
          ? `dictation: oara auth FAILED (401) — check the oara integration token${body ? `: ${body}` : ''}`
          : `dictation: HTTP ${res.status} from /bridge/transcribe${body ? ` — ${body}` : ''}`
      )
    }
    return (await res.json()) as BridgeTranscribeResponse
  })

  handleFromShell(IPC.VOICE_TURN, async (_e, args: VoiceTurnArgs): Promise<BridgeVoiceResponse> => {
    const audioBase64 = typeof args?.audioBase64 === 'string' ? args.audioBase64 : ''
    if (audioBase64.length < 8) throw new Error('voice turn rejected: no audio captured')

    const { baseUrl, token } = resolveOaraEndpoint()
    const res = await fetch(`${baseUrl}/bridge/voice`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({
        session_id: VOICE_SESSION_ID,
        audio_base64: audioBase64,
        audio_format: 'pcm16',
        sample_rate: VOICE_SAMPLE_RATE,
        timeout_s: VOICE_TIMEOUT_S
      }),
      signal: AbortSignal.timeout((VOICE_TIMEOUT_S + 10) * 1000)
    })
    // 401 is the contract's named auth-failure state (v0.2 law) — carry the
    // daemon's own body into the error so the operator sees the reason.
    if (!res.ok) {
      const body = await safeText(res)
      throw new Error(
        res.status === 401
          ? `voice: oara auth FAILED (401) — check the oara integration token${body ? `: ${body}` : ''}`
          : `voice: HTTP ${res.status} from /bridge/voice${body ? ` — ${body}` : ''}`
      )
    }
    return (await res.json()) as BridgeVoiceResponse
  })
}
