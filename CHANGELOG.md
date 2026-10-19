# Changelog

## 0.2.0 — release candidate

### Highlights

- Rebuilt the DeskBeacon CLI and terminal dashboard on Node.js 24, React and Ink. The root `deskbeacon` command opens the dashboard, or attaches to an existing background Runtime.
- Replaced the old one-piece Windows NativeAOT distribution with a standalone C/Win32 Job Object process supervisor, packaged separately as `@deskbeacon/win32-x64` and `@deskbeacon/win32-arm64`.
- Added a contextual slash-command palette with keyboard navigation, staged argument choices and `/config name [value]` / `/config url [value]` queries and updates.
- Added full INPUT, OUTPUT and RESULT inspectors, readable error reporting, syntax highlighting, line numbers, truncation accounting and copy controls.
- Improved file and tool batch operations, background-process control, IPC reliability and Windows legacy console (including CP936/GBK) output decoding.
- Persisted device display names on the local client and synchronized renames with the server.

### Packaging and compatibility

- Requires Node.js 24 or newer. Windows x64 and ARM64 users must allow npm optional platform packages to install; the native process helper is required for remote command execution on Windows.
- Publish `@deskbeacon/win32-x64@0.2.0` and `@deskbeacon/win32-arm64@0.2.0` **before** `deskbeacon@0.2.0`; all three versions must match.
- The old standalone CLI `rename` subcommand has been removed; use the interactive `/config name <value>` command instead.
- Changing `/config url` stages the new origin for a fresh OAuth pairing. Existing credentials must not be replayed to the new host.
- When upgrading a self-hosted deployment, update the Cloudflare Worker/server to a compatible version before depending on new device-renaming behavior. Existing pairing state should be preserved.

### Release verification

The release candidate is only approved for npm publication after Linux packaging, Windows x64 and Windows ARM64 native lifecycle tests, and a **fresh installation from the exact three npm tarballs** pass. The release-preparation workflow does not publish packages.
