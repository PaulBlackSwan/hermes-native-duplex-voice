import test from 'node:test';
import assert from 'node:assert/strict';
import plugin from '../desktop/plugin.js';

// Exercise the public built artifact, including its actual PCM implementation.
// Only external browser/socket/audio/host boundaries are synthetic; no inference,
// real device, credentials, external process, or network is used.
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const scope = { sessionId: 'test-session', owner: { connectionId: 'test-connection', profile: 'test-profile' } };
function harness(t, options = {}) {
  const state = { statuses: [], speaking: [], sockets: [], contexts: [], submissions: [], errors: [], notices: [], closed: [], tracksStopped: 0, unsubscribed: 0, cancelled: 0, current: true, frame: null };
  const globals = ['WebSocket', 'AudioContext', 'AudioWorkletNode', 'navigator', 'fetch'];
  const original = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => {
    state.session?.end();
    for (const [key, desc] of original) { if (desc) Object.defineProperty(globalThis, key, desc); else delete globalThis[key]; }
  });
  const track = { enabled: true, stop() { state.tracksStopped++; } };
  const node = () => ({ connect() {}, disconnect() {} });
  class Context {
    constructor() { this.sampleRate = 24000; this.state = 'running'; this.currentTime = 0; this.played = []; this.stopped = 0; state.contexts.push(this); }
    destination = {};
    audioWorklet = { addModule: async () => {} };
    async resume() {}
    async close() { this.state = 'closed'; }
    createMediaStreamSource() { return node(); }
    createGain() { return { ...node(), gain: { value: 0 } }; }
    createBuffer(channels, length, rate) { return { duration: length / rate, getChannelData: () => new Float32Array(length) }; }
    createBufferSource() { const ctx = this; return { ...node(), start() { ctx.played.push(this); }, stop() { ctx.stopped++; } }; }
  }
  class Socket {
    constructor(url, protocols) { this.url = url; this.protocols = protocols; this.readyState = 0; this.bufferedAmount = 0; this.sent = []; this.closes = 0; state.sockets.push(this); }
    send(text) { assert.equal(this.readyState, 1); this.sent.push(JSON.parse(text)); }
    close() { this.closes++; this.readyState = 3; }
    open() { this.readyState = 1; this.onopen?.({}); }
    event(data) { this.onmessage?.({ data: JSON.stringify(data) }); }
  }
  const replacements = {
    WebSocket: Socket, AudioContext: Context,
    AudioWorkletNode: class { constructor() { this.port = { onmessage: null }; state.worklet = this; } connect() {} disconnect() {} },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) } },
    fetch: () => { throw new Error('Network forbidden'); }
  };
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const bridge = new Proxy({
    async mint(received) { assert.deepEqual(received, scope); return options.mint ?? { endpoint: 'wss://api.x.ai/v1/realtime', subprotocol: 'xai-client-secret.', client_secret: { value: 'offline-fixture', expires_at: Date.now() / 1000 + 60 }, session_update: { type: 'session.update', session: { audio: 'fixture' } } }; },
    isCurrent(received) { assert.deepEqual(received, scope); return state.current; },
    async isBusy() { return options.busy ?? false; },
    async submit(...args) { state.submissions.push(args); if (options.submit) return options.submit(state); return { status: 'streaming', user_row_id: 42 }; },
    subscribe(received, listener) { assert.deepEqual(received, scope); state.deliver = listener; return () => state.unsubscribed++; }
  }, { get(target, key) { if (!(key in target)) { state.cancelled++; throw new Error(`Forbidden bridge capability ${String(key)}`); } return target[key]; } });
  plugin.register({ registerLiveVoiceProvider(provider) { state.provider = provider; } });
  state.session = state.provider.createSession(bridge, { onStatus: status => state.statuses.push(status), onSpeakingChange: value => state.speaking.push(value), onError: (...args) => state.errors.push(args), onClosed: (...args) => state.closed.push(args), onNotice: text => state.notices.push(text) });
  state.track = track;
  state.connect = async () => { await state.session.start(scope); state.socket = state.sockets[0]; state.socket?.open(); state.socket?.event({ type: 'session.updated' }); await tick(); };
  state.tool = async (call_id = 'task-1') => { state.socket.event({ type: 'response.function_call_arguments.done', name: 'hermes_task', call_id, arguments: JSON.stringify({ request: 'Summarize fixture' }) }); await tick(); };
  state.complete = (row = 42, overrides = {}) => state.deliver({ ...scope, type: 'message.complete', payload: { text: 'Offline result', persisted_turn: { user_row_id: row, complete: true } }, ...overrides });
  return state;
}

function beginAudio(h, id = 'playback', frames = 1) {
  h.socket.event({ type: 'response.created', response: { id } });
  for (let i = 0; i < frames; i++) h.socket.event({ type: 'response.audio.delta', response_id: id, delta: 'AAA=' });
}
function finishSource(ctx, index) {
  const source = ctx.played[index];
  ctx.currentTime += source.buffer.duration;
  source.onended?.();
}

test('playback lifecycle keeps speaking after response.done until the last real source ends', async t => {
  const h = harness(t); await h.connect(); beginAudio(h, 'playback', 2);
  h.socket.event({ type: 'response.done', response: { id: 'playback' } }); await tick();
  assert.equal(h.session.status, 'speaking'); assert.equal(h.speaking.at(-1), true);
  finishSource(h.contexts[0], 0); assert.equal(h.session.status, 'speaking');
  finishSource(h.contexts[0], 1); assert.equal(h.session.status, 'listening'); assert.equal(h.speaking.at(-1), false);
});

test('playback lifecycle ignores empty PCM instead of latching speaking without output', async t => {
  const h = harness(t); await h.connect();
  h.socket.event({ type: 'response.created', response: { id: 'empty' } });
  h.socket.event({ type: 'response.audio.delta', response_id: 'empty', delta: '' }); await tick();
  assert.equal(h.contexts[0].played.length, 0);
  assert.notEqual(h.session.status, 'speaking');
});

test('tiny-frame backlog refills all eight scheduling slots without a false listening edge', async t => {
  const h = harness(t); await h.connect(); beginAudio(h, 'tiny', 25);
  const ctx = h.contexts[0]; assert.equal(ctx.played.length, 8);
  h.socket.event({ type: 'response.done', response: { id: 'tiny' } });
  const edge = h.statuses.length;
  for (let i = 0; i < 24; i++) { finishSource(ctx, i); assert.equal(h.session.status, 'speaking'); }
  assert.equal(ctx.played.length, 25); assert.equal(h.statuses.slice(edge).includes('listening'), false);
  finishSource(ctx, 24); assert.equal(h.session.status, 'listening');
});

test('manual stop after generation done flushes scheduled and queued PCM without cancelling accepted work', async t => {
  const h = harness(t); await h.connect(); await h.tool(); beginAudio(h, 'done-stop', 25);
  h.socket.event({ type: 'response.done', response: { id: 'done-stop' } });
  const ctx = h.contexts[0], stale = ctx.played.map(n => n.onended);
  assert.equal(h.session.status, 'speaking'); h.session.stopTurn();
  assert.equal(ctx.stopped, 8); assert.equal(h.session.status, 'listening');
  stale.forEach(fn => fn()); assert.equal(ctx.played.length, 8);
  assert.equal(h.socket.sent.filter(e => e.type === 'response.cancel').length, 0);
  h.complete(); h.session.end(); assert.equal(h.submissions.length, 1); assert.equal(h.cancelled, 0);
});

test('muted microphone stays muted through response.done and final playback drain', async t => {
  const h = harness(t); await h.connect(); h.session.setMuted(true); beginAudio(h);
  const count = h.socket.sent.length;
  h.socket.event({ type: 'response.done', response: { id: 'playback' } });
  h.worklet.port.onmessage({ data: new Float32Array(2400) });
  assert.equal(h.socket.sent.length, count); assert.equal(h.track.enabled, false);
  finishSource(h.contexts[0], 0); assert.equal(h.session.status, 'listening');
  h.worklet.port.onmessage({ data: new Float32Array(2400) });
  assert.equal(h.socket.sent.length, count); assert.equal(h.track.enabled, false);
});

test('stale ended callbacks after flush and new playback cannot drain the new turn', async t => {
  const h = harness(t); await h.connect(); beginAudio(h, 'old');
  const ctx = h.contexts[0], stale = ctx.played[0].onended;
  h.session.stopTurn(); h.socket.event({ type: 'response.done', response: { id: 'old' } });
  beginAudio(h, 'new'); stale();
  assert.equal(h.session.status, 'speaking'); assert.equal(ctx.played.length, 2);
  h.socket.event({ type: 'response.done', response: { id: 'old' } });
  assert.equal(h.session.status, 'speaking');
  h.socket.event({ type: 'response.done', response: { id: 'new' } }); finishSource(ctx, 1);
  assert.equal(h.session.status, 'listening');
});

test('stale ended callback after end/restart cannot affect the new call generation', async t => {
  const h = harness(t); await h.connect(); beginAudio(h, 'old-call');
  const stale = h.contexts[0].played[0].onended; h.session.end();
  stale(); assert.equal(h.session.status, 'idle');
  await h.session.start(scope); h.socket = h.sockets[1]; h.socket.open(); h.socket.event({ type: 'session.updated' }); await tick();
  beginAudio(h, 'new-call'); stale(); assert.equal(h.session.status, 'speaking');
  finishSource(h.contexts[1], 0); assert.equal(h.session.status, 'listening');
});

test('owner invalidation at natural playback drain closes the captured call', async t => {
  const h = harness(t); await h.connect(); beginAudio(h); h.current = false;
  finishSource(h.contexts[0], 0);
  assert.equal(h.session.status, 'idle'); assert.deepEqual(h.closed, [['owner_changed', null]]);
});

test('next response and Hermes completion cannot hide still pending playback', async t => {
  const h = harness(t); await h.connect(); await h.tool(); beginAudio(h, 'first');
  h.complete(); h.socket.event({ type: 'response.done', response: { id: 'first' } });
  assert.equal(h.session.status, 'speaking');
  h.socket.event({ type: 'response.created', response: { id: 'second' } });
  assert.equal(h.session.status, 'speaking'); finishSource(h.contexts[0], 0);
  assert.equal(h.session.status, 'listening'); assert.equal(h.cancelled, 0);
});

test('public factory starts actual PCM path, sends broker update, mutes and releases resources', async t => {
  const h = harness(t); await h.connect();
  assert.equal(h.session.status, 'listening');
  assert.deepEqual(h.socket.protocols, ['xai-client-secret.offline-fixture']);
  assert.equal(h.socket.sent[0].type, 'session.update');
  h.worklet.port.onmessage({ data: new Float32Array(2400).fill(0.1) });
  assert.equal(h.socket.sent.at(-1).type, 'input_audio_buffer.append');
  const n = h.socket.sent.length;
  h.session.setMuted(true); assert.equal(h.track.enabled, false);
  h.worklet.port.onmessage({ data: new Float32Array(2400) }); assert.equal(h.socket.sent.length, n);
  h.session.setMuted(false); assert.equal(h.track.enabled, true);
  h.session.end('test_hangup'); h.session.end('duplicate');
  assert.equal(h.socket.closes, 1); assert.equal(h.unsubscribed, 1); assert.equal(h.tracksStopped, 1);
  assert.equal(h.contexts[0].state, 'closed'); assert.deepEqual(h.closed, [['test_hangup', null]]); assert.deepEqual(h.errors, []);
});

test('normal hermes_task and correlated receipt delivery preserve the same live socket', async t => {
  const h = harness(t); await h.connect();
  h.socket.event({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'fixture context' });
  await h.tool();
  assert.deepEqual(h.submissions, [[scope, 'Summarize fixture', { queued: true, context: 'user: fixture context' }]]);
  const output = h.socket.sent.find(e => e.item?.type === 'function_call_output');
  assert.equal(JSON.parse(output.item.output).ok, true);
  h.complete(99); h.complete(42, { owner: { ...scope.owner, profile: 'wrong' } });
  assert.deepEqual(h.notices, []);
  h.complete();
  h.socket.event({ type: 'response.done' }); await tick();
  assert.deepEqual(h.notices, ['Offline result']);
  assert.ok(h.socket.sent.some(e => e.item?.content?.[0]?.text === '[Hermes result] Offline result'));
  assert.equal(h.sockets.length, 1); assert.equal(h.socket.readyState, 1); assert.equal(h.socket.closes, 0); assert.equal(h.closed.length, 0);
  h.complete(); assert.equal(h.notices.length, 1);
  await h.tool(); assert.equal(h.submissions.length, 1, 'duplicate tool ignored');
});

test('manual interruption suppresses late audio and hangup never cancels accepted Hermes work', async t => {
  const h = harness(t); await h.connect(); await h.tool();
  h.socket.event({ type: 'response.created', response: { id: 'r1' } });
  h.socket.event({ type: 'response.audio.delta', response_id: 'r1', delta: 'AAA=' }); await tick();
  assert.equal(h.contexts[0].played.length, 1);
  h.session.stopTurn();
  assert.ok(h.socket.sent.some(e => e.type === 'response.cancel'));
  h.socket.event({ type: 'response.audio.delta', response_id: 'r1', delta: 'AAA=' }); await tick();
  assert.equal(h.contexts[0].played.length, 1);
  h.complete(); h.session.end(); h.complete();
  assert.equal(h.cancelled, 0); assert.equal(h.submissions.length, 1); assert.equal(h.socket.closes, 1);
});

test('barge-in before response ID fences audio without canceling Hermes', async t => {
  const h = harness(t); await h.connect(); await h.tool();
  h.socket.event({ type: 'input_audio_buffer.speech_started' });
  h.socket.event({ type: 'response.created', response: { id: 'late' } });
  h.socket.event({ type: 'response.audio.delta', response_id: 'late', delta: 'AAA=' }); await tick();
  assert.equal(h.contexts[0].played.length, 0); assert.equal(h.cancelled, 0); assert.equal(h.socket.closes, 0);
});

test('captured owner invalidation closes transport and rejects late receipts', async t => {
  const h = harness(t); await h.connect(); await h.tool();
  h.current = false; h.session.checkOwner(); h.complete();
  assert.deepEqual(h.closed, [['owner_changed', null]]); assert.deepEqual(h.notices, []); assert.equal(h.cancelled, 0);
});

test('busy Hermes rejects delegation without dropping the call', async t => {
  const h = harness(t, { busy: true }); await h.connect(); await h.tool();
  assert.equal(h.submissions.length, 0);
  assert.equal(JSON.parse(h.socket.sent.find(e => e.item?.type === 'function_call_output').item.output).ok, false);
  assert.equal(h.socket.closes, 0);
});

test('early terminal receipt is correlated after submit resolves', async t => {
  const h = harness(t, { submit(state) { state.complete(); return { status: 'queued', user_row_id: 42 }; } });
  await h.connect(); await h.tool(); h.socket.event({ type: 'response.done' }); await tick();
  assert.deepEqual(h.notices, ['Offline result']); assert.equal(h.socket.closes, 0);
});

test('canonical admission receipts deliver the exact result without a persisted row', async t => {
  const h = harness(t, { submit: () => ({ status: 'queued', admission_id: 'canonical-admission' }) });
  await h.connect(); await h.tool();
  const payload = { admission_id: 'canonical-admission', status: 'complete', outcome: 'completed', text: 'Canonical artifact result' };
  h.complete(0, { payload: { ...payload, admission_id: 'other' } });
  h.complete(0, { payload, owner: { ...scope.owner, profile: 'other' } });
  assert.deepEqual(h.notices, []);
  h.complete(0, { payload }); h.complete(0, { payload });
  h.socket.event({ type: 'response.done' }); await tick();
  assert.deepEqual(h.notices, ['Canonical artifact result']);
  assert.ok(h.socket.sent.some(e => e.item?.content?.[0]?.text === '[Hermes result] Canonical artifact result'));
  assert.equal(h.submissions.length, 1); assert.equal(h.socket.closes, 0);
  h.session.end(); assert.equal(h.cancelled, 0);
});

test('an early canonical completion is retained until its admission is accepted', async t => {
  const h = harness(t, { submit(state) {
    state.complete(0, { payload: { admission_id: 'canonical-early', status: 'complete', outcome: 'completed', text: 'Early artifact result' } });
    return { status: 'queued', admission_id: 'canonical-early' };
  } });
  await h.connect(); await h.tool();
  assert.deepEqual(h.notices, ['Early artifact result']);
  assert.equal(h.submissions.length, 1); assert.equal(h.socket.closes, 0); assert.equal(h.cancelled, 0);
});

test('an admitted result arriving after two minutes remains deliverable in the built artifact', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(t); await h.connect(); await h.tool();
  t.mock.timers.tick(120001); await tick();
  h.complete(); h.socket.event({ type: 'response.done' }); await tick();
  assert.ok(h.socket.sent.some(e => e.item?.content?.[0]?.text === '[Hermes result] Offline result'));
  assert.equal(h.submissions.length, 1); assert.equal(h.socket.closes, 0); assert.equal(h.cancelled, 0);
});

test('untrusted broker endpoint fails closed before a socket is constructed', async t => {
  const h = harness(t, { mint: { endpoint: 'wss://untrusted.invalid', subprotocol: 'xai-client-secret.', client_secret: { value: 'fixture', expires_at: Date.now() / 1000 + 60 }, session_update: {} } });
  await h.session.start(scope);
  assert.equal(h.sockets.length, 0); assert.equal(h.session.status, 'error'); assert.equal(h.errors.length, 1); assert.equal(h.contexts[0].state, 'closed');
});

function collectDiagnostics(t) {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.join(' '));
  t.after(() => { console.error = original; });
  return lines;
}
function diagnosticRows(lines) {
  return lines.filter(line => line.startsWith('[grok-live-diagnostic] ')).map(line => JSON.parse(line.slice('[grok-live-diagnostic] '.length)));
}

test('PCM duration and tiny-frame backlog bounds still flush safely without cancelling Hermes', async t => {
  const lines = collectDiagnostics(t);
  const h = harness(t); await h.connect(); await h.tool();
  beginAudio(h, 'duration', 0);
  for (let i = 0; i < 31; i++) h.socket.event({ type: 'response.audio.delta', response_id: 'duration', delta: 'A'.repeat(64000) });
  await tick(); assert.equal(h.session.status, 'listening'); assert.equal(h.contexts[0].stopped, 8);
  assert.ok(diagnosticRows(lines).some(r => r.event === 'playback_backlog'));
  h.socket.event({ type: 'response.done', response: { id: 'duration' } });
  beginAudio(h, 'frames', 4105); await tick();
  assert.equal(h.session.status, 'listening'); assert.equal(h.contexts[0].stopped, 16);
  assert.equal(diagnosticRows(lines).filter(r => r.event === 'playback_backlog').length, 2);
  assert.equal(h.socket.closes, 0); assert.equal(h.submissions.length, 1); assert.equal(h.cancelled, 0);
});

test('diagnostic identifies invalid PCM16 without persisting the audio delta', async t => {
  const lines = collectDiagnostics(t);
  const h = harness(t); await h.connect();
  h.socket.event({ type: 'response.created', response: { id: 'private-response-fixture' } });
  h.socket.event({ type: 'response.audio.delta', response_id: 'private-response-fixture', delta: 'AA==' });
  await tick();
  const row = diagnosticRows(lines).find(r => r.event === 'handler_error');
  assert.equal(row.kind, 'pcm_odd_length');
  assert.equal(row.eventType, 'response.audio.delta');
  assert.equal(row.payloadChars, 4);
  assert.equal(row.errorClass, 'Error');
  assert.ok(Number.isInteger(row.frameLine) && row.frameLine > 0);
  assert.equal(lines.join('').includes('private-response-fixture'), false);
  assert.ok(lines.join('').length < 3000);
  assert.equal(h.socket.closes, 1, 'instrumentation preserves fail-closed behavior');
});

test('diagnostic reports TypeError class and numeric frame but no raw exception or identifiers', async t => {
  const lines = collectDiagnostics(t);
  const h = harness(t); await h.connect();
  h.contexts[0].createBuffer = () => { throw new TypeError('PRIVATE_EXCEPTION_MARKER'); };
  h.socket.event({ type: 'response.audio.delta', delta: 'AAA=' });
  await tick();
  const row = diagnosticRows(lines).find(r => r.event === 'handler_error');
  assert.equal(row.kind, 'unspecified');
  assert.equal(row.errorClass, 'TypeError');
  assert.equal(row.eventType, 'response.audio.delta');
  assert.ok(Number.isInteger(row.frameLine));
  assert.equal(lines.join('').includes('PRIVATE_EXCEPTION_MARKER'), false);
  assert.equal(lines.join('').includes(scope.sessionId), false);
  assert.equal(lines.join('').includes(scope.owner.profile), false);
  assert.equal(lines.join('').includes('AAA='), false);
  assert.equal(h.socket.closes, 1);
});

test('observed-size 182032-character PCM delta after Hermes result keeps the live call open', async t => {
  const lines = collectDiagnostics(t);
  const h = harness(t); await h.connect(); await h.tool();
  h.complete(); h.socket.event({ type: 'response.done' });
  h.socket.event({ type: 'response.created', response: { id: 'spoken-result-fixture' } });
  // Synthetic zero PCM only, matching the observed chunk length; no real audio replay.
  for (let i = 0; i < 13; i++) {
    h.socket.event({ type: 'response.output_audio.delta', response_id: 'spoken-result-fixture', delta: 'A'.repeat(64000) });
  }
  h.socket.event({ type: 'response.output_audio.delta', response_id: 'spoken-result-fixture', delta: 'A'.repeat(182032) });
  await tick();
  assert.equal(h.socket.closes, 0);
  assert.deepEqual(h.errors, []);
  assert.equal(h.session.status, 'speaking');
  assert.equal(h.contexts[0].state, 'running');
  assert.equal(h.submissions.length, 1);
  assert.equal(h.cancelled, 0);
  assert.equal(diagnosticRows(lines).some(r => r.event === 'handler_error'), false);
});

test('wire messages above 256k still fail closed without cancelling admitted Hermes work', async t => {
  const lines = collectDiagnostics(t);
  const h = harness(t); await h.connect(); await h.tool();
  h.socket.event({ type: 'response.output_audio.delta', delta: 'A'.repeat(256004) });
  await tick();
  assert.equal(h.socket.closes, 1);
  assert.equal(h.session.status, 'error');
  assert.equal(h.submissions.length, 1);
  assert.equal(h.cancelled, 0);
  assert.equal(lines.join('').includes('A'.repeat(100)), false);
});

test('diagnostic persists only fixed close categories, once per call', async t => {
  const lines = collectDiagnostics(t);
  const h = harness(t); await h.connect();
  h.session.end('PRIVATE_REASON_MARKER'); h.session.end('duplicate');
  const closed = lines.filter(line => line.startsWith('[grok-live-close] '));
  assert.equal(closed.length, 1);
  assert.equal(JSON.parse(closed[0].slice('[grok-live-close] '.length)).reason, 'other');
  assert.equal(lines.join('').includes('PRIVATE_REASON_MARKER'), false);
  assert.equal(h.socket.closes, 1);
});
