/**
 * Hands-free capture — renderer half (item 8).
 *
 * Unlike the push-to-talk capture (voice-capture.ts), the mic stays OPEN: every ScriptProcessor
 * buffer is resampled to 16 kHz and cut into exact 512-sample float32 chunks (the VAD service's
 * Silero window, mirrored from the Android streamer), which the caller ships to main over IPC.
 * Nothing is buffered here — the VAD service holds the utterance and returns it whole on
 * `speech_end`, so the renderer never accumulates audio.
 *
 * ScriptProcessorNode again (not AudioWorklet): CSP is script-src 'self' and a worklet would need
 * a separately served module; 4096 frames ≈ 85 ms of latency is fine for VAD framing.
 *
 * `stop()` releases the mic immediately — hands-free off means the light goes out.
 */

import { VadChunker } from '@shared/hands-free'

export interface HandsFreeCapture {
  stop(): void
  readonly contextRate: number
}

export async function startHandsFreeCapture(onChunk: (chunk: Float32Array) => void): Promise<HandsFreeCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
  })
  const ctx = new AudioContext()
  const source = ctx.createMediaStreamSource(stream)
  const proc = ctx.createScriptProcessor(4096, 1, 1)
  const chunker = new VadChunker(ctx.sampleRate)
  let stopped = false

  proc.onaudioprocess = (e) => {
    if (stopped) return
    for (const chunk of chunker.push(e.inputBuffer.getChannelData(0))) onChunk(chunk)
  }
  source.connect(proc)
  proc.connect(ctx.destination) // required for some platforms to fire onaudioprocess

  return {
    contextRate: ctx.sampleRate,
    stop() {
      if (stopped) return
      stopped = true
      proc.disconnect()
      source.disconnect()
      for (const t of stream.getTracks()) t.stop()
      void ctx.close().catch(() => undefined)
    }
  }
}
