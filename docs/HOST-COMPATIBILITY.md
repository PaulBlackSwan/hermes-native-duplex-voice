# Host compatibility and build

The supported source baseline for this candidate is exactly Hermes commit `bf0203a794a07aac3ff764972ab9087baa4e4f4e`, plus `integration/native-duplex-host.patch`. No semantic version minimum is invented: the native plugin API and stable call lifecycle have not been established as present in a published official release.

## For host maintainers

Use a separate Hermes source checkout or detached worktree. Do not apply this patch to a running installed application or to a checkout containing unrelated work.

```sh
git checkout --detach bf0203a794a07aac3ff764972ab9087baa4e4f4e
git apply --check /absolute/path/to/voice-release/integration/native-duplex-host.patch
git apply /absolute/path/to/voice-release/integration/native-duplex-host.patch
```

Install the pinned Hermes workspace dependencies using that source tree's documented development setup and package lock. The release's provider uses esbuild from that explicit checkout; it does not download a second compiler. Build Desktop through the source tree's normal build entry, for example `npm run build --workspace apps/desktop`, following its platform-specific native dependency and signing prerequisites. A renderer build is not a signed distributable application. This release does not ship an application-signing identity or a pre-signed cross-platform binary.

Before distributing your host build, run the supplied Voice tests and your normal Desktop build/typecheck/platform checks. `integration/host-compatibility.json` enumerates the exact resulting source hashes, not a promise that a superficially similar SDK is equivalent. Applying the patch to other revisions is not qualified here.

The native provider must be able to call `ctx.registerLiveVoiceProvider({apiVersion: 1, id: 'xai-oauth', createSession})`. The core captures the owner/session, handles canonical admission IDs and legacy positive persisted rows, owns wake capture/lifecycle, and retains the active call independently of composer unmounts. The provider gets a narrow bridge, not generic REST or credentials.

The rc.2 host patch additionally resolves the persisted owner of an existing triggering session before the first asynchronous operation. It captures that delegation route separately from the originally selected voice-broker account. The target bot therefore does not need a duplicate OAuth login; the host never probes another account when the selected one is unavailable. Do not deploy only the unchanged broker/provider files and assume the named-profile correction is active: rebuild the compatible native host from the updated patch.

## Gateway prerequisites

The Gateway must support authenticated plugin API mounting under `/api/plugins/grok-voice-oauth/`, explicit profile routing, existing xAI OAuth resolution, and native canonical prompt admission/terminal receipts. The package does not add public credential routes, globally expand plugin REST capability, start another backend, or install a Talk orchestration runtime.

## OpenAI versus Grok

The compatible host's existing OpenAI GPT-Live implementation is preserved. It may have different authentication and interruption capabilities from Grok; the release does not silently substitute Talk's OpenAI Realtime transport or claim Gemini support. A missing OpenAI key/entitlement does not prevent an available Grok OAuth choice from appearing in the same native menu.

## Roll back source integration

In the isolated source checkout only, first check `git apply --reverse --check integration/native-duplex-host.patch` using the correct absolute release path, then reverse it with `git apply --reverse`. Rebuild your previous host normally. Never reverse an installed binary or an unrelated dirty checkout automatically.
