// Transport/audio adapted from Julien Talbot's hermes-xai (MIT; ./voice-grok.LICENSE).
import { createPcmAudio, decodePcm, encodePcm, type PcmAudio, PcmPlaybackOverflow } from './voice-pcm'

export interface GrokOwner {
  connectionId: string | null
  profile: string | null
}
export interface GrokScope {
  sessionId: string
  owner: GrokOwner
}
export interface GrokStartOptions extends GrokScope {
  config?: Record<string, unknown>
}
export type GrokStatus = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error'
export interface GrokMint {
  endpoint: string
  subprotocol: string
  client_secret: { value: string; expires_at: number }
  session_update: Record<string, unknown>
}
export interface GrokCompletion extends GrokScope {
  type: string
  payload?: {
    text?: string
    /** Canonical authority identity; never synthesize a client_turn_id or a persisted row. */
    admission_id?: string
    status?: string
    outcome?: string
    persisted_turn?: { user_row_id?: number; complete?: boolean; submission_id?: string }
  }
}
/** Bind this bridge to the captured gateway, NEVER an ambient requestGateway getter. */
export interface GrokBridge {
  mint(scope: GrokScope, config?: Record<string, unknown>): Promise<GrokMint>
  isCurrent(scope: GrokScope): boolean
  isBusy(scope: GrokScope): Promise<boolean>
  submit(
    scope: GrokScope,
    text: string,
    options: { queued: true; context: string }
  ): Promise<{ status?: string; user_row_id?: number; admission_id?: string }>
  subscribe(scope: GrokScope, listener: (event: GrokCompletion) => void): () => void
}
export interface GrokHandlers {
  onStatus?: (status: GrokStatus) => void
  onError: (message: string, fatal: boolean) => void
  onClosed: (reason: string, usageSeconds: null | number) => void
  onNotice?: (message: string) => void
  onTranscript?: (fragment: { speaker: 'user' | 'assistant'; text: string; startMs: number; endMs: number }) => void
  onSpeakingChange?: (speaking: boolean) => void
  onLevel?: (level: number) => void
}
export interface GrokSocket {
  readyState: number
  bufferedAmount: number
  onopen: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
  onclose: ((event: CloseEvent) => void) | null
  onerror: ((event: Event) => void) | null
  send(data: string): void
  close(): void
}
export interface GrokFactories {
  audio(): PcmAudio
  socket(url: string, protocols: string[]): GrokSocket
}
const defaults: GrokFactories = { audio: createPcmAudio, socket: (url, protocols) => new WebSocket(url, protocols) }

function canonicalAdmission(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value
    ? value
    : undefined
}

interface PendingTask {
  row?: number
  admission?: string
  admitting: boolean
  outputSent: boolean
  timer: ReturnType<typeof setTimeout>
}

export class GrokLiveSession {
  status: GrokStatus = 'idle'
  private generation = 0
  private scope: GrokScope | null = null
  private socket: GrokSocket | null = null
  private audio: PcmAudio | null = null
  private releaseMic: (() => void) | null = null
  private unsubscribe: (() => void) | null = null
  private connectTimer?: ReturnType<typeof setTimeout>
  private muted = false
  private micStarting = false
  private pending = new Set<PendingTask>()
  private early: Array<{ row?: number; admission?: string; text: string; time: number }> = []
  private seenTools = new Set<string>()
  private activeResponse: string | null = null
  private interrupted = new Set<string>()
  private cancelEvents = new Set<string>()
  private cancelSequence = 0
  private suppressAudio = false
  private interruptBarrier = false
  private userSpeaking = false
  private requireResponseIds = false
  private responding = false
  private requestOwed = false
  private resultReading = false
  private results: string[] = []
  private transcript: string[] = []
  private startedAt = 0
  private diagnosticBudget = 24
  private reportedUntagged = false

  /** Only fixed categories and bounded numeric metadata reach desktop.log.
   * Never pass an event, raw exception, identifier, transcript or token to console.
   */
  private diagnose(
    event:
      | 'handler_error'
      | 'playback_backlog'
      | 'transport_closed'
      | 'transport_error'
      | 'provider_error'
      | 'untagged_delta'
      | 'connect_timeout'
      | 'task_submitting'
      | 'task_admitted',
    error?: unknown,
    eventType?: unknown,
    payloadChars?: unknown
  ): void {
    if (this.diagnosticBudget-- <= 0) {
      return
    }

    try {
      const snapshot = error instanceof PcmPlaybackOverflow ? error.snapshot : this.audio?.player.diagnostics?.()

      const bounded = (value: unknown) =>
        typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1e9, Math.round(value))) : null

      const state = ['running', 'suspended', 'interrupted', 'closed'].includes(snapshot?.contextState ?? '')
        ? snapshot!.contextState
        : 'unknown'

      const kind =
        error instanceof PcmPlaybackOverflow
          ? 'backlog'
          : error instanceof Error &&
              ['InvalidCharacterError', 'NotSupportedError', 'InvalidStateError', 'NotAllowedError'].includes(
                error.name
              )
            ? error.name
            : 'unspecified'

      const classifiedKind =
        error instanceof Error
          ? (new Map([
              ['Audio PCM hors limite', 'pcm_frame_limit'],
              ['Audio PCM16 invalide', 'pcm_odd_length'],
              ['Audio socket hors limite', 'socket_backpressure'],
              ['Trame PCM hors limite', 'mic_frame_limit']
            ]).get(error.message) ?? kind)
          : kind

      const knownTypes = [
        'session.updated',
        'input_audio_buffer.speech_started',
        'input_audio_buffer.speech_stopped',
        'response.created',
        'response.output_audio.delta',
        'response.audio.delta',
        'response.function_call_arguments.done',
        'conversation.item.input_audio_transcription.completed',
        'response.output_audio_transcript.done',
        'response.audio_transcript.done',
        'response.done',
        'error'
      ]

      const safeType =
        eventType === undefined ? 'none' : knownTypes.includes(String(eventType)) ? String(eventType) : 'other'

      const errorClass =
        error instanceof Error
          ? [
              'Error',
              'TypeError',
              'RangeError',
              'DOMException',
              'InvalidCharacterError',
              'NotSupportedError',
              'InvalidStateError',
              'NotAllowedError'
            ].includes(error.name)
            ? error.name
            : 'other'
          : 'none'

      // Extract only numeric coordinates. Never persist a raw stack or URL.
      const frame =
        error instanceof Error && typeof error.stack === 'string'
          ? error.stack
              .split('\n')
              .slice(1)
              .map(line => line.match(/:(\d+):(\d+)\)?$/))
              .find(Boolean)
          : null

      console.error(
        '[grok-live-diagnostic] ' +
          JSON.stringify({
            build: 'native-duplex-0.2.0-rc.1',
            event,
            kind: classifiedKind,
            eventType: safeType,
            errorClass,
            frameLine: bounded(frame ? Number(frame[1]) : null),
            frameColumn: bounded(frame ? Number(frame[2]) : null),
            payloadChars: bounded(payloadChars),
            socketBufferedBytes: bounded(this.socket?.bufferedAmount),
            elapsedMs: bounded(Date.now() - this.startedAt),
            contextState: state,
            audioTimeMs: bounded((snapshot?.audioTime ?? 0) * 1000),
            queuedMs: bounded(snapshot?.queuedMs),
            sources: bounded(snapshot?.sources),
            waitingFrames: bounded(snapshot?.waitingFrames)
          })
      )
    } catch {
      // Diagnostics must never change the call's behavior.
    }
  }

  constructor(
    private bridge: GrokBridge,
    private handlers: GrokHandlers,
    private factories: GrokFactories = defaults
  ) {}

  private setStatus(status: GrokStatus) {
    // Provider generation completion is independent of local audible playback.
    if ((status === 'listening' || status === 'thinking') && this.audio?.player.hasPending()) {
      status = 'speaking'
    }

    this.status = status
    this.handlers.onStatus?.(status)
    this.handlers.onSpeakingChange?.(status === 'speaking')
  }
  private current(token = this.generation): boolean {
    if (token !== this.generation || !this.scope) {
      return false
    }

    if (!this.bridge.isCurrent(this.scope)) {
      this.end('owner_changed')

      return false
    }

    return true
  }
  checkOwner(): void {
    this.current()
  }
  private send(event: object): boolean {
    if (!this.socket || this.socket.readyState !== 1) {
      return false
    }

    if (this.socket.bufferedAmount > 512_000) {
      throw new Error('Audio socket hors limite')
    }

    this.socket.send(JSON.stringify(event))

    return true
  }
  async start(options: GrokStartOptions): Promise<void> {
    if (this.status !== 'idle' && this.status !== 'error') {
      return
    }

    const token = ++this.generation
    this.startedAt = Date.now()
    this.diagnosticBudget = 24
    this.reportedUntagged = false
    this.scope = { sessionId: options.sessionId, owner: { ...options.owner } }
    this.setStatus('connecting')
    this.connectTimer = setTimeout(() => {
      if (this.current(token)) {
        this.diagnose('connect_timeout')
        this.fail('Délai de connexion Grok Voice dépassé.')
      }
    }, 30_000)

    try {
      const audio = this.factories.audio()
      this.audio = audio

      audio.player.onDrained = () => {
        if (this.audio === audio && this.current(token) && !audio.player.hasPending() && this.status === 'speaking') {
          this.setStatus('listening')
        }
      }

      audio.setMuted(this.muted)
      await audio.player.resume()

      if (!this.current(token)) {
        return
      }

      const minted = await this.bridge.mint(this.scope!, options.config)

      if (!this.current(token)) {
        return
      }

      // A minted secret may only leave this renderer for the fixed xAI endpoint.
      if (
        minted.endpoint !== 'wss://api.x.ai/v1/realtime' ||
        minted.subprotocol !== 'xai-client-secret.' ||
        !/^[A-Za-z0-9_.~-]{1,4096}$/.test(minted.client_secret.value) ||
        !Number.isFinite(minted.client_secret.expires_at) ||
        minted.client_secret.expires_at <= Date.now() / 1000 ||
        minted.client_secret.expires_at > Date.now() / 1000 + 3600
      ) {
        throw new Error('Session Grok Voice invalide.')
      }

      const socket = this.factories.socket(minted.endpoint, [minted.subprotocol + minted.client_secret.value])
      this.socket = socket
      this.unsubscribe = this.bridge.subscribe(this.scope!, event => {
        if (this.current(token)) {
          try {
            this.complete(event)
          } catch {
            this.fail('Livraison vocale indisponible. Consultez le chat.')
          }
        }
      })

      socket.onopen = () => {
        if (this.current(token)) {
          try {
            this.send(minted.session_update)
          } catch {
            this.fail('Connexion Grok Voice indisponible.')
          }
        }
      }

      socket.onmessage = ({ data }) => {
        if (!this.current(token)) {
          return
        }

        if (typeof data !== 'string' || data.length > 256_000) {
          this.fail('Message Grok Voice hors limite.')

          return
        }

        try {
          const event = JSON.parse(data)

          if (event && typeof event.type === 'string') {
            void this.handle(event, token).catch(error => {
              if (this.current(token)) {
                this.diagnose(
                  'handler_error',
                  error,
                  event.type,
                  typeof event.delta === 'string' ? event.delta.length : undefined
                )
                this.fail('Audio Grok Voice indisponible.')
              }
            })
          }
        } catch {
          this.fail('Message Grok Voice invalide.')
        }
      }

      socket.onerror = () => {
        if (this.current(token)) {
          this.diagnose('transport_error')
          this.fail('Connexion Grok Voice indisponible.')
        }
      }

      socket.onclose = () => {
        if (this.current(token)) {
          this.diagnose('transport_closed')
          this.end('transport_closed')
        }
      }
    } catch (error) {
      if (this.current(token)) {
        this.fail(
          error instanceof Error && error.message === 'Fréquence audio 24 kHz indisponible'
            ? 'Fréquence audio 24 kHz indisponible. Grok Voice nécessite PCM16 mono 24 kHz.'
            : 'Grok Voice indisponible. Vérifiez le microphone et la connexion OAuth.'
        )
      }
    }
  }
  private async handle(event: Record<string, any>, token: number): Promise<void> {
    if (event.type === 'session.updated' && !this.micStarting) {
      this.micStarting = true

      const release = await this.audio!.startMic(frame => {
        if (!this.current(token) || this.muted) {
          return
        }

        try {
          this.send({ type: 'input_audio_buffer.append', audio: encodePcm(frame) })
          let energy = 0

          for (const sample of frame) {
            energy += sample * sample
          }

          this.handlers.onLevel?.(frame.length ? Math.min(1, Math.sqrt(energy / frame.length)) : 0)
        } catch {
          this.fail('Flux audio hors limite.')
        }
      })

      if (!this.current(token)) {
        release()

        return
      }

      this.releaseMic = release
      clearTimeout(this.connectTimer)
      this.setStatus('listening')
    }

    switch (event.type) {
      case 'input_audio_buffer.speech_started':
        this.userSpeaking = true
        // xAI server_vad cancels generation automatically; do not cancel Hermes.
        this.interrupt(false)

        break

      case 'input_audio_buffer.speech_stopped':
        // The server boundary orders the new utterance after any in-flight response.
        this.userSpeaking = false
        this.interruptBarrier = false

        break

      case 'response.created':
        this.activeResponse = typeof event.response?.id === 'string' ? event.response.id : null

        if (this.interruptBarrier && this.activeResponse) {
          this.rejectResponse(this.activeResponse)
        }

        this.suppressAudio =
          this.interruptBarrier || (!!this.activeResponse && this.interrupted.has(this.activeResponse))
        this.responding = true

        if (!this.suppressAudio) {
          this.setStatus('thinking')
        }

        break

      case 'response.output_audio.delta':

      case 'response.audio.delta':
        if (this.requireResponseIds && !event.response_id && !this.reportedUntagged) {
          this.reportedUntagged = true
          this.diagnose('untagged_delta')
        }

        if (
          this.suppressAudio ||
          (this.requireResponseIds && !event.response_id) ||
          (event.response_id && (this.interrupted.has(event.response_id) || event.response_id !== this.activeResponse))
        ) {
          break
        }

        if (typeof event.delta === 'string') {
          try {
            this.audio!.player.play(decodePcm(event.delta))
          } catch (error) {
            if (!(error instanceof PcmPlaybackOverflow)) {
              throw error
            }

            this.diagnose('playback_backlog', error)
            this.interrupt(true)
            this.handlers.onNotice?.(
              'Lecture audio interrompue pour rattraper le retard. L’appel reste actif ; vous pouvez reparler.'
            )

            break
          }

          if (this.audio!.player.hasPending()) {
            this.setStatus('speaking')
          }
        }

        break

      case 'response.function_call_arguments.done':
        await this.tool(event, token)

        break

      case 'conversation.item.input_audio_transcription.completed':
        this.remember('user', event.transcript)

        break

      case 'response.output_audio_transcript.done':

      case 'response.audio_transcript.done':
        if (!this.suppressAudio && (!event.response_id || event.response_id === this.activeResponse)) {
          this.remember('assistant', event.transcript)
        }

        break

      case 'response.done':
        if (event.response?.id && this.activeResponse && event.response.id !== this.activeResponse) {
          break
        }

        this.responding = false

        if (this.resultReading) {
          if (
            this.suppressAudio ||
            this.interrupted.has(event.response?.id) ||
            event.response?.status === 'cancelled'
          ) {
            // Reuse the result already in Grok's conversation; never resubmit Hermes.
            this.requestOwed = true
          } else {
            this.resultReading = false
          }
        }

        if (!this.userSpeaking && (!this.interruptBarrier || this.interrupted.has(event.response?.id))) {
          this.interruptBarrier = false
        }

        this.activeResponse = null
        this.setStatus('listening')
        this.flushResults()

        break

      case 'error':
        this.diagnose('provider_error')

        // xAI documents recoverable errors, but not this specific code publicly.
        // Limit the compatibility exception to a cancel we actually sent; never
        // infer recoverability from an open socket or provider message text.
        if (
          event.error?.code === 'response_cancel_not_active' &&
          event.error?.type === 'invalid_request_error' &&
          this.cancelEvents.delete(event.error?.event_id) &&
          this.socket?.readyState === 1
        ) {
          this.handlers.onNotice?.('La réponse vocale était déjà arrêtée. L’appel reste actif.')

          if (!this.activeResponse) {
            this.responding = false
            this.interruptBarrier = this.userSpeaking
            this.flushResults()
          }

          break
        }

        this.fail('Grok Voice a signalé une erreur. Réessayez l’appel.')

        break
    }
  }
  private remember(speaker: 'user' | 'assistant', text: unknown): void {
    if (typeof text !== 'string' || !text.trim()) {
      return
    }

    const clean = text.trim().slice(0, 3000)
    this.transcript.push(`${speaker}: ${clean}`)
    this.transcript = this.transcript.slice(-12)
    this.handlers.onTranscript?.({ speaker, text: clean, startMs: 0, endMs: 0 })
  }
  private output(callId: string, result: object): void {
    this.send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) }
    })
    this.requestOwed = true
    this.flushResults()
  }
  private flushResults(): void {
    if (this.responding || this.interruptBarrier || this.userSpeaking) {
      return
    }

    if (this.results.length) {
      const text = this.results.splice(0).join('\n\n')
      this.send({
        type: 'conversation.item.create',
        item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `[Hermes result] ${text}` }] }
      })
      this.requestOwed = true
      this.resultReading = true
    }

    if (this.requestOwed) {
      this.requestOwed = false
      this.send({ type: 'response.create' })
      this.responding = true
      this.setStatus('thinking')
    }
  }
  private notice(message: string): void {
    this.handlers.onNotice?.(message)

    if (this.results.length >= 32) {
      this.fail('Trop de résultats vocaux. Consultez le chat.')

      return
    }

    this.results.push(message.slice(0, 3000))
    this.flushResults()
  }
  private clearPending(task?: PendingTask): void {
    for (const pending of task ? [task] : this.pending) {
      clearTimeout(pending.timer)
      this.pending.delete(pending)
    }

    if (!this.pending.size) {
      this.early = []
    }
  }
  private complete(event: GrokCompletion): void {
    const scope = this.scope
    const payload = event.payload
    const row = payload?.persisted_turn?.user_row_id
    const admission = canonicalAdmission(payload?.admission_id)

    const canonicalTerminal =
      admission !== undefined &&
      ((payload?.status === 'complete' && payload.outcome === 'completed') ||
        (payload?.status === 'error' && payload.outcome === 'failed') ||
        (payload?.status === 'interrupted' && payload.outcome === 'cancelled'))

    const persisted = Number.isSafeInteger(row) && row! > 0 && payload?.persisted_turn?.complete === true

    if (
      !this.pending.size ||
      !scope ||
      event.type !== 'message.complete' ||
      event.sessionId !== scope.sessionId ||
      event.owner.connectionId !== scope.owner.connectionId ||
      event.owner.profile !== scope.owner.profile ||
      (!canonicalTerminal && !persisted)
    ) {
      return
    }

    const text =
      canonicalTerminal && payload?.status !== 'complete'
        ? 'La tâche Hermes n’a pas terminé normalement. Consultez le chat pour son état exact.'
        : payload?.text?.trim().slice(0, 3000) || 'Hermes a terminé sans résultat à lire.'

    const pending = [...this.pending].find(task =>
      task.admission ? canonicalTerminal && admission === task.admission : persisted && row === task.row
    )

    if (!pending && [...this.pending].some(task => task.row === undefined && task.admission === undefined)) {
      this.early = this.early.filter(item => Date.now() - item.time < 10_000)

      if (
        this.early.length < 16 &&
        !this.early.some(item => (admission ? item.admission === admission : item.row === row))
      ) {
        this.early.push({
          row: persisted ? row : undefined,
          admission: canonicalTerminal ? admission : undefined,
          text,
          time: Date.now()
        })
      }

      return
    }

    if (!pending) {
      return
    }

    this.clearPending(pending)
    this.notice(text)
  }
  private async tool(event: Record<string, any>, token: number): Promise<void> {
    const id = event.call_id

    if (typeof id !== 'string' || !id || id.length > 256 || this.seenTools.has(id)) {
      return
    }

    if (this.seenTools.size >= 256) {
      this.fail('Limite d’outils vocaux atteinte.')

      return
    }

    this.seenTools.add(id)

    if (event.name === 'end_call') {
      this.output(id, { ok: true })
      this.end('end_call')

      return
    }

    let request: unknown

    try {
      request = JSON.parse(event.arguments).request
    } catch {
      /* invalid below */
    }

    if (event.name !== 'hermes_task' || typeof request !== 'string' || !request.trim() || request.length > 6000) {
      this.output(id, { ok: false, error: 'Requête vocale invalide.' })

      return
    }

    if ([...this.pending].some(task => task.admitting)) {
      this.output(id, {
        ok: false,
        error: 'Une admission Hermes attend confirmation. Ne resoumettez pas cette demande.'
      })

      return
    }

    if (this.pending.size + this.results.length >= 32) {
      this.output(id, { ok: false, error: 'Limite de tâches vocales en attente atteinte. Consultez le chat.' })

      return
    }

    // Reserve before the first await: two simultaneous tool events cannot submit twice.
    const pending: PendingTask = {
      admitting: true,
      outputSent: false,
      row: undefined as number | undefined,
      admission: undefined as string | undefined,
      timer: setTimeout(() => {
        if (!this.current(token) || !this.pending.has(pending)) {
          return
        }

        const unconfirmed = pending.row === undefined && pending.admission === undefined
        pending.admitting = false

        if (unconfirmed && !pending.outputSent) {
          pending.outputSent = true
          this.output(id, {
            ok: null,
            receipt: 'unknown',
            note: 'Réception non confirmée à temps. Ne resoumettez pas cette demande ; consultez le chat, le travail peut continuer.'
          })
        }

        this.handlers.onNotice?.('Hermes peut encore travailler. Le résultat reste attendu ; consultez aussi le chat.')
      }, 120_000)
    }

    this.pending.add(pending)
    const scope = this.scope!

    try {
      const busy = await this.bridge.isBusy(scope)

      if (!this.current(token) || !this.pending.has(pending)) {
        return
      }

      if (busy) {
        this.clearPending(pending)
        this.output(id, { ok: false, error: 'Hermes est occupé. Réessayez après la tâche en cours.' })

        return
      }

      this.diagnose('task_submitting')

      const receipt = await this.bridge.submit(scope, request.trim(), {
        queued: true,
        context: this.transcript.join('\n')
      })

      if (!this.current(token) || !this.pending.has(pending)) {
        return
      }

      const admission = ['queued', 'started', 'terminal', 'unknown'].includes(receipt.status ?? '')
        ? canonicalAdmission(receipt.admission_id)
        : undefined

      if (
        receipt.status === 'queued' &&
        !admission &&
        (!Number.isSafeInteger(receipt.user_row_id) || receipt.user_row_id! <= 0)
      ) {
        // A legacy busy queue without either receipt is accepted, but chat-only.
        this.clearPending(pending)

        if (!pending.outputSent) {
          this.output(id, {
            ok: true,
            receipt: 'queued',
            note: 'Demande acceptée en attente dans le chat. Résultat vocal non corrélable ; consultez le chat.'
          })
        }

        return
      }

      if (
        !admission &&
        (!['streaming', 'queued'].includes(receipt.status ?? '') ||
          !Number.isSafeInteger(receipt.user_row_id) ||
          receipt.user_row_id! <= 0)
      ) {
        this.clearPending(pending)

        if (!pending.outputSent) {
          this.output(id, {
            ok: false,
            note: 'Réception non corrélable. Consultez le chat avant de réessayer ; la demande peut avoir été acceptée.'
          })
        }

        return
      }

      this.diagnose('task_admitted')
      pending.row = receipt.user_row_id
      pending.admission = admission
      pending.admitting = false

      if (!pending.outputSent) {
        pending.outputSent = true
        this.output(id, {
          ok: receipt.status === 'unknown' ? null : true,
          receipt: receipt.status,
          note:
            receipt.status === 'unknown'
              ? 'Réception ambiguë. Ne resoumettez pas cette demande ; consultez le chat. Le résultat reste attendu.'
              : receipt.status === 'queued'
                ? 'Demande acceptée en attente, visible dans le chat.'
                : 'Demande acceptée. Résultat attendu, également disponible dans le chat.'
        })
      }

      const early = this.early.find(
        item =>
          (pending.admission ? item.admission === pending.admission : item.row === pending.row) &&
          Date.now() - item.time < 10_000
      )

      if (early) {
        this.early = this.early.filter(item => item !== early)
        this.clearPending(pending)
        this.notice(early.text)
      }
    } catch {
      if (!this.current(token) || !this.pending.has(pending)) {
        return
      }

      this.clearPending(pending)

      if (!pending.outputSent) {
        this.output(id, {
          ok: null,
          note: 'Réception non confirmée. Consultez le chat avant de réessayer ; le travail peut continuer.'
        })
      }
    }
  }
  private rejectResponse(id: string): void {
    this.interrupted.add(id)

    if (this.interrupted.size > 64) {
      this.interrupted.delete(this.interrupted.values().next().value!)
    }
  }

  private interrupt(manual: boolean): void {
    this.audio?.player.flush()
    this.interruptBarrier = true

    if (this.activeResponse) {
      this.rejectResponse(this.activeResponse)
    }

    this.suppressAudio = true
    this.requireResponseIds = true

    if (manual && this.responding) {
      const eventId = `grok-cancel-${++this.cancelSequence}`
      this.cancelEvents.add(eventId)

      if (this.cancelEvents.size > 64) {
        this.cancelEvents.delete(this.cancelEvents.values().next().value!)
      }

      this.send({ type: 'response.cancel', event_id: eventId })
    }

    if (this.scope) {
      this.setStatus('listening')
    }
  }
  setMuted(muted: boolean): void {
    this.muted = muted
    this.audio?.setMuted(muted)

    if (muted) {
      this.handlers.onLevel?.(0)
    }
  }
  /** Stops voice output only, never accepted Hermes work. */
  stopTurn(): void {
    if (!this.current()) {
      return
    }

    try {
      this.interrupt(true)
    } catch {
      this.fail('Interruption vocale indisponible.')
    }
  }
  end(reason = 'close_requested'): void {
    if (!this.scope) {
      return
    }

    try {
      const known = [
        'hangup',
        'owner_changed',
        'plugin_unloaded',
        'end_call',
        'error',
        'transport_closed',
        'pagehide',
        'close_requested'
      ]

      console.error(
        '[grok-live-close] ' +
          JSON.stringify({
            build: 'native-duplex-0.2.0-rc.1',
            reason: known.includes(reason) ? reason : 'other'
          })
      )
    } catch {
      // Diagnostics must not alter teardown.
    }

    ++this.generation
    this.clearPending()
    this.results = []
    this.transcript = []
    this.seenTools.clear()
    this.interrupted.clear()
    this.cancelEvents.clear()
    this.activeResponse = null
    this.responding = false
    this.requestOwed = false
    this.resultReading = false
    this.suppressAudio = false
    this.interruptBarrier = false
    this.userSpeaking = false
    this.requireResponseIds = false
    clearTimeout(this.connectTimer)
    this.unsubscribe?.()
    this.unsubscribe = null
    const socket = this.socket
    this.socket = null

    if (socket) {
      socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null
      socket.close()
    }

    this.releaseMic?.()
    this.releaseMic = null
    this.audio?.close()
    this.audio = null
    this.scope = null
    this.micStarting = false
    this.handlers.onLevel?.(0)
    this.setStatus('idle')
    this.handlers.onClosed(reason, null)
  }
  private fail(message: string): void {
    this.end('error')
    this.setStatus('error')
    this.handlers.onError(message, true)
  }
}
