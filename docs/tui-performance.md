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
