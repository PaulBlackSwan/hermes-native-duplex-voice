import { describe, expect, it } from 'vitest'

import { createPcmAudio, decodePcm, encodePcm } from '../src/voice-pcm'

function playback() {
  const nodes: Array<{ onended: null | (() => void); stopped: boolean; start: number }> = []

  const context = {
    sampleRate: 24000,
    currentTime: 0,
    state: 'running',
    destination: {},
    close: async () => {},
    resume: async () => {},
    createBuffer: (_channels: number, length: number, rate: number) => ({
      duration: length / rate,
      getChannelData: () => new Float32Array(length)
    }),
    createBufferSource: () => {
      const node = {
        onended: null as null | (() => void),
        stopped: false,
        start: 0,
        connect() {},
        disconnect() {},
        startTime(time: number) {
          this.start = time
        },
        stop() {
          this.stopped = true
        }
      }

      nodes.push(node)

      return {
        ...node,
        start: (time: number) => {
          node.start = time
        },
        set onended(value: null | (() => void)) {
          node.onended = value
        },
        stop: () => {
          node.stopped = true
        },
        disconnect() {},
        connect() {}
      }
    }
  }

  const audio = createPcmAudio(() => context as unknown as AudioContext)

  return { audio, context, nodes }
}

describe('native Grok PCM', () => {
  it('accepts the observed chunk size while enforcing the unchanged wire budget', () => {
    expect(decodePcm('A'.repeat(182_032))).toHaveLength(68_262)
    expect(decodePcm('A'.repeat(256_000))).toHaveLength(96_000)
    expect(() => decodePcm('A'.repeat(256_004))).toThrow(/limite/)
    expect(() => decodePcm('not!base64')).toThrow()
    expect(() => decodePcm('AA==')).toThrow(/PCM16/)
  })

  it('encodes little-endian mono PCM16 with clipping', () => {
    expect([...decodePcm(encodePcm(new Float32Array([-2, 0, 2])))]).toEqual([-32768, 0, 32767])
    expect(() => decodePcm('AA==')).toThrow(/PCM/)
    expect(() => decodePcm('A'.repeat(256_004))).toThrow(/limite/)
  })

  it('queues a burst of small deltas without allocating one WebAudio source per delta', () => {
    const h = playback()
    expect(() => {
      for (let i = 0; i < 257; i++) {
        h.audio.player.play(new Int16Array(240))
      }
    }).not.toThrow()
    expect(h.nodes.length).toBeLessThanOrEqual(8)

    for (let i = 0; i < h.nodes.length; i++) {
      h.context.currentTime = (i + 1) / 100
      h.nodes[i].onended?.()
    }

    expect(h.nodes).toHaveLength(257)
    expect(h.nodes.at(-1)?.start).toBeCloseTo(2.56)
    expect(h.audio.player.diagnostics?.().queuedMs).toBeCloseTo(0)
    h.audio.close()
  })

  it('does not close a normal 11-second burst and still bounds memory at 30 seconds', () => {
    const h = playback()
    expect(() => {
      for (let i = 0; i < 11; i++) {
        h.audio.player.play(new Int16Array(24000))
      }
    }).not.toThrow()

    for (let i = 11; i < 30; i++) {
      h.audio.player.play(new Int16Array(24000))
    }

    expect(() => h.audio.player.play(new Int16Array(24000))).toThrow(/limite/)
    expect(h.nodes.every(node => node.stopped)).toBe(true)
    h.audio.player.play(new Int16Array(240))
    expect(h.nodes.at(-1)?.start).toBe(0)
    h.audio.close()
  })

  it('flushes waiting and active audio without scheduling stale onended callbacks', () => {
    const h = playback()

    for (let i = 0; i < 100; i++) {
      h.audio.player.play(new Int16Array(240))
    }

    const callbacks = h.nodes.map(node => node.onended)
    const count = h.nodes.length
    h.audio.player.flush()
    callbacks.forEach(fn => fn?.())
    expect(h.nodes).toHaveLength(count)
    h.audio.close()
  })

  it('refuses contexts that cannot deliver 24 kHz and closes them', () => {
    let closed = false

    const context = {
      sampleRate: 48000,
      close: async () => {
        closed = true
      }
    } as AudioContext

    expect(() => createPcmAudio(() => context)).toThrow(/24 kHz/)
    expect(closed).toBe(true)
  })
})
