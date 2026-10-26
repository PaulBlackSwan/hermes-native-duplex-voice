# Changelog

## 0.2.0-rc.2

- Resolve the triggering session's persisted owner before opening the native call, instead of routing a named Bot Chat through its ambient launch profile.
- Keep the selected voice-broker account separate from the destination chat owner. Availability and ephemeral-session REST remain on the selected voice account; delegation and terminal events stay on the captured session route.
- Refuse unavailable selected accounts without credential fallback, preserve draft adoption, and ignore foreign-profile results and later owner-cache changes.
- Add regressions for a secondary bot without OAuth, account unavailability and stable routing; retain the real built-provider PCM drain, Interrompre, mute and End lifecycle tests.
- Regenerate the exact-base native host patch and source-integrity manifest. The transport/provider and broker implementations are unchanged; installing only their files cannot activate this host correction.
- Installation does not activate plugins, reload services or replace an installed application automatically.

## 0.2.0-rc.1

Prepared offline source/distribution candidate, not a published release.

- Keep the label **Interrompre** and native voice menu/controls; no additional Talk launcher.
- Make scheduled plus waiting PCM authoritative for playback activity. Do not leave `speaking` when network generation ends before queued audio drains.
- Natural full drain restores listening only for the active audio instance, session generation and owner. Ignore stale source callbacks after flush/end/new output.
- Empty PCM does not latch speaking; keep bounded playback scheduling, PCM decoding and memory limits.
- Interrupt after generation completion flushes output without an unnecessary provider cancel and without stopping accepted Hermes work.
- Separate a headless OAuth Gateway broker, standalone Desktop transport and exact compatible Hermes host patch. Exclude historical Gateway Desktop UI.
- Harden the inherited OpenAI admission path: refuse overlapping or replayed delegations without cancelling/replacing accepted Hermes work or consuming its result. Keep its existing hook lifecycle/nudge control explicitly distinct from Grok native parity.
- State native provider coverage explicitly: existing host OpenAI GPT-Live plus bundled Grok OAuth; no Gemini Desktop or Talk Realtime subscription claim.
- Include offline behavioral, silent Chromium OfflineAudioContext, native rendered-control, broker and distribution verification, with reproducible source and integrity metadata.
- Installation defaults to dry-run and requires an explicit target home. No activation, credential access, inference, network call or service restart is part of installation.

The release has not been tested on a new real microphone/device/provider session. Platform/vendor availability is not inferred from synthetic tests.
