# Architecture and release boundaries

1. **Hermes host integration**: the exact pinned-source patch under `integration/`. Owns the call lifecycle outside React, owner/profile/session binding, canonical Gateway attachment, native controls, and plugin API1. Includes the existing OpenAI path and native Grok engine selection.
2. **Desktop provider**: `desktop-provider/desktop/plugin.js`, a self-contained browser ES module. Registers `xai-oauth`, owns xAI media/PCM transport, and receives a narrow core bridge. Installs as `desktop-plugins/grok-native-provider/plugin.js`. Disabled by default. No alternate Talk window or launcher.
3. **Gateway plugin**: `gateway-plugin/`, headless `grok-voice-oauth` authenticated ephemeral-session broker. No Desktop payload, dashboard tab, tools or hooks. OAuth remains server-side. Uses the Hermes host's authenticated router and explicit profile scope.

These are not two universally installable plugins on any Hermes version. The native API1 and host behavior are prerequisites. Shipping their exact source patch makes that dependency visible rather than hiding an app modification in a plugin installer.

## Playback versus generation

A remote generation-complete event is not proof that local audio has finished. Native `speaking` must remain true while queued or scheduled PCM sources remain. The final drain callback changes playback state only for its still-current generation/session. Flushing playback clears the pending sources, prevents stale callbacks from changing the next turn, and is independent of Hermes task cancellation.

The button remains **Interrompre**. It cuts the Grok voice response/output without ending the call. **End** ends the call. The chat's separate task-stop action is not rewired. Microphone mute never means playback has ended.

## Safety boundaries

No frontend OAuth bearer or refresh credential; no API-key fallback. Exact provider endpoint, bounded audio/messages/tasks/context, fixed diagnostic categories. No raw audio, transcript, credential or exception logging. Background Hermes work remains owned by Hermes, including after voice hangup. Queued work without a correlatable receipt remains chat-only and is never resubmitted to manufacture correlation.

## Qualification

All release checks are offline against synthetic inputs, fake network boundaries and isolated install directories. This is not a real provider conformance certificate, microphone/device test, vendor availability test, or cross-platform live-call certification. Installation, activation and publication are separate actions and are not performed by the build.
