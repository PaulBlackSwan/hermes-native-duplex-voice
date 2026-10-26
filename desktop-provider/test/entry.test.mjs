import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
const artifact = new URL('../desktop/plugin.js', import.meta.url);

test('standalone artifact exists and registers only the native API v1 provider, disabled by default', async () => {
  await assert.doesNotReject(access(artifact), 'missing standalone ESM artifact');
  const exports = await import(artifact.href);
  assert.deepEqual(Object.keys(exports), ['default']);
  const plugin = exports.default;
  assert.equal(plugin.id, 'grok-native-provider');
  assert.equal(plugin.defaultEnabled, false);
  assert.equal(typeof plugin.name, 'string');
  const calls = [];
  const ctx = new Proxy({ registerLiveVoiceProvider(provider) { calls.push(provider); return () => {}; } }, {
    get(target, key) { assert.equal(key, 'registerLiveVoiceProvider', `forbidden plugin capability ${String(key)}`); return target[key]; }
  });
  plugin.register(ctx);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].apiVersion, 1);
  assert.equal(calls[0].id, 'xai-oauth');
  const session = calls[0].createSession({}, { onError() {}, onClosed() {} });
  for (const method of ['start', 'end', 'checkOwner', 'setMuted', 'stopTurn']) assert.equal(typeof session[method], 'function');
});

test('older SDK is refused without falling back to UI or generic host APIs', async () => {
  const { default: plugin } = await import(artifact.href);
  assert.throws(() => plugin.register({}), /registerLiveVoiceProvider/);
  assert.throws(() => plugin.register({ registerLiveVoiceProvider: true }), /registerLiveVoiceProvider/);
});
