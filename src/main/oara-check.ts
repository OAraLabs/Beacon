// The pre-microphone check of the OAra bridge (@shared/voice-gate). A module of its own, free of
// Electron and of ./shell-windows, for the reason ./vad-socket gives: voice-gate-smoke imports it.

import {
  OARA_CHECK_PATH,
  VOICE_CHECK_TIMEOUT_MS,
  badAnswerNotice,
  notAnsweringNotice,
  unreachableCause
} from '@shared/voice-gate'

/**
 * The check that runs BEFORE the microphone is asked for: GET the bridge's discovery endpoint and
 * require a 2xx. Down, unreachable, silent past the timeout, or answering with an error → a named
 * refusal, and the renderer never opens the mic. Records nothing and sends no audio.
 *
 * Takes its inputs so the smoke can aim it at servers it controls; the handler passes the real ones.
 */
export async function checkOaraBridge(
  baseUrl: string,
  token: string | null,
  timeoutMs: number = VOICE_CHECK_TIMEOUT_MS
): Promise<void> {
  const host = new URL(baseUrl).host
  let res: Response
  try {
    res = await fetch(`${baseUrl}${OARA_CHECK_PATH}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (err) {
    throw new Error(notAnsweringNotice('bridge', host, unreachableCause(err, timeoutMs)))
  }
  await res.body?.cancel().catch(() => undefined)
  if (!res.ok) throw new Error(badAnswerNotice('bridge', host, res.status))
}
