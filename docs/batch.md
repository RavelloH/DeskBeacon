# Universal MCP tool batching

`batch` composes existing authenticated DeskBeacon MCP tools on **one device**, through the Worker. The old `exec_batch` stays temporarily as a deprecated compatibility tool.

## Example

```json
{
  "deviceId": "paired-device-id",
  "description": "Inspect source and run tests",
  "stages": [
    {
      "parallel": true,
      "calls": [
        {"id":"read","tool":"fs_read","input":{"path":"src/index.ts","maxBytes":2000}},
        {"id":"find","tool":"fs_grep","input":{"path":"src","pattern":"connect"}}
      ]
    },
    {
      "calls": [
        {"id":"tests","tool":"exec_foreground","input":{
          "description":"Run tests",
          "command":{"mode":"program","program":"pnpm","args":["test"]}
        }}
      ]
    }
  ]
}
```

## Rules and safety

- Stages execute serially; `parallel:true` allows only known read-only tools, at most four concurrent RPCs. Mutations and commands must be serial.
- Each call has a unique `id`, a valid standalone tool `tool`, and an `input` object. The top-level device ID is injected; attempting to change it is rejected.
- Defaults to `failFast:true`. Any tool error, thrown exception, or nonzero `exec_foreground` exit code stops subsequent operations/stages. With `failFast:false` it continues. Parallel stages finish all already-issued operations before deciding.
- Results include `stages`, `completed`, `failed`, `skipped`, `stoppedEarly`, and each call's `ok`, duration, result/error. Do not infer command success from the MCP transport alone.
- Max 6 stages, 6 calls per stage and 16 calls total. Each subresult is bounded to 4 KiB by default, configurable from 1–8 KiB; oversized results explicitly identify truncation and available operation IDs.
- **Not a transaction:** no rollback, no output-to-input interpolation, no parallel writes, and no cross-device operations. Screenshot and inline binary transfers are excluded to protect result budgets.
- OAuth Grant and device-scoped security remain unchanged: Worker invokes each subtool through existing validation and DO/Daemon routing. Batch itself cannot recurse.

## Tradeoff and test

Server-only orchestration improves Agent ergonomics without a new local client protocol, but each subtool still costs an individual DO RPC and generates its own activity entry. Measure real latency and Worker/DO billing before optimizing further.

Verified with unit tests plus real local OAuth / MCP / Durable Object / Windows Daemon tests: parallel `fs_read` + `fs_stat` followed by serial `exec_foreground`, and missing-file fail-fast. See `apps/server/test/batch.test.ts` and `apps/server/test/local-oauth-e2e.mjs`.
