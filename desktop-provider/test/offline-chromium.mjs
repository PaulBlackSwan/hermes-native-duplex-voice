// Real WebAudio engine, OFFLINE rendering of zero-valued synthetic PCM only.
// No AudioContext/device, microphone, network, installed provider, or credentials.
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--core-dir') throw new Error('Usage: node test/offline-chromium.mjs --core-dir /absolute/path/to/compatible/hermes-checkout');
const require = createRequire(resolve(args[1], 'package.json'));
const { chromium } = require('playwright');
const browser = await chromium.launch({ headless: true, args: ['--disable-background-networking', '--disable-component-update', '--no-proxy-server'] });
try {
  const context = await browser.newContext({ offline: true, serviceWorkers: 'block', permissions: [] });
  let requests = 0;
  await context.route('**/*', route => { requests++; return route.abort(); });
  const page = await context.newPage();
  const code = await readFile(new URL('../desktop/plugin.js', import.meta.url), 'utf8');
  const results = await page.evaluate(async code => {
    const plugin = (await import(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })))).default;
    let provider;
    plugin.register({ registerLiveVoiceProvider(p) { provider = p; } });
    const rows = [];
    for (const flush of [false, true]) {
      let offline, socket, micCalls = 0;
      globalThis.AudioContext = class {
        constructor() {
          offline = new OfflineAudioContext(1, 24000, 24000);
          // Adapt only device lifecycle; source scheduling/onended/rendering are real.
          offline.resume = async () => {};
          offline.close = async () => {};
          return offline;
        }
      };
      globalThis.WebSocket = class {
        readyState = 1; bufferedAmount = 0;
        constructor() { socket = this; }
        send() {} close() {}
        event(data) { this.onmessage({ data: JSON.stringify(data) }); }
      };
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia() { micCalls++; throw Error('Forbidden microphone'); } } });
      globalThis.fetch = () => { throw Error('Forbidden network'); };
      const errors = [], statuses = [];
      const session = provider.createSession({
        mint: async () => ({ endpoint: 'wss://api.x.ai/v1/realtime', subprotocol: 'xai-client-secret.', client_secret: { value: 'synthetic', expires_at: Date.now()/1000 + 60 }, session_update: {} }),
        isCurrent: () => true, subscribe: () => () => {}
      }, { onStatus: s => statuses.push(s), onError: e => errors.push(e), onClosed() {} });
      await session.start({ sessionId: 'offline', owner: { connectionId: 'offline', profile: 'offline' } });
      socket.event({ type: 'response.created', response: { id: 'offline' } });
      // Two actual scheduled silent sources; the Node behavioral suite covers backlog refill.
      for (let i = 0; i < 2; i++) socket.event({ type: 'response.audio.delta', response_id: 'offline', delta: btoa('\0'.repeat(4800)) });
      socket.event({ type: 'response.done', response: { id: 'offline' } });
      const before = session.status;
      if (flush) session.stopTurn();
      const rendered = await offline.startRendering();
      await new Promise(resolve => setTimeout(resolve, 20));
      const after = session.status;
      let nonzero = 0;
      for (const sample of rendered.getChannelData(0)) if (sample !== 0) nonzero++;
      rows.push({ mode: flush ? 'flush' : 'natural-drain', before, after, nonzero, samples: rendered.length, micCalls, errors, statuses });
      session.end();
    }
    return rows;
  }, code);
  for (const row of results) {
    assert.equal(row.before, 'speaking'); assert.equal(row.after, 'listening');
    assert.equal(row.nonzero, 0); assert.equal(row.micCalls, 0); assert.deepEqual(row.errors, []);
  }
  assert.equal(requests, 0);
  const report = { engine: 'Chromium OfflineAudioContext', liveAudio: false, networkRequests: requests, checks: results };
  await mkdir(new URL('../verification/', import.meta.url), { recursive: true });
  await writeFile(new URL('../verification/offline-chromium.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
