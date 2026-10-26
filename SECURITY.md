# Security

- The plugin is trusted code installed by its operator, not a sandboxed untrusted extension. The SHA256 manifest detects corrupt/mismatched bytes; it is not a digital signature or publisher authentication.
- Install only a release obtained from a trusted source. Review the host patch separately. No automatic downloads, account creation, configuration enablement, credential discovery, provider calls, service reloads or billing changes occur during installation.
- The Gateway broker relies on the Hermes host's authentication and profile-scope middleware. Do not mount its router publicly on an unauthenticated server. Status never refreshes credentials; mint is an explicit POST.
- Grok OAuth access/refresh credentials remain backend-only. Only a bounded short-lived client secret is returned. HTTP redirects and environment proxies are disabled for its fixed-origin mint request. No xAI API-key fallback is allowed.
- Installation refuses unknown or modified targets and historical duplicate launchers. Update backups are local and outside plugin discovery. The installer does not delete or disable existing code it does not own.
- Voice controls never cancel an admitted Hermes task. Permissions, tools and approved side effects remain the executor's responsibility, not the voice persona's.
- Offline diagnostics contain only fixed categories and bounded numeric values. Do not attach unredacted provider events, credentials, transcripts or recordings when reporting bugs.
- An incompatible host must fail closed with a missing-API error. Do not work around it by exposing a generic REST bridge, moving a long-lived token into the renderer, or silently switching providers/billing lanes.

Do not include secrets in public issues or published archives. No remote reporting endpoint is configured by this package.
