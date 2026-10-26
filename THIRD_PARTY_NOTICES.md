# Third-party notices

## Hermes Agent

Host integration and original engine foundations derive from Hermes Agent, MIT, Copyright (c) 2025 Nous Research. The supplied host patch is intended for the pinned Hermes source revision and retains source notices. Root LICENSE is the original distribution's MIT licence and must remain with copies.

## Julien Talbot / hermes-xai

The Grok transport/audio source was adapted from Julien Talbot's `hermes-xai`. Its original MIT notice, Copyright (c) 2026 Julien Talbot, is preserved in `desktop-provider/voice-grok.LICENSE`, `desktop-provider/src/voice-grok.LICENSE`, and the built module banner. Keep these notices when redistributing source or runtime bundles.

## TheSmokeDev / Hermes Talk

Provider-neutral separation, explicit provider selection, and independent generation/playback/task result facts were studied from [hermes-talk](https://github.com/TheSmokeDev/hermes-talk/tree/64ede8fc5d71c1d9ec04519a8b7c67bda0a8f2a5), MIT, Copyright (c) 2026 SmokeDev. This candidate does not vendor its Python runtime, floating Talk UI, OpenAI subscription implementation, Gemini transport, or third-party dependencies. Architectural reference is not feature parity or an endorsement by that project.

## Build tools

The prebuilt Desktop provider is bundled with esbuild from the explicitly chosen Hermes development checkout. No esbuild runtime is required or vendored in the plugin. Python distribution tools use the standard library. The Hermes host retains its own dependency notices and licensing obligations, which are not replaced by this plugin archive.
