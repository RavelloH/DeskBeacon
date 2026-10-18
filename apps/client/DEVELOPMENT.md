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


## 2026-10-18 — Real Agent work session

Connected through the actual ChatGPT DeskBeacon tools and worked in an isolated Node.js test project in the ignored `.test-data` directory, not via Remote Commander. Verified `fs_manage`, `fs_write`, `workspace_open`, `fs_grep`, `fs_stat`, compare-and-swap `fs_edit`, a deliberately failing test, a corrected implementation, and parallel `exec_batch` producing three passing tests. A background local HTTP server was launched through `exec_background`; logs were inspected with `background_output`, localhost JSON was retrieved through `http_request`, and stdin was written with `background_input`.

Agent UX friction verified: failed TCP probes surfaced as an opaque tool error instead of a negative network result. Fixed TCP/TLS probes to return `connected:false` with `errorCode`, `errorMessage`, and timing. `background_output.maxLines` was ignored by the daemon dispatcher; fixed forwarding and exposed `nextCursor` or per-stream `nextOffsets`. Also confirmed that sending an application-level `quit` command can close its TCP listening socket without exiting the process if it retains a stdin listener; this is not a supervisor state bug. Use EOF or explicit stop, and do not infer process exit from port closure.

### Recommended future tools (priority)

1. `fs_read_many`: bounded batch read of several source files with per-file truncation, byte budget and hashes. Reduces setup latency and repeated tool calls.
2. `fs_edit_batch`: atomic or well-described multi-file CAS edit with dry-run, diff and per-file failures. Multi-file refactors currently require many serial tool invocations.
3. `git_status` / `git_diff`: structured read-only working tree status, patch summary and change hazards, without shell quoting and raw terminal parsing. Optional mutating git commands can remain in exec.
4. `background_wait` or `process_wait`: wait for exit/readiness with bounded timeout, exit code and last output, instead of polling background_get.
5. `net_wait`: await TCP/HTTP readiness locally using an explicit finite timeout and useful refusal diagnoses; particularly valuable after starting development servers.
6. `fs_hash` / `fs_compare`: check binary transfer integrity and duplicate files without downloading content into the Agent.
7. `system_environment`: summarized runtime versions, PATH resolution, drive free space and shell diagnostics (redacted), without exposing arbitrary environment secrets.
8. `operation_batch`: group short filesystem/search/stat reads under one RPC where latency dominates.

Keep the initial v1 scope and avoid automatically exposing general-purpose destructive process-kill or external network upload surfaces. A tool should justify its addition through repeated Agent friction, not just feature count.


### Follow-up: file ranges

A real `fs_read(lineOffset:10,maxLines:8)` returned only the requested lines but reported `readBytes` equal to the entire source and `truncated:false`. More seriously, code beyond the initial byte window could not be read by line number. Replaced post-read string slicing with a bounded streaming line reader that scans from file start to the requested line, produces at most `maxBytes` of result text, and reports `linesRead`, `nextLineOffset`, `truncated`, and available `totalLines`. Byte-mode reads return `nextByteOffset`. Reject incompatible binary/line or simultaneous byte/line offsets. Added tests for large UTF-8 (including Chinese), UTF-16LE, EOF and too-small output budgets. Large line-offset scans are O(file prefix size); future indexing could optimize repeated deep jumps.

## 2026-10-18 — Agent context gathering: fs_read_many

Added `fs_read_many` as the 35th MCP tool. Input is `{deviceId, files:[{path, encoding?, byteOffset?, maxBytes?, lineOffset?, maxLines?}], maxTotalBytes?, includeHash?, workspaceId?}`, with at most 8 files, at most 8 KiB per file and at most 64 KiB per batch (32 KiB default). Each item returns the existing `fs_read` continuation metadata and optional streamed SHA-256. Per-file errors do not abort the request; the budget is enforced cumulatively and exhausted entries explicitly report `BATCH_BUDGET_EXHAUSTED`. The tool also uses the grant-scoped workspace directory when provided.

Dogfood and verification: all edits and checks were made through the already-connected DeskBeacon MCP service in a dedicated `feature/fs-read-many-agentux` worktree. Monorepo TypeScript checks, Worker dry run, protocol/server unit tests, full Windows local client tests, independent multi-read fixtures, and the complete local OAuth -> MCP -> Durable Object -> Node daemon E2E suite passed. The E2E additionally invokes `fs_read_many` with two readable source files and one absent file, asserting success count 2, failure count 1, SHA-256 and source contents.

Local Wrangler requires `MCP_BASE_URL=http://localhost:8787` in its isolated test-only .dev.vars to ensure the resource name matches the OAuth consent flow. This is a development configuration, not a production change. No runtime was restarted in the user's main terminal during the implementation.

Further Agent UX improvements to consider: a bounded readiness/wait tool for background processes, structured Git working tree inspection, and atomic compare-and-swap multi-file edits. Prioritize measured reduction in tool calls over adding many overlapping tools.
