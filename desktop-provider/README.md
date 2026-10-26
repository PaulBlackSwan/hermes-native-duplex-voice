# Native Grok transport

A self-contained browser ES module registered as native live voice API1 provider `xai-oauth`. The plugin entry ID is `grok-native-provider`, disabled by default. The host owns all UI, owner/session binding, canonical Gateway attachment, and lifecycle. No Talk button, menu, page, settings panel, general REST door or credential discovery is contributed.

Built artifact: `desktop/plugin.js`. Standalone install target: `<HERMES_HOME>/desktop-plugins/grok-native-provider/plugin.js` (not a nested desktop folder).

From this directory, with an explicitly chosen compatible Hermes development checkout containing esbuild:

```sh
node scripts/build.mjs --core-dir /absolute/path/to/compatible/hermes-checkout
node --test test/*.test.mjs
```

No runtime dependency install, actual provider contact or microphone/device access occurs in those tests. Synthetic AudioContext/WebSocket fixtures exercise the built public plugin entry, not a separate substitute implementation.

The local playback queue is authoritative for output activity. Generation completion alone must not hide the native **Interrompre** control while PCM is still pending. Interrupt flushes local playback and optionally cancels the relevant xAI response; it never calls Hermes task cancellation. Microphone mute is independent of output. Stale callbacks after flush/end/new playback must not change the new session's state.

Respect bounded PCM decoding, playback backlog limits, canonical receipt matching, owner fencing, non-destructive late task notices, and fixed-category private diagnostics. See root docs for compatibility, actual provider coverage, distribution and offline-only qualification.

Transport/audio attribution: Julien Talbot's hermes-xai, MIT; preserve `voice-grok.LICENSE` and the built banner. Root LICENSE is also included.
