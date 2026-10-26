# Installation, migration and rollback

## Explicit targets, no automatic activation

The supplied stdlib installer uses POSIX no-follow directory descriptors, advisory locks and exclusive rename. It is exercised on macOS; Linux is implemented but not platform-tested here. Windows is not supported by this installer. Do not infer application/device compatibility from a portable JavaScript bundle.

Use the installer from an extracted trusted release, first without `--apply`. Its `--home` argument names exactly one intended Hermes home, not a discovered profile or a macOS application path. For remote backends use `--component gateway` on the backend and `--component desktop` on the Desktop machine. `--component both` is appropriate only when they share the intended home.

The native Desktop runtime owns a home-level `desktop-plugins` folder; do not manually scatter duplicate renderer copies into profiles or install the same provider through two discovery roots. Check the matching host's plugin UI and root behavior before choosing a path.

Expected targets:

- Gateway: `<home>/plugins/grok-voice-oauth/`, without any `desktop/plugin.js`.
- Desktop: `<home>/desktop-plugins/grok-native-provider/plugin.js` plus the supplied notices and package metadata.

The SHA256 release manifest is verified before files are copied. Unknown or operator-modified targets and symlink traversal are refused. Already identical files are idempotent. Only a previously installer-managed unmodified copy is eligible for a controlled update with a backup outside plugin discovery. Existing code is not silently adopted.

Enabling/disabling components and any host reload remain explicit operator actions. The plugin is disabled by default. The installer does not touch settings, change the default chat model/provider, log in to services, open a microphone, issue a Hermes request, or restart Gateway/Desktop.

## Existing experimental installations

Do not install blindly over an experimental Grok plugin. It may have the same ID but no managed-install receipt, or ship the historical extra `Vocal Grok` launcher. The installer deliberately refuses this ambiguous case.

First inspect the known plugin folders and installed/active entries using the host's supported UI. Disable the identified old entry, make a source-only backup outside `plugins` and `desktop-plugins`, and move the exact known old plugin folder aside only after operator approval. Do not move or delete an entire home, credentials directory, client data folder, or an unknown repository. The new release's gateway component intentionally has no Desktop payload.

## Rollback

The installer retains controlled-update backups outside plugin discovery. Disable the new components using the host's controls before restoring a backup. Check that the target is still the known installed version, then restore only that component's previous verified files. Preserve unrelated settings, credentials and data. A fresh install can be removed manually by disabling its exact plugin entry and moving only its installer-managed component folders aside; there is no broad automatic uninstall.

A host source rollback is separate: reverse the pinned patch in the isolated source worktree and rebuild the previous application normally. Do not restore a renderer over an arbitrary official application or defeat code signing. No app install/activation or service lifecycle action is part of this prepared release.
