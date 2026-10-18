# DeskBeacon client development and Agent dogfooding

This document is for contributors; the public README intentionally stays focused on features and deployment.

## Offline demo mode

From the monorepo root:

```bash
pnpm --filter @deskbeacon/protocol build
pnpm --filter deskbeacon demo
# Or after a client build:
node apps/client/dist/index.js demo busy
node apps/client/dist/index.js demo failed
node apps/client/dist/index.js demo transfers
node apps/client/dist/index.js demo crowded
```

Scenarios: `connected`, `connecting`, `offline`, `busy`, `failed`, `transfers`, `crowded`.

While the demo TUI is running, press:

| Key | Change |
| --- | --- |
| 1 / 2 / 3 | Connected / connecting / offline |
| 4 / 5 / 6 | Inject failed / running / completed command |
| 7 | Cycle 0, 2, 9 background tasks |
| 8 | Create / advance an in-progress file transfer |
| 9 | Change CPU, RAM, operation count and RTT |
| 0 | Reset to connected |
| ? | TUI help, including demo shortcuts |
| q | Exit |

No OAuth, server, WebSocket, IPC or command execution is involved. All data is synthetic. Demo mode must never reuse a live Runtime or alter real local state.

## Verification

- `pnpm test`, `pnpm check`, `pnpm build`
- `pnpm test:local` includes pure demo fixture checks
- Preview multiple terminal sizes in Windows Terminal and VS Code integrated terminal, including small displays.
- A real Agent/Worker/device end-to-end test is separate and needs an online device.

## Dogfood results / follow-up

2026-10-18: attempted real Agent device discovery, source reading and local CLI inspection with the ChatGPT DeskBeacon plugin. The device existed in KV but was offline, so every device-scoped tool returned DEVICE_OFFLINE. Remote Desktop Commander also reported the computer offline. A real working-session evaluation cannot be claimed yet; resume when device connectivity returns.

Improvements prompted by inspection:
- Return actionable recovery advice on DEVICE_OFFLINE rather than exposing only an opaque failure.
- Write descriptions for all 34 MCP tools, especially command versus background, workspace cwd semantics, paging, and transfer limits.
- Keep UI demo completely isolated from production credentials.
- Fix the transfer presentation to use the task's actual start time and show a bounded progress percentage.

Next device-online dogfood exercise (do not operate on repository production files except with explicit changes): create isolated workspace in .test-data, list/read/grep files, use expectedHash edit, build/test in foreground, spawn background dev server, inspect localhost HTTP, send stdin, stop process tree, archive, transfer and verify SHA-256.
