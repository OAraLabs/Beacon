// Voice in Beacon is OAra Voice, and OAra Voice is not public. So the composer's voice controls
// (the Voice segment and the dictation button) exist only when the `oara` integration is
// configured. Without it they are ABSENT, not disabled: a fresh install must never offer voice it
// cannot deliver. Read-aloud is not gated. It speaks with the system's own voices and needs no OAra.
//
// ONE PREDICATE, TWO CALLERS. main's resolveOaraEndpoint refuses a voice request with it, and the
// VOICE_CONFIGURED answer that decides whether the renderer shows the controls comes from it. Two
// copies could disagree: a control shown that main refuses, or one hidden that would have worked.
//
// CHECK BEFORE THE MICROPHONE. A configured integration can still be broken (the host is down, the
// token is wrong). The microphone is asked for only after the integration has answered, so a broken
// setup never raises the OS microphone prompt for a feature that was always going to fail.

import type { IntegrationEntry } from './integrations'

export const OARA_INTEGRATION_ID = 'oara'

/** The oara entry when it is present AND enabled; null otherwise. */
export function oaraEntry(entries: readonly IntegrationEntry[]): IntegrationEntry | null {
  return entries.find((e) => e.id === OARA_INTEGRATION_ID && e.enabled) ?? null
}

export const VOICE_NOT_CONNECTED = 'voice unavailable: the oara integration is not connected'

/** How long the pre-microphone check waits for OAra Voice before calling it down. A tailnet host
 *  that is offline does not refuse, it just never answers, so the check needs a bound of its own. */
export const VOICE_CHECK_TIMEOUT_MS = 4000

/** The discovery endpoint every integration serves (contract §2). The check GETs it: an answer
 *  proves the bridge is up without recording or sending anything. */
export const OARA_CHECK_PATH = '/integration/manifest'

/** Shown while the check runs, so a slow answer is not a click that did nothing. */
export const VOICE_CHECKING_NOTICE = 'Checking OAra Voice…'

/** A network failure, in words. Reads Node's fetch (`cause.code`), `ws` (`code`, or its message),
 *  and AbortSignal.timeout (`TimeoutError`). */
export function unreachableCause(err: unknown, timeoutMs: number = VOICE_CHECK_TIMEOUT_MS): string {
  const e = err as { name?: unknown; code?: unknown; message?: unknown; cause?: { code?: unknown; name?: unknown } } | null
  const code = String(e?.code ?? e?.cause?.code ?? '')
  const name = String(e?.name ?? e?.cause?.name ?? '')
  const message = typeof e?.message === 'string' ? e.message : String(err)
  if (name === 'TimeoutError' || code === 'ETIMEDOUT' || /timed out/i.test(message)) {
    return `no answer within ${Math.round(timeoutMs / 1000)} s`
  }
  if (code === 'ECONNREFUSED') return 'connection refused'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'host not found'
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'EHOSTDOWN') return 'host unreachable'
  return code || message
}

/** The named refusal when the bridge does not answer. `host` is host:port, never a URL: the VAD URL
 *  carries the token. */
export function notAnsweringNotice(where: string, host: string, cause: string): string {
  return `OAra Voice is not answering at ${host} (${where}: ${cause}) — the microphone was not opened`
}

/** The named refusal when the bridge answers with an error status. */
export function badAnswerNotice(where: string, host: string, status: number): string {
  if (status === 401 || status === 403) {
    return `OAra Voice refused the token (${where} at ${host}: HTTP ${status}) — check the oara integration token; the microphone was not opened`
  }
  return `OAra Voice answered HTTP ${status} (${where} at ${host}) — the microphone was not opened`
}

const IPC_PREFIX = /^Error invoking remote method '[^']*': /
const ERROR_NAME = /^[A-Za-z]*Error: /

/**
 * The message of an error that crossed IPC, without Electron's wrapper. A rejected `invoke` arrives
 * as "Error invoking remote method 'vad:start': Error: <what main threw>", and the first half is
 * about the transport, not the problem. Anything that is not an Error gets `fallback`.
 */
export function ipcErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof Error) || !err.message) return fallback
  const m = err.message
  if (!IPC_PREFIX.test(m)) return m
  return m.replace(IPC_PREFIX, '').replace(ERROR_NAME, '') || fallback
}
