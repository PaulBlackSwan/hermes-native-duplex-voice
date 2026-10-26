/*!
MIT License

Copyright (c) 2026 Julien Talbot

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

*/

// src/voice-pcm.ts
var PcmPlaybackOverflow = class extends Error {
  constructor(snapshot) {
    super("File de lecture audio hors limite");
    this.snapshot = snapshot;
    this.name = "PcmPlaybackOverflow";
  }
  snapshot;
};
var RATE = 24e3;
var WORKLET = `
class Pcm24k extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch && ch.length) this.port.postMessage(ch.slice(0))
    return true
  }
}
registerProcessor('hermes-grok-pcm', Pcm24k)
`;
function encodePcm(frame) {
  if (frame.length > RATE) {
    throw new Error("Trame PCM hors limite");
  }
  const bytes = new Uint8Array(frame.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < frame.length; i++) {
    const sample = Math.max(-1, Math.min(1, frame[i]));
    view.setInt16(i * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i += 32768) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  }
  return btoa(binary);
}
function decodePcm(text) {
  if (text.length > 256e3) {
    throw new Error("Audio PCM hors limite");
  }
  const binary = atob(text);
  if (binary.length % 2) {
    throw new Error("Audio PCM16 invalide");
  }
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const pcm = new Int16Array(bytes.length >> 1);
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = view.getInt16(i * 2, true);
  }
  return pcm;
}
function createPcmAudio(makeContext = () => new AudioContext({ sampleRate: RATE })) {
  const context = makeContext();
  if (context.sampleRate !== RATE) {
    void context.close();
    throw new Error("Fr\xE9quence audio 24 kHz indisponible");
  }
  let closed = false;
  let muted = false;
  let next = 0;
  let stream = null;
  let source = null;
  let worklet = null;
  let mute = null;
  const live = /* @__PURE__ */ new Set();
  const playbackQueue = [];
  let waitingSamples = 0;
  function diagnostics() {
    return {
      contextState: context.state,
      audioTime: context.currentTime,
      queuedMs: (Math.max(0, next - context.currentTime) + waitingSamples / RATE) * 1e3,
      sources: live.size,
      waitingFrames: playbackQueue.length
    };
  }
  function flush() {
    playbackQueue.length = 0;
    waitingSamples = 0;
    live.forEach((node) => {
      node.onended = null;
      try {
        node.stop();
      } catch {
      }
      node.disconnect();
    });
    live.clear();
    next = 0;
  }
  function pump() {
    while (!closed && playbackQueue.length && live.size < 8) {
      const pcm = playbackQueue.shift();
      waitingSamples -= pcm.length;
      const buffer = context.createBuffer(1, pcm.length, RATE);
      const ch = buffer.getChannelData(0);
      for (let i = 0; i < pcm.length; i++) {
        ch[i] = pcm[i] / 32768;
      }
      const node = context.createBufferSource();
      node.buffer = buffer;
      node.connect(context.destination);
      next = Math.max(next, context.currentTime);
      live.add(node);
      node.onended = () => {
        if (!live.delete(node)) {
          return;
        }
        node.disconnect();
        try {
          pump();
          if (!closed && !hasPending()) {
            next = 0;
            player.onDrained?.();
          }
        } catch {
          flush();
          console.error('[grok-live-diagnostic] {"event":"playback_pump_error"}');
        }
      };
      node.start(next);
      next += buffer.duration;
    }
  }
  function stopMic() {
    if (worklet) {
      worklet.port.onmessage = null;
      worklet.disconnect();
      worklet = null;
    }
    source?.disconnect();
    source = null;
    mute?.disconnect();
    mute = null;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
  }
  function close() {
    if (closed) {
      return;
    }
    closed = true;
    stopMic();
    flush();
    void context.close().catch(() => {
    });
  }
  function hasPending() {
    return live.size > 0 || playbackQueue.length > 0;
  }
  const player = {
    hasPending,
    resume: () => context.resume(),
    play(pcm) {
      if (closed || !pcm.length) {
        return;
      }
      if (diagnostics().queuedMs + pcm.length / RATE * 1e3 > 30000.001 || playbackQueue.length >= 4096) {
        const snapshot = diagnostics();
        flush();
        throw new PcmPlaybackOverflow(snapshot);
      }
      playbackQueue.push(pcm);
      waitingSamples += pcm.length;
      pump();
    },
    diagnostics,
    flush,
    close
  };
  return {
    player,
    close,
    setMuted(value) {
      muted = value;
      stream?.getAudioTracks().forEach((track) => {
        track.enabled = !value;
      });
    },
    async startMic(onFrame) {
      const acquired = await navigator.mediaDevices.getUserMedia({
        audio: { autoGainControl: true, echoCancellation: true, noiseSuppression: true }
      });
      if (closed) {
        acquired.getTracks().forEach((track) => track.stop());
        throw new Error("Appel annul\xE9");
      }
      stream = acquired;
      stream.getAudioTracks().forEach((track) => {
        track.enabled = !muted;
      });
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
      try {
        await context.audioWorklet.addModule(url);
        if (closed) {
          throw new Error("Appel annul\xE9");
        }
        if (context.sampleRate !== RATE) {
          throw new Error("Fr\xE9quence audio 24 kHz indisponible");
        }
        const node = new AudioWorkletNode(context, "hermes-grok-pcm");
        worklet = node;
        let pending = [];
        let size = 0;
        node.port.onmessage = ({ data }) => {
          if (closed || muted) {
            return;
          }
          if (!(data instanceof Float32Array) || data.length > RATE / 10) {
            return;
          }
          pending.push(data);
          size += data.length;
          if (size < RATE / 10) {
            return;
          }
          const frame = new Float32Array(size);
          let at = 0;
          for (const part of pending) {
            frame.set(part, at);
            at += part.length;
          }
          pending = [];
          size = 0;
          onFrame(frame);
        };
        source = context.createMediaStreamSource(stream);
        source.connect(node);
        mute = context.createGain();
        mute.gain.value = 0;
        node.connect(mute);
        mute.connect(context.destination);
        return stopMic;
      } catch (error) {
        stopMic();
        throw error;
      } finally {
        URL.revokeObjectURL(url);
      }
    }
  };
}

// src/grok.ts
var defaults = { audio: createPcmAudio, socket: (url, protocols) => new WebSocket(url, protocols) };
function canonicalAdmission(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value ? value : void 0;
}
var GrokLiveSession = class {
  constructor(bridge, handlers, factories = defaults) {
    this.bridge = bridge;
    this.handlers = handlers;
    this.factories = factories;
  }
  bridge;
  handlers;
  factories;
  status = "idle";
  generation = 0;
  scope = null;
  socket = null;
  audio = null;
  releaseMic = null;
  unsubscribe = null;
  connectTimer;
  muted = false;
  micStarting = false;
  pending = /* @__PURE__ */ new Set();
  early = [];
  seenTools = /* @__PURE__ */ new Set();
  activeResponse = null;
  interrupted = /* @__PURE__ */ new Set();
  cancelEvents = /* @__PURE__ */ new Set();
  cancelSequence = 0;
  suppressAudio = false;
  interruptBarrier = false;
  userSpeaking = false;
  requireResponseIds = false;
  responding = false;
  requestOwed = false;
  resultReading = false;
  results = [];
  transcript = [];
  startedAt = 0;
  diagnosticBudget = 24;
  reportedUntagged = false;
  /** Only fixed categories and bounded numeric metadata reach desktop.log.
   * Never pass an event, raw exception, identifier, transcript or token to console.
   */
  diagnose(event, error, eventType, payloadChars) {
    if (this.diagnosticBudget-- <= 0) {
      return;
    }
    try {
      const snapshot = error instanceof PcmPlaybackOverflow ? error.snapshot : this.audio?.player.diagnostics?.();
      const bounded = (value) => typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1e9, Math.round(value))) : null;
      const state = ["running", "suspended", "interrupted", "closed"].includes(snapshot?.contextState ?? "") ? snapshot.contextState : "unknown";
      const kind = error instanceof PcmPlaybackOverflow ? "backlog" : error instanceof Error && ["InvalidCharacterError", "NotSupportedError", "InvalidStateError", "NotAllowedError"].includes(
        error.name
      ) ? error.name : "unspecified";
      const classifiedKind = error instanceof Error ? (/* @__PURE__ */ new Map([
        ["Audio PCM hors limite", "pcm_frame_limit"],
        ["Audio PCM16 invalide", "pcm_odd_length"],
        ["Audio socket hors limite", "socket_backpressure"],
        ["Trame PCM hors limite", "mic_frame_limit"]
      ])).get(error.message) ?? kind : kind;
      const knownTypes = [
        "session.updated",
        "input_audio_buffer.speech_started",
        "input_audio_buffer.speech_stopped",
        "response.created",
        "response.output_audio.delta",
        "response.audio.delta",
        "response.function_call_arguments.done",
        "conversation.item.input_audio_transcription.completed",
        "response.output_audio_transcript.done",
        "response.audio_transcript.done",
        "response.done",
        "error"
      ];
      const safeType = eventType === void 0 ? "none" : knownTypes.includes(String(eventType)) ? String(eventType) : "other";
      const errorClass = error instanceof Error ? [
        "Error",
        "TypeError",
        "RangeError",
        "DOMException",
        "InvalidCharacterError",
        "NotSupportedError",
        "InvalidStateError",
        "NotAllowedError"
      ].includes(error.name) ? error.name : "other" : "none";
      const frame = error instanceof Error && typeof error.stack === "string" ? error.stack.split("\n").slice(1).map((line) => line.match(/:(\d+):(\d+)\)?$/)).find(Boolean) : null;
      console.error(
        "[grok-live-diagnostic] " + JSON.stringify({
          build: "native-duplex-0.2.0-rc.1",
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
          audioTimeMs: bounded((snapshot?.audioTime ?? 0) * 1e3),
          queuedMs: bounded(snapshot?.queuedMs),
          sources: bounded(snapshot?.sources),
          waitingFrames: bounded(snapshot?.waitingFrames)
        })
      );
    } catch {
    }
  }
  setStatus(status) {
    if ((status === "listening" || status === "thinking") && this.audio?.player.hasPending()) {
      status = "speaking";
    }
    this.status = status;
    this.handlers.onStatus?.(status);
    this.handlers.onSpeakingChange?.(status === "speaking");
  }
  current(token = this.generation) {
    if (token !== this.generation || !this.scope) {
      return false;
    }
    if (!this.bridge.isCurrent(this.scope)) {
      this.end("owner_changed");
      return false;
    }
    return true;
  }
  checkOwner() {
    this.current();
  }
  send(event) {
    if (!this.socket || this.socket.readyState !== 1) {
      return false;
    }
    if (this.socket.bufferedAmount > 512e3) {
      throw new Error("Audio socket hors limite");
    }
    this.socket.send(JSON.stringify(event));
    return true;
  }
  async start(options) {
    if (this.status !== "idle" && this.status !== "error") {
      return;
    }
    const token = ++this.generation;
    this.startedAt = Date.now();
    this.diagnosticBudget = 24;
    this.reportedUntagged = false;
    this.scope = { sessionId: options.sessionId, owner: { ...options.owner } };
    this.setStatus("connecting");
    this.connectTimer = setTimeout(() => {
      if (this.current(token)) {
        this.diagnose("connect_timeout");
        this.fail("D\xE9lai de connexion Grok Voice d\xE9pass\xE9.");
      }
    }, 3e4);
    try {
      const audio = this.factories.audio();
      this.audio = audio;
      audio.player.onDrained = () => {
        if (this.audio === audio && this.current(token) && !audio.player.hasPending() && this.status === "speaking") {
          this.setStatus("listening");
        }
      };
      audio.setMuted(this.muted);
      await audio.player.resume();
      if (!this.current(token)) {
        return;
      }
      const minted = await this.bridge.mint(this.scope, options.config);
      if (!this.current(token)) {
        return;
      }
      if (minted.endpoint !== "wss://api.x.ai/v1/realtime" || minted.subprotocol !== "xai-client-secret." || !/^[A-Za-z0-9_.~-]{1,4096}$/.test(minted.client_secret.value) || !Number.isFinite(minted.client_secret.expires_at) || minted.client_secret.expires_at <= Date.now() / 1e3 || minted.client_secret.expires_at > Date.now() / 1e3 + 3600) {
        throw new Error("Session Grok Voice invalide.");
      }
      const socket = this.factories.socket(minted.endpoint, [minted.subprotocol + minted.client_secret.value]);
      this.socket = socket;
      this.unsubscribe = this.bridge.subscribe(this.scope, (event) => {
        if (this.current(token)) {
          try {
            this.complete(event);
          } catch {
            this.fail("Livraison vocale indisponible. Consultez le chat.");
          }
        }
      });
      socket.onopen = () => {
        if (this.current(token)) {
          try {
            this.send(minted.session_update);
          } catch {
            this.fail("Connexion Grok Voice indisponible.");
          }
        }
      };
      socket.onmessage = ({ data }) => {
        if (!this.current(token)) {
          return;
        }
        if (typeof data !== "string" || data.length > 256e3) {
          this.fail("Message Grok Voice hors limite.");
          return;
        }
        try {
          const event = JSON.parse(data);
          if (event && typeof event.type === "string") {
            void this.handle(event, token).catch((error) => {
              if (this.current(token)) {
                this.diagnose(
                  "handler_error",
                  error,
                  event.type,
                  typeof event.delta === "string" ? event.delta.length : void 0
                );
                this.fail("Audio Grok Voice indisponible.");
              }
            });
          }
        } catch {
          this.fail("Message Grok Voice invalide.");
        }
      };
      socket.onerror = () => {
        if (this.current(token)) {
          this.diagnose("transport_error");
          this.fail("Connexion Grok Voice indisponible.");
        }
      };
      socket.onclose = () => {
        if (this.current(token)) {
          this.diagnose("transport_closed");
          this.end("transport_closed");
        }
      };
    } catch (error) {
      if (this.current(token)) {
        this.fail(
          error instanceof Error && error.message === "Fr\xE9quence audio 24 kHz indisponible" ? "Fr\xE9quence audio 24 kHz indisponible. Grok Voice n\xE9cessite PCM16 mono 24 kHz." : "Grok Voice indisponible. V\xE9rifiez le microphone et la connexion OAuth."
        );
      }
    }
  }
  async handle(event, token) {
    if (event.type === "session.updated" && !this.micStarting) {
      this.micStarting = true;
      const release = await this.audio.startMic((frame) => {
        if (!this.current(token) || this.muted) {
          return;
        }
        try {
          this.send({ type: "input_audio_buffer.append", audio: encodePcm(frame) });
          let energy = 0;
          for (const sample of frame) {
            energy += sample * sample;
          }
          this.handlers.onLevel?.(frame.length ? Math.min(1, Math.sqrt(energy / frame.length)) : 0);
        } catch {
          this.fail("Flux audio hors limite.");
        }
      });
      if (!this.current(token)) {
        release();
        return;
      }
      this.releaseMic = release;
      clearTimeout(this.connectTimer);
      this.setStatus("listening");
    }
    switch (event.type) {
      case "input_audio_buffer.speech_started":
        this.userSpeaking = true;
        this.interrupt(false);
        break;
      case "input_audio_buffer.speech_stopped":
        this.userSpeaking = false;
        this.interruptBarrier = false;
        break;
      case "response.created":
        this.activeResponse = typeof event.response?.id === "string" ? event.response.id : null;
        if (this.interruptBarrier && this.activeResponse) {
          this.rejectResponse(this.activeResponse);
        }
        this.suppressAudio = this.interruptBarrier || !!this.activeResponse && this.interrupted.has(this.activeResponse);
        this.responding = true;
        if (!this.suppressAudio) {
          this.setStatus("thinking");
        }
        break;
      case "response.output_audio.delta":
      case "response.audio.delta":
        if (this.requireResponseIds && !event.response_id && !this.reportedUntagged) {
          this.reportedUntagged = true;
          this.diagnose("untagged_delta");
        }
        if (this.suppressAudio || this.requireResponseIds && !event.response_id || event.response_id && (this.interrupted.has(event.response_id) || event.response_id !== this.activeResponse)) {
          break;
        }
        if (typeof event.delta === "string") {
          try {
            this.audio.player.play(decodePcm(event.delta));
          } catch (error) {
            if (!(error instanceof PcmPlaybackOverflow)) {
              throw error;
            }
            this.diagnose("playback_backlog", error);
            this.interrupt(true);
            this.handlers.onNotice?.(
              "Lecture audio interrompue pour rattraper le retard. L\u2019appel reste actif ; vous pouvez reparler."
            );
            break;
          }
          if (this.audio.player.hasPending()) {
            this.setStatus("speaking");
          }
        }
        break;
      case "response.function_call_arguments.done":
        await this.tool(event, token);
        break;
      case "conversation.item.input_audio_transcription.completed":
        this.remember("user", event.transcript);
        break;
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done":
        if (!this.suppressAudio && (!event.response_id || event.response_id === this.activeResponse)) {
          this.remember("assistant", event.transcript);
        }
        break;
      case "response.done":
        if (event.response?.id && this.activeResponse && event.response.id !== this.activeResponse) {
          break;
        }
        this.responding = false;
        if (this.resultReading) {
          if (this.suppressAudio || this.interrupted.has(event.response?.id) || event.response?.status === "cancelled") {
            this.requestOwed = true;
          } else {
            this.resultReading = false;
          }
        }
        if (!this.userSpeaking && (!this.interruptBarrier || this.interrupted.has(event.response?.id))) {
          this.interruptBarrier = false;
        }
        this.activeResponse = null;
        this.setStatus("listening");
        this.flushResults();
        break;
      case "error":
        this.diagnose("provider_error");
        if (event.error?.code === "response_cancel_not_active" && event.error?.type === "invalid_request_error" && this.cancelEvents.delete(event.error?.event_id) && this.socket?.readyState === 1) {
          this.handlers.onNotice?.("La r\xE9ponse vocale \xE9tait d\xE9j\xE0 arr\xEAt\xE9e. L\u2019appel reste actif.");
          if (!this.activeResponse) {
            this.responding = false;
            this.interruptBarrier = this.userSpeaking;
            this.flushResults();
          }
          break;
        }
        this.fail("Grok Voice a signal\xE9 une erreur. R\xE9essayez l\u2019appel.");
        break;
    }
  }
  remember(speaker, text) {
    if (typeof text !== "string" || !text.trim()) {
      return;
    }
    const clean = text.trim().slice(0, 3e3);
    this.transcript.push(`${speaker}: ${clean}`);
    this.transcript = this.transcript.slice(-12);
    this.handlers.onTranscript?.({ speaker, text: clean, startMs: 0, endMs: 0 });
  }
  output(callId, result) {
    this.send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output: JSON.stringify(result) }
    });
    this.requestOwed = true;
    this.flushResults();
  }
  flushResults() {
    if (this.responding || this.interruptBarrier || this.userSpeaking) {
      return;
    }
    if (this.results.length) {
      const text = this.results.splice(0).join("\n\n");
      this.send({
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text: `[Hermes result] ${text}` }] }
      });
      this.requestOwed = true;
      this.resultReading = true;
    }
    if (this.requestOwed) {
      this.requestOwed = false;
      this.send({ type: "response.create" });
      this.responding = true;
      this.setStatus("thinking");
    }
  }
  notice(message) {
    this.handlers.onNotice?.(message);
    if (this.results.length >= 32) {
      this.fail("Trop de r\xE9sultats vocaux. Consultez le chat.");
      return;
    }
    this.results.push(message.slice(0, 3e3));
    this.flushResults();
  }
  clearPending(task) {
    for (const pending of task ? [task] : this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(pending);
    }
    if (!this.pending.size) {
      this.early = [];
    }
  }
  complete(event) {
    const scope = this.scope;
    const payload = event.payload;
    const row = payload?.persisted_turn?.user_row_id;
    const admission = canonicalAdmission(payload?.admission_id);
    const canonicalTerminal = admission !== void 0 && (payload?.status === "complete" && payload.outcome === "completed" || payload?.status === "error" && payload.outcome === "failed" || payload?.status === "interrupted" && payload.outcome === "cancelled");
    const persisted = Number.isSafeInteger(row) && row > 0 && payload?.persisted_turn?.complete === true;
    if (!this.pending.size || !scope || event.type !== "message.complete" || event.sessionId !== scope.sessionId || event.owner.connectionId !== scope.owner.connectionId || event.owner.profile !== scope.owner.profile || !canonicalTerminal && !persisted) {
      return;
    }
    const text = canonicalTerminal && payload?.status !== "complete" ? "La t\xE2che Hermes n\u2019a pas termin\xE9 normalement. Consultez le chat pour son \xE9tat exact." : payload?.text?.trim().slice(0, 3e3) || "Hermes a termin\xE9 sans r\xE9sultat \xE0 lire.";
    const pending = [...this.pending].find(
      (task) => task.admission ? canonicalTerminal && admission === task.admission : persisted && row === task.row
    );
    if (!pending && [...this.pending].some((task) => task.row === void 0 && task.admission === void 0)) {
      this.early = this.early.filter((item) => Date.now() - item.time < 1e4);
      if (this.early.length < 16 && !this.early.some((item) => admission ? item.admission === admission : item.row === row)) {
        this.early.push({
          row: persisted ? row : void 0,
          admission: canonicalTerminal ? admission : void 0,
          text,
          time: Date.now()
        });
      }
      return;
    }
    if (!pending) {
      return;
    }
    this.clearPending(pending);
    this.notice(text);
  }
  async tool(event, token) {
    const id = event.call_id;
    if (typeof id !== "string" || !id || id.length > 256 || this.seenTools.has(id)) {
      return;
    }
    if (this.seenTools.size >= 256) {
      this.fail("Limite d\u2019outils vocaux atteinte.");
      return;
    }
    this.seenTools.add(id);
    if (event.name === "end_call") {
      this.output(id, { ok: true });
      this.end("end_call");
      return;
    }
    let request;
    try {
      request = JSON.parse(event.arguments).request;
    } catch {
    }
    if (event.name !== "hermes_task" || typeof request !== "string" || !request.trim() || request.length > 6e3) {
      this.output(id, { ok: false, error: "Requ\xEAte vocale invalide." });
      return;
    }
    if ([...this.pending].some((task) => task.admitting)) {
      this.output(id, {
        ok: false,
        error: "Une admission Hermes attend confirmation. Ne resoumettez pas cette demande."
      });
      return;
    }
    if (this.pending.size + this.results.length >= 32) {
      this.output(id, { ok: false, error: "Limite de t\xE2ches vocales en attente atteinte. Consultez le chat." });
      return;
    }
    const pending = {
      admitting: true,
      outputSent: false,
      row: void 0,
      admission: void 0,
      timer: setTimeout(() => {
        if (!this.current(token) || !this.pending.has(pending)) {
          return;
        }
        const unconfirmed = pending.row === void 0 && pending.admission === void 0;
        pending.admitting = false;
        if (unconfirmed && !pending.outputSent) {
          pending.outputSent = true;
          this.output(id, {
            ok: null,
            receipt: "unknown",
            note: "R\xE9ception non confirm\xE9e \xE0 temps. Ne resoumettez pas cette demande ; consultez le chat, le travail peut continuer."
          });
        }
        this.handlers.onNotice?.("Hermes peut encore travailler. Le r\xE9sultat reste attendu ; consultez aussi le chat.");
      }, 12e4)
    };
    this.pending.add(pending);
    const scope = this.scope;
    try {
      const busy = await this.bridge.isBusy(scope);
      if (!this.current(token) || !this.pending.has(pending)) {
        return;
      }
      if (busy) {
        this.clearPending(pending);
        this.output(id, { ok: false, error: "Hermes est occup\xE9. R\xE9essayez apr\xE8s la t\xE2che en cours." });
        return;
      }
      this.diagnose("task_submitting");
      const receipt = await this.bridge.submit(scope, request.trim(), {
        queued: true,
        context: this.transcript.join("\n")
      });
      if (!this.current(token) || !this.pending.has(pending)) {
        return;
      }
      const admission = ["queued", "started", "terminal", "unknown"].includes(receipt.status ?? "") ? canonicalAdmission(receipt.admission_id) : void 0;
      if (receipt.status === "queued" && !admission && (!Number.isSafeInteger(receipt.user_row_id) || receipt.user_row_id <= 0)) {
        this.clearPending(pending);
        if (!pending.outputSent) {
          this.output(id, {
            ok: true,
            receipt: "queued",
            note: "Demande accept\xE9e en attente dans le chat. R\xE9sultat vocal non corr\xE9lable ; consultez le chat."
          });
        }
        return;
      }
      if (!admission && (!["streaming", "queued"].includes(receipt.status ?? "") || !Number.isSafeInteger(receipt.user_row_id) || receipt.user_row_id <= 0)) {
        this.clearPending(pending);
        if (!pending.outputSent) {
          this.output(id, {
            ok: false,
            note: "R\xE9ception non corr\xE9lable. Consultez le chat avant de r\xE9essayer ; la demande peut avoir \xE9t\xE9 accept\xE9e."
          });
        }
        return;
      }
      this.diagnose("task_admitted");
      pending.row = receipt.user_row_id;
      pending.admission = admission;
      pending.admitting = false;
      if (!pending.outputSent) {
        pending.outputSent = true;
        this.output(id, {
          ok: receipt.status === "unknown" ? null : true,
          receipt: receipt.status,
          note: receipt.status === "unknown" ? "R\xE9ception ambigu\xEB. Ne resoumettez pas cette demande ; consultez le chat. Le r\xE9sultat reste attendu." : receipt.status === "queued" ? "Demande accept\xE9e en attente, visible dans le chat." : "Demande accept\xE9e. R\xE9sultat attendu, \xE9galement disponible dans le chat."
        });
      }
      const early = this.early.find(
        (item) => (pending.admission ? item.admission === pending.admission : item.row === pending.row) && Date.now() - item.time < 1e4
      );
      if (early) {
        this.early = this.early.filter((item) => item !== early);
        this.clearPending(pending);
        this.notice(early.text);
      }
    } catch {
      if (!this.current(token) || !this.pending.has(pending)) {
        return;
      }
      this.clearPending(pending);
      if (!pending.outputSent) {
        this.output(id, {
          ok: null,
          note: "R\xE9ception non confirm\xE9e. Consultez le chat avant de r\xE9essayer ; le travail peut continuer."
        });
      }
    }
  }
  rejectResponse(id) {
    this.interrupted.add(id);
    if (this.interrupted.size > 64) {
      this.interrupted.delete(this.interrupted.values().next().value);
    }
  }
  interrupt(manual) {
    this.audio?.player.flush();
    this.interruptBarrier = true;
    if (this.activeResponse) {
      this.rejectResponse(this.activeResponse);
    }
    this.suppressAudio = true;
    this.requireResponseIds = true;
    if (manual && this.responding) {
      const eventId = `grok-cancel-${++this.cancelSequence}`;
      this.cancelEvents.add(eventId);
      if (this.cancelEvents.size > 64) {
        this.cancelEvents.delete(this.cancelEvents.values().next().value);
      }
      this.send({ type: "response.cancel", event_id: eventId });
    }
    if (this.scope) {
      this.setStatus("listening");
    }
  }
  setMuted(muted) {
    this.muted = muted;
    this.audio?.setMuted(muted);
    if (muted) {
      this.handlers.onLevel?.(0);
    }
  }
  /** Stops voice output only, never accepted Hermes work. */
  stopTurn() {
    if (!this.current()) {
      return;
    }
    try {
      this.interrupt(true);
    } catch {
      this.fail("Interruption vocale indisponible.");
    }
  }
  end(reason = "close_requested") {
    if (!this.scope) {
      return;
    }
    try {
      const known = [
        "hangup",
        "owner_changed",
        "plugin_unloaded",
        "end_call",
        "error",
        "transport_closed",
        "pagehide",
        "close_requested"
      ];
      console.error(
        "[grok-live-close] " + JSON.stringify({
          build: "native-duplex-0.2.0-rc.1",
          reason: known.includes(reason) ? reason : "other"
        })
      );
    } catch {
    }
    ++this.generation;
    this.clearPending();
    this.results = [];
    this.transcript = [];
    this.seenTools.clear();
    this.interrupted.clear();
    this.cancelEvents.clear();
    this.activeResponse = null;
    this.responding = false;
    this.requestOwed = false;
    this.resultReading = false;
    this.suppressAudio = false;
    this.interruptBarrier = false;
    this.userSpeaking = false;
    this.requireResponseIds = false;
    clearTimeout(this.connectTimer);
    this.unsubscribe?.();
    this.unsubscribe = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null;
      socket.close();
    }
    this.releaseMic?.();
    this.releaseMic = null;
    this.audio?.close();
    this.audio = null;
    this.scope = null;
    this.micStarting = false;
    this.handlers.onLevel?.(0);
    this.setStatus("idle");
    this.handlers.onClosed(reason, null);
  }
  fail(message) {
    this.end("error");
    this.setStatus("error");
    this.handlers.onError(message, true);
  }
};

// src/index.ts
var index_default = {
  id: "grok-native-provider",
  name: "Grok Native Voice Provider",
  defaultEnabled: false,
  register(ctx) {
    if (typeof ctx.registerLiveVoiceProvider !== "function") {
      throw new Error("Grok Native Voice requires registerLiveVoiceProvider (native live voice API v1).");
    }
    ctx.registerLiveVoiceProvider({
      apiVersion: 1,
      id: "xai-oauth",
      createSession(bridge, handlers) {
        return new GrokLiveSession(bridge, handlers);
      }
    });
  }
};
export {
  index_default as default
};
