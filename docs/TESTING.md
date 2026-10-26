# Offline verification

`QUALIFICATION.json` records the release's actual final test counts and scope. All provider traffic and Gateway tool execution boundaries are synthetic. Do not replace those mocks with a real account or run a provider's live diagnostic to reproduce this qualification.

## Desktop provider

The release includes the built browser module and public source. Rebuild with the compatible host checkout's existing esbuild, then run the Node behavioral tests:

```sh
cd desktop-provider
node scripts/build.mjs --core-dir /absolute/path/to/compatible/hermes-checkout
node --test test/*.test.mjs
```

The suite imports that actual public module. It exercises a response finishing generation before local playback, full drain, queue refill, flush, microphone mute, stale ended callbacks, owner invalidation, empty PCM, task admission/result correlation, bounds and diagnostic privacy.

For real WebAudio scheduling without output devices or credentials, use an already installed Playwright/Chromium from the host development checkout:

```sh
node test/offline-chromium.mjs --core-dir /absolute/path/to/compatible/hermes-checkout
```

The browser runs offline with no permissions. Its `OfflineAudioContext` renders only zero-valued synthetic PCM; natural drain and flush must leave zero nonzero output samples, zero page requests and zero microphone calls. It is not a speaker-device or live provider test.

## Native host integration

Apply the supplied patch to exactly the pinned isolated Hermes source base. The patch contains the relevant host tests. From `apps/desktop` use its existing Vitest UI project with `--configLoader runner`, and set `GROK_NATIVE_PLUGIN_ARTIFACT` to the absolute release `desktop-provider/desktop/plugin.js`. This enables real-artifact tests that otherwise intentionally skip. The exact release run must have no skipped artifact checks.

The rendered-control regression was separately run against the previous built provider (expected failure: listening while PCM remains) and the new built module (pass). It mounts the real French native control, checks intermediate and final source completion, then clicks Interrompre after generation is done and asserts the call remains active.

The additional OpenAI busy-admission regression uses the actual inherited hook with only external/session boundaries mocked. It does not claim parity with Grok's canonical ledger or window-owned lifetime. A native engine row is not enough to claim a complete transport implementation.

## Gateway broker

`gateway-plugin/tests/test_backend.py` uses the Hermes test environment's FastAPI/httpx/pytest dependencies. Run it with an explicit isolated `HERMES_HOME` and `HOME`, and the compatible Hermes source available on `PYTHONPATH`. Never run against a real home. The tests replace credential helpers and HTTP transport with fixed synthetic responses before invoking status/mint. They verify fixed-origin minting, no API-key fallback, expiry validation, no provider error leaks and explicit profile scope. The host's authenticated mounting remains a separate production prerequisite.

## Distribution

From the extracted source root:

```sh
python3 -m unittest discover -s tests -v
```

Tests use temporary synthetic homes, not a live `HERMES_HOME`. They cover default no-write planning, component placement, read-back, repeated installs, managed updates/backups, refusal of unknown/modified/legacy/symlinked targets, failure rollback, archive member restrictions, checksums and deterministic output. Set `TMPDIR` to a suitable local scratch directory if necessary.

After packaging, validate the real release archive with the supplied installer in dry-run against a new throwaway home, then `--apply` only into that throwaway home. Compare every installed file with its manifest mapping. No production installation or activation is required for this check.
