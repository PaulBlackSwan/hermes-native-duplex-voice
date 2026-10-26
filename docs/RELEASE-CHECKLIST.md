# Release qualification checklist

This is an offline candidate, not a live-call certificate. The public result summary is `QUALIFICATION.json`; development raw logs and personal checkout paths are intentionally not distributed.

## Scope

- [ ] Final public provider module built from release source, same bytes tested through the native host.
- [ ] Original bug reproduced against the previous built provider: response.done while local PCM remains hides Interrompre too early.
- [ ] Corrected module keeps the real rendered French Interrompre button through intermediate source completion, hides it on final drain, and flushes on click without hanging up.
- [ ] Synthetic scheduling/backlog/flush/stale callbacks/mute/owner changes and bounded PCM security regressions pass.
- [ ] Silent Chromium OfflineAudioContext natural drain and flush pass with zero microphone calls and zero page requests.
- [ ] Voice-only host regression passes with actual artifact opt-ins enabled, no skipped artifact tests.
- [ ] Headless broker tests use isolated homes and mock HTTP/OAuth responses only.
- [ ] New OpenAI busy delegation cannot cancel/replace accepted work or consume its pending result.
- [ ] Installer fixtures cover dry-run, idempotency, updates/backups, modified/unknown target refusal, legacy launcher refusal, symlink protection and partial failure rollback.
- [ ] Final host typecheck, scoped lint, build, diff whitespace and patch application checks succeed.
- [ ] Archive includes runtime components, source, pinned host patch, notices and installation/provider/rollback documentation; no old launcher.
- [ ] Deterministic ZIP comparison and all shipped hashes verified from a fresh extraction.
- [ ] Shipped source/artifacts checked for local usernames/absolute checkout paths and credential-like content; synthetic fixture placeholders distinguished from secrets.

## Explicitly not performed

- Live provider requests, microphone/speaker-device trials or real Hermes tasks.
- Installed application replacement, plugin activation, credentials access or service restart.
- Cross-platform signed-application packaging, live entitlement checks or Gemini Desktop implementation.


The checklist is completed only with actual tool evidence in the final verification summary. A passing mocked test does not assert external provider/account availability.
