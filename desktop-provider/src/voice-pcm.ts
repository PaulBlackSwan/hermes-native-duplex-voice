// PCM capture/playback adapted from hermes-xai by Julien Talbot (MIT; see LICENSE).
/** Full MIT notice for the adapted implementation: ./voice-grok.LICENSE. */
export interface PcmPlaybackSnapshot {
  contextState: string
  audioTime: number
  queuedMs: number
  sources: number
  waitingFrames: number
}

export class PcmPlaybackOverflow extends Error {
  constructor(readonly snapshot: PcmPlaybackSnapshot) {
    super('File de lecture audio hors limite')
    this.name = 'PcmPlaybackOverflow'
  }
}

export interface PcmAudio {
  player: {
    resume(): Promise<void>
    play(pcm: Int16Array): void
    flush(): void
    close(): void
    /** Includes both scheduled sources and the bounded unscheduled backlog. */
    hasPending(): boolean
    /** Natural full drain only; flush/close must not emit a stale completion. */
    onDrained?: () => void
    diagnostics?(): PcmPlaybackSnapshot
  }
  startMic(onFrame: (frame: Float32Array) => void): Promise<() => void>
  setMuted(muted: boolean): void
  close(): void
}

export const RATE = 24000

const WORKLET = `
class Pcm24k extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch && ch.length) this.port.postMessage(ch.slice(0))
    return true
  }
}
registerProcessor('hermes-grok-pcm', Pcm24k)
`

export function encodePcm(frame: Float32Array): string {
  if (frame.length > RATE) {
    throw new Error('Trame PCM hors limite')
  }

  const bytes = new Uint8Array(frame.length * 2)
  const view = new DataView(bytes.buffer)

  for (let i = 0; i < frame.length; i++) {
    const sample = Math.max(-1, Math.min(1, frame[i]))
    view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
  }

  let binary = ''

  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }

  return btoa(binary)
}

export function decodePcm(text: string): Int16Array {
  // Match the existing 256k-character realtime message budget. A valid chunk can
  // exceed 128k characters; PCM16 validation and the 30-second player bound remain.
  if (text.length > 256_000) {
    throw new Error('Audio PCM hors limite')
  }

  const binary = atob(text)

  if (binary.length % 2) {
    throw new Error('Audio PCM16 invalide')
  }

  const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0))
  const view = new DataView(bytes.buffer)
  const pcm = new Int16Array(bytes.length >> 1)

  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = view.getInt16(i * 2, true)
  }

  return pcm
}

/** One context unlocked in the user gesture serves capture AND playback. */
export function createPcmAudio(makeContext = () => new AudioContext({ sampleRate: RATE })): PcmAudio {
  const context = makeContext()

  if (context.sampleRate !== RATE) {
    void context.close()
    throw new Error('Fréquence audio 24 kHz indisponible')
  }

  let closed = false
  let muted = false
  let next = 0
  let stream: MediaStream | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let worklet: AudioWorkletNode | null = null
  let mute: GainNode | null = null
  const live = new Set<AudioBufferSourceNode>()
  const playbackQueue: Int16Array[] = []
  let waitingSamples = 0

  function diagnostics(): PcmPlaybackSnapshot {
    return {
      contextState: context.state,
      audioTime: context.currentTime,
      queuedMs: (Math.max(0, next - context.currentTime) + waitingSamples / RATE) * 1000,
      sources: live.size,
      waitingFrames: playbackQueue.length
    }
  }

  function flush() {
    playbackQueue.length = 0
    waitingSamples = 0
    live.forEach(node => {
      node.onended = null

      try {
        node.stop()
      } catch {
        /* already ended */
      }

      node.disconnect()
    })
    live.clear()
    next = 0
  }

  // A burst of tiny xAI deltas must not allocate hundreds of WebAudio sources.
  // Keep a bounded PCM backlog and refill a small scheduling window as it plays.
  function pump() {
    while (!closed && playbackQueue.length && live.size < 8) {
      const pcm = playbackQueue.shift()!
      waitingSamples -= pcm.length
      const buffer = context.createBuffer(1, pcm.length, RATE)
      const ch = buffer.getChannelData(0)

      for (let i = 0; i < pcm.length; i++) {
        ch[i] = pcm[i] / 0x8000
      }

      const node = context.createBufferSource()
      node.buffer = buffer
      node.connect(context.destination)
      next = Math.max(next, context.currentTime)
      live.add(node)

      node.onended = () => {
        if (!live.delete(node)) {
          return
        }

        node.disconnect()

        try {
          pump()

          // Refill first: an empty scheduling slot is not a full playback drain.
          if (!closed && !hasPending()) {
            next = 0
            player.onDrained?.()
          }
        } catch {
          flush()
          console.error('[grok-live-diagnostic] {"event":"playback_pump_error"}')
        }
      }

      node.start(next)
      next += buffer.duration
    }
  }

  function stopMic() {
    if (worklet) {
      worklet.port.onmessage = null
      worklet.disconnect()
      worklet = null
    }

    source?.disconnect()
    source = null
    mute?.disconnect()
    mute = null
    stream?.getTracks().forEach(track => track.stop())
    stream = null
  }

  function close() {
    if (closed) {
      return
    }

    closed = true
    stopMic()
    flush()
    void context.close().catch(() => {})
  }

  function hasPending() {
    return live.size > 0 || playbackQueue.length > 0
  }

  const player: PcmAudio['player'] = {
    hasPending,
    resume: () => context.resume(),
    play(pcm: Int16Array) {
      if (closed || !pcm.length) {
        return
      }

      if (diagnostics().queuedMs + (pcm.length / RATE) * 1000 > 30_000.001 || playbackQueue.length >= 4096) {
        const snapshot = diagnostics()
        flush()
        throw new PcmPlaybackOverflow(snapshot)
      }

      playbackQueue.push(pcm)
      waitingSamples += pcm.length
      pump()
    },
    diagnostics,
    flush,
    close
  }

  return {
    player,
    close,
    setMuted(value) {
      muted = value
      stream?.getAudioTracks().forEach(track => {
        track.enabled = !value
      })
    },
    async startMic(onFrame) {
      const acquired = await navigator.mediaDevices.getUserMedia({
        audio: { autoGainControl: true, echoCancellation: true, noiseSuppression: true }
      })

      if (closed) {
        acquired.getTracks().forEach(track => track.stop())
        throw new Error('Appel annulé')
      }

      stream = acquired
      stream.getAudioTracks().forEach(track => {
        track.enabled = !muted
      })
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }))

      try {
        await context.audioWorklet.addModule(url)

        if (closed) {
          throw new Error('Appel annulé')
        }

        if (context.sampleRate !== RATE) {
          throw new Error('Fréquence audio 24 kHz indisponible')
        }

        const node = new AudioWorkletNode(context, 'hermes-grok-pcm')
        worklet = node
        let pending: Float32Array[] = []
        let size = 0

        node.port.onmessage = ({ data }: MessageEvent<Float32Array>) => {
          if (closed || muted) {
            return
          }

          if (!(data instanceof Float32Array) || data.length > RATE / 10) {
            return
          }

          pending.push(data)
          size += data.length

          if (size < RATE / 10) {
            return
          }

          const frame = new Float32Array(size)
          let at = 0

          for (const part of pending) {
            frame.set(part, at)
            at += part.length
          }

          pending = []
          size = 0
          onFrame(frame)
        }

        source = context.createMediaStreamSource(stream)
        source.connect(node)
        // Keep the worklet pulled by Safari as well as Chromium; never monitor the mic.
        mute = context.createGain()
        mute.gain.value = 0
        node.connect(mute)
        mute.connect(context.destination)

        return stopMic
      } catch (error) {
        stopMic()
        throw error
      } finally {
        URL.revokeObjectURL(url)
      }
    }
  }
}
