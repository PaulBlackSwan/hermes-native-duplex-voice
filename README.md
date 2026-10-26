# Hermes Native Duplex Voice

**0.2.0-rc.2: source integration and offline-qualified release candidate. Not an official Hermes release or a universal drop-in plugin.**

Keep the existing Hermes Desktop voice button and its single engine menu. Use the host's **OpenAI GPT-Live** path or the bundled **Grok Voice (OAuth)** path. No extra Talk button, panel or floating launcher. The Hermes reasoning/chat provider remains independent of the voice provider.

The native control stays labelled **Interrompre** on the Grok path. Playback state follows the local PCM queue through the final drained source, not merely the provider's generation-complete event. Interrupting or hanging up this voice session does not cancel an admitted Hermes task.

Named Bot Chats now keep two separately captured identities: the triggering session's owner receives the delegated work and its result, while the explicitly selected voice account remains the OAuth broker scope. A target bot does not need its own voice OAuth login. If the selected voice account is unavailable, the call stops rather than probing another account or copying credentials. This correction is in the required **native host patch**, not a standalone provider-only update.

The pre-existing OpenAI GPT-Live path is included in the same native engine menu, with an additional safeguard: a new delegation cannot cancel or replace accepted work. It still uses the host's older hook-owned lifecycle and its listening action is a response nudge, not the Grok output-interruption control. This candidate does not claim shared control/lifecycle parity between the two transports.

## What is included

- `gateway-plugin/`: headless, authenticated `grok-voice-oauth` ephemeral-session broker. No legacy Desktop launcher or dashboard tab.
- `desktop-provider/`: self-contained native Grok provider, disabled by default. No Node/runtime dependencies in its built browser module.
- `integration/native-duplex-host.patch`: required native host/API1 integration, pinned to Hermes commit `bf0203a794a07aac3ff764972ab9087baa4e4f4e`.
- `tools/install.py`: verified offline installer, dry-run by default, explicit home and component selection. No settings activation or service lifecycle action.
- Sources, licences, synthetic tests, deterministic packaging tools, compatibility and provider boundaries.

## Provider support

| Native Desktop lane | Shipped here | Important boundary |
| --- | --- | --- |
| OpenAI GPT-Live | Host integration preserves the existing Hermes implementation | Requires explicit support/availability from that host. Not Talk's OpenAI Realtime protocol and no new ChatGPT subscription entitlement. |
| Grok Voice | Native provider + OAuth broker | Existing profile-bound xAI OAuth only. No API-key fallback. |
| Gemini Live | **Not shipped** | Hermes Talk's terminal/core support is not a native Desktop adapter. |

See [provider details and provenance](docs/PROVIDERS.md). This is not a claim of parity with every provider and surface supported by Hermes Talk.

## Prerequisites

1. A trusted Hermes Desktop build containing the native live voice API1 and the owner/lifecycle behavior in the supplied host patch. Do not assume an official version has it merely because it supports Desktop plugins.
2. A compatible Hermes Gateway with its authenticated profile-scoped plugin API mounting and canonical admission/result events.
3. For Grok, an operator-configured `xai-oauth` login on the intended profile. The installer neither reads nor creates it.
4. Python 3.11+ for offline installation/packaging on macOS or Linux (the supplied installer is POSIX-only and tested here on macOS; no Windows installer is claimed). Node 22.22+ and the matching host's development dependencies only if rebuilding the provider or Desktop.

Read [host compatibility and build](docs/HOST-COMPATIBILITY.md) before installing. The package deliberately does not patch an installed `.app`, bundle a signed application, or restart any service.

## Install the two plugin components

Extract the trusted release archive, open a terminal in its root, and name the intended Hermes home explicitly. For a remote Gateway and local Desktop, run each component separately on the correct machine with the correct home.

```sh
# Inspect the plan and verify shipped files. No changes:
python3 tools/install.py --archive /absolute/path/to/native-duplex-voice-0.2.0-rc.2.zip --home /absolute/path/to/intended/hermes-home --component both

# Only after checking the plan, write the plugin files:
python3 tools/install.py --archive /absolute/path/to/native-duplex-voice-0.2.0-rc.2.zip --home /absolute/path/to/intended/hermes-home --component both --apply
```

The Gateway component goes to `plugins/grok-voice-oauth/`. The Desktop source artifact `desktop-provider/desktop/plugin.js` is mapped to `desktop-plugins/grok-native-provider/plugin.js`, the actual standalone Desktop discovery entry.

The installer does **not** enable plugins, change providers, obtain credentials, call a model, open a microphone, or reload services. Enable the trusted plugin components yourself using your host's supported plugin controls. Then use the existing native voice engine menu. Any Gateway reload needed by that host remains an explicit operator action.

Unknown or modified installations and historical duplicate launchers are refused rather than overwritten. See [installation and rollback](docs/INSTALLATION.md). A stock host without API1 will refuse registration; install a compatible build instead of bypassing the security boundary.

## Rebuild and verify offline

Use the compatible Hermes checkout's already installed development dependencies:

```sh
cd desktop-provider
node scripts/build.mjs --core-dir /absolute/path/to/compatible/hermes-checkout
node --test test/*.test.mjs
cd ..
python3 -m unittest discover -s tests -v
python3 tools/package_release.py --help
```

Gateway and native host tests additionally use their existing Hermes development/test environments. They mock provider traffic and use isolated homes; see the release verification notes. No credential, actual provider response, audible-delivery claim or live-call receipt is fabricated.

## Qualification and limits

This candidate is tested offline. It is **not** newly validated against live xAI/OpenAI sessions, real microphone/speaker devices, every official Hermes build, or Windows/Linux application packaging. The exact provider availability and account entitlement remain external requirements.

Public source and release archives: [hermes-native-duplex-voice](https://github.com/PaulBlackSwan/hermes-native-duplex-voice). SHA256 checks protect byte integrity, not publisher identity. Review [SECURITY.md](SECURITY.md), [architecture](docs/ARCHITECTURE.md), [third-party notices](THIRD_PARTY_NOTICES.md), and the verification evidence before installation.
