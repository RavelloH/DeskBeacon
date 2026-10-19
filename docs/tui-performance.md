# TUI profiling and optimization (2026-10-19)

The CLI uses React/Ink in production mode by default (via the isolated npm launcher) to avoid unbounded development-only Performance Timeline instrumentation.

## Measurements (ASUS TUF F16, Node.js 24, Windows, production-mode Ink)

CPU profile of a 160×43 terminal for 30 seconds:
- 19,635 samples, 18,940 idle (96.5%).
- Top non-startup self-time hotspots: `string-width`, Ink layout / ANSI diff, terminal string clipping.
- Idle usage is relatively low in production, but interactive updates are dominated by full-list time formatting and re-rendering completed rows.

Real SQLite history: 2,200 entries, benchmark median with the same input records:

| Hotpath | Before | After | Notes |
|---|---:|---:|---|
| Calculate maximum TIME column width | 117.6 ms | 15.8 ms | Reuses Intl.DateTimeFormat; memoized across clock/status ticks |
| Format 40 activity table models | 7.1 ms | 3.6 ms | Faster time formatting and single string-width calculation |
| Selected DETAIL presentation | 0.38 ms | 0.39 ms | Already memoized and not a bottleneck |

Measured in `apps/client/test/bench-hotpaths.mjs` as a local profiling fixture; it reads only the local SQLite database in read-only mode and was intentionally not committed because test machines differ.

## Changes

- `activityTime` reuses `Intl.DateTimeFormat` instances; output remains identical for today's time and historical HH:mm cells.
- `longestTime` uses `useMemo` keyed to the loaded activity array and current *local calendar day*, rather than rescanning all entries every second.
- `ActivityTableRow` is `React.memo` with stable record/column/date props; completed rows no longer reparse large JSON and format text on status refresh. Running durations/spinners retain their own timers.
- The selected activity model is memoized for completed entries; running entries continue to receive updates.
- `fit` avoids a redundant `string-width` call, and daily stats / columns reuse memoized structures.

The layout, terminal width rules, UTC/local-day rollover, navigation and live updates must remain unchanged. Profiling results are input/hardware dependent and do not constitute claims about all platforms.

## Regression commands

```powershell
pnpm check
pnpm test
pnpm test:local
node apps/client/test/tui-workbench.mjs
```

The production npm binary is the `launcher.js` bootstrap, not the development TypeScript entry point.

## 2026-10-19 — Shared animation timer / native packaging recheck

### Profiling findings

The remaining hot paths in a production-mode Ink CPU profile were `stringWidth`,
ANSI tokenization/diff, and terminal layout. Multiple independent 160ms spinners,
a 100ms running-duration label, and 500ms elapsed counters were driving far more
full-screen updates than the information actually changed.

- All visible spinners and the subsecond running-duration label now subscribe to
  one 200ms animation clock using `useSyncExternalStore`. The timer is disposed
  when the last consumer unmounts.
- The running-duration label formats elapsed time from the original timestamp
  without reparsing request/result JSON every animation frame.
- Elapsed labels that display whole seconds now refresh every 1000ms.

For the original 12s measurement fixture on Windows x64, Node 24,
160×43 terminal and demo `busy` scenario:

| Metric | Before | After | Relative reduction |
| --- | ---: | ---: | ---: |
| Ink stream writes per second | 51.7 | 19.4 | 62.5% |
| Terminal output KB/s | 130.5 | 48.8 | 62.6% |
| CPU time during 12 seconds | 2109 ms | 1203 ms | 43.0% |

The initial one-off fixture counted first paint in stream volume while measuring
CPU after its one-second warmup; figures above are comparative, not exact
steady-state rates. The committed benchmark below excludes warmup from both.

Reproducible, read-only production-mode benchmark (does not connect to a
DeskBeacon service or Cloudflare):

```powershell
pnpm --filter deskbeacon build
node --expose-gc apps/client/test/bench-tui-io.mjs busy 60000 15000
node apps/client/test/bench-tui-io.mjs crowded 12000
```

In a 60-second `busy` soak with a 15s full-GC sample interval:
- 17.4 Ink stream writes/s; 43.2 KiB/s of terminal output; 4.4s CPU time
  (7.3% of one logical core).
- Heap after GC at 15s/30s/45s/60s: 29.5 / 28.8 / 27.8 / 27.8 MiB.
- RSS at 15s/30s/45s/60s: 234.8 / 253.8 / 256.0 / 256.1 MiB.

The 60-second run did not show persistent JS heap growth. RSS remains relatively
high and longer runs are still necessary to rule out slower native/Ink leaks.
Repeated Ink layout and ANSI diff remain the residual CPU cost of animation.

### Native package validation

Local Windows x64 LLVM-mingw compiled both C helper variants (22,016 bytes for
x64; 20,480 bytes for ARM64). Both passed PE architecture validation; x64
passed actual process launch. Three independent npm tarballs were packed and
inspected. A clean isolated Windows x64 install of `deskbeacon@0.2.0` plus
`@deskbeacon/win32-x64@0.2.0` launched `version` and `help` and located
the native exe in the scoped optional package.

GitHub Actions run 39195312445, commit 98559c0, completed successfully for:
LLVM-mingw cross-build and npm pack, Windows x64 lifecycle, and actual Windows
ARM64 native execution and Job Object cleanup.

Do not publish npm packages merely because these tests pass; package release
and service restart remain separate explicit operations.

A second, warmup-excluded 8s run using the committed benchmark produced:

| Scenario | Stream writes/s | Output KiB/s | CPU (% of one core) |
| --- | ---: | ---: | ---: |
| Connected, no active task | 3.0 | 7.2 | 1.7% |
| Busy, running command and two background tasks | 18.7 | 46.4 | 9.0% |

Active-task animation still uses more CPU than an entirely idle TUI,
primarily from Ink's per-frame layout/diff; this is a known residual tradeoff
rather than evidence of task or network polling at that rate.
