# DeskBeacon 0.2.x / C platform package release

The already published `deskbeacon@0.1.0` remains unchanged. The source migration targets **0.2.0**. Do not publish the new main package before both native packages are public.

## Architecture

- `deskbeacon`: ESM CLI/TUI/Runtime, with `@deskbeacon/win32-x64` and `@deskbeacon/win32-arm64` in `optionalDependencies` pinned to exactly the same version.
- `@deskbeacon/win32-x64`: `os: ["win32"]`, `cpu: ["x64"]`, contains only `deskbeacon-job.exe` + metadata.
- `@deskbeacon/win32-arm64`: `os: ["win32"]`, `cpu: ["arm64"]`, same file layout.
- Windows Runtime resolves the corresponding native binary via Node's `createRequire(import.meta.url).resolve()`; missing package, skipped optional dependencies or unknown CPU throws `WINDOWS_JOB_HELPER_MISSING`. Never run Windows commands without Job Object containment.
- POSIX Runtime still uses the native Node subprocess path. The native packages are not needed outside Windows.

## C helper and build

`apps/client/native/win-job/job.c` replaces the .NET NativeAOT process launcher. It preserves the base64 JSON CLI contract with `File`, `Args`, `Cwd` and `ParentPid`. CreateProcessW(CREATE_SUSPENDED) → AssignProcessToJobObject → ResumeThread prevents an unowned startup window. The helper monitors the parent PID, proxies standard streams, conveys exit status and closes its kill-on-close Job to terminate remaining descendants. This is process lifecycle containment, **not an OS security sandbox**.

CI cross-compiles both executables on one Ubuntu runner using pinned LLVM-mingw (UCRT) and runs PE architecture verification. Windows x64 and Windows ARM64 runners test actual execution separately. No .NET SDK or Visual Studio C++ Build Tools are installed by the workflow.

To build locally with LLVM-mingw, set `LLVM_MINGW_ROOT` to its installation directory and use:

```powershell
pnpm install --frozen-lockfile
pnpm --filter deskbeacon build:native:win-x64
pnpm --filter deskbeacon build:native:win-arm64
pnpm test:local
node apps/client/scripts/stage-npm.mjs
```

For testing a custom, newly compiled binary without replacing the currently running service's executable, set `DESKBEACON_JOB_BINARY` to its full path **in the test process environment only**. On Windows x64, `DESKBEACON_CC_X64` may be set to an existing compatible MinGW C compiler as a fallback.

The workflow artifact `deskbeacon-npm-0.2.0` contains three tarballs. Validate their metadata and Windows executable architecture before publishing.

## npm publishing order (user action only)

Create the **free** public-package npm Organization named `deskbeacon` to control the `@deskbeacon` scope. Publish in strict order:

```powershell
npm login
npm publish ./packages/win32-x64 --access public
npm publish ./packages/win32-arm64 --access public
npm publish ./apps/client/dist/npm --access public
```

Prefer publishing the **validated CI tarballs** rather than rebuilding independently. If using tarballs, replace each directory argument with the matching `.tgz` path.

Do not publish until x64 and ARM64 CI pass and the matching three package names and versions are verified. npm package versions are immutable; 0.2.0 requires bumping if already used.

## Upgrade notes

The main CLI remains `npx deskbeacon`, `deskbeacon setup`, and `deskbeacon service ...`. The CLI needs Node.js 24+. The original 0.1.0 bundled Windows x64 NativeAOT binary remains installable until users upgrade.

The running Service is **not** restarted or overwritten by the new packaging process. Finish any old jobs before a deliberate service restart after installing 0.2.x.
