/**
 * Voice turns — renderer capture half (feat/voice-turns).
 *
 * getUserMedia/AudioContext are RENDERER APIs — they cannot live in main
 * (spec v2 delta). ScriptProcessorNode is a deliberate choice over
 * AudioWorklet: the CSP is script-src 'self', and a worklet needs a
 * separately-served module file for zero latency gain on a push-to-talk
 * path where a few ms of capture latency is irrelevant.
 *
 * Output is float32 at the context rate; shared/voice.ts does the Int16/16k
 * conversion. The mic stream is stopped the moment capture stops — nothing
 * keeps listening between turns.
 */

export interface VoiceCapture {
  /** Resolves with float32 samples at `contextRate` (mono, downmixed). */
  stop(): Promise<{ samples: Float32Array; contextRate: number }>
  cancel(): void
}

/** Start a mic capture session. Throws on permission denial — the caller
 * renders that LOUD (a denied mic and a quiet room must not look alike). */
export async function startVoiceCapture(): Promise<VoiceCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
  })
  const ctx = new AudioContext()
  const source = ctx.createMediaStreamSource(stream)
  // 4096 frames ≈ 85ms at 48k — small enough that the final buffer boundary
  // never eats a meaningful slice of a turn.
  const proc = ctx.createScriptProcessor(4096, 1, 1)
  const chunks: Float32Array[] = []
  let stopped = false

  proc.onaudioprocess = (e) => {
    if (stopped) return
    const ch = e.inputBuffer.getChannelData(0)
    chunks.push(new Float32Array(ch)) // copy — the buffer is reused
  }
  source.connect(proc)
  proc.connect(ctx.destination) // required for some platforms to fire onaudioprocess

  const teardown = (): void => {
    stopped = true
    proc.disconnect()
    source.disconnect()
    for (const t of stream.getTracks()) t.stop()
    void ctx.close().catch(() => undefined)
  }

  const flatten = (): { samples: Float32Array; contextRate: number } => {
    const total = chunks.reduce((n, c) => n + c.length, 0)
    const out = new Float32Array(total)
    let off = 0
    for (const c of chunks) {
      out.set(c, off)
      off += c.length
    }
    return { samples: out, contextRate: ctx.sampleRate }
  }

  return {
    async stop() {
      const result = flatten()
      teardown()
      return result
    },
    cancel() {
      teardown()
    }
  }
}
