# Provider support and provenance

## Native Desktop distribution

| Provider | Implementation | Authentication | Voice surface |
| --- | --- | --- | --- |
| OpenAI GPT-Live | Existing Hermes host implementation, not a copied Talk adapter | Whatever the compatible Hermes host explicitly supports; a ChatGPT subscription alone is not a promise of GPT-Live access | Existing native voice engine menu and composer |
| xAI Grok Voice | Bundled API1 Desktop provider plus headless Gateway broker | Existing profile-bound `xai-oauth`; only a short-lived session secret enters the renderer | Same native engine menu, native Mute / Interrompre / End |
| Gemini Live | Not implemented in this Desktop candidate | Not requested or read | Not advertised or selectable |

OpenAI's backend availability must be reported by the host. Its existing hook-owned lifecycle and listening/nudge control are not the new Grok stable-runtime/Interrompre path. The included safety hardening refuses overlapping delegation IDs without cancelling accepted work or reassigning its pending result; it does not turn the legacy reply feed into Grok's canonical admission ledger. This release does not add OpenAI subscription authentication, silently select API billing, or copy Talk's different OpenAI Realtime lane. Never treat GPT-Live and OpenAI Realtime as interchangeable protocols.

The Grok plugin does not replace the selected Hermes reasoning/chat model. Hermes remains the executor and authority for task admission, receipts, permissions, and results. Hanging up or interrupting voice does not cancel an admitted Hermes task.

## What is reused from Hermes Talk

Reference: [TheSmokeDev/hermes-talk](https://github.com/TheSmokeDev/hermes-talk/tree/64ede8fc5d71c1d9ec04519a8b7c67bda0a8f2a5), pinned revision `64ede8fc5d71c1d9ec04519a8b7c67bda0a8f2a5`.

Keep its architectural strengths: explicit provider selection, separate provider transports, separation of voice from the Hermes executor, independent task/result correlation, ephemeral credentials, distinct generation and actual playback facts. The Grok transport adapted from Julien Talbot's separate `hermes-xai` project retains its original MIT notice. No Hermes Talk source is copied into this release. Do not import the floating Talk panel, a second launcher, alternate task executor, or its incompatible task identifiers into the native Desktop path.

At that pinned revision its README advertises OpenAI Realtime broadly, Grok on terminal/Discord, Gemini on terminal/core realtime, and a separate GPT-Live mode on supported surfaces. That is not three ready-to-use native Desktop transports. This package makes only the native paths above available; the terminal capability table is not a Desktop compatibility claim.

## Adding another provider honestly

A new provider requires a complete transport adapter, a core-owned authenticated ephemeral-credential broker, explicit endpoint/audio-format validation, owner-bound result/admission handling, native menu/config wiring, and synthetic lifecycle/delegation tests through the real host. Implement and qualify all of these before advertising it. The current host's OpenAI/Grok union and fixed broker are deliberately not described as a universal arbitrary-provider SDK. A dummy registry entry or silent fallback does not count as support.

Gemini specifically needs its distinct setup/serverContent/toolCall/toolResponse protocol, a correctly constrained short-lived credential, input/output sample-rate handling, interruption/end semantics, and a safely scoped bridge. No long-lived Gemini API key may be passed into a renderer to make it appear integrated.
