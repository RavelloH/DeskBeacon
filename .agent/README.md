# DeskBeacon engineering knowledge base

This is the engineering notebook for Codex and other coding agents. Only this instruction/index file is tracked by Git; the other files under `.agent/` (plans, test evidence, performance reports, temporary scripts and release notes) are intentionally ignored. Historical plans are not proof of implementation.

## Module index

| Folder | Scope |
|---|---|
| 00-overview | Goals, non-goals, decisions, glossary |
| 01-architecture | Cloudflare topology, OAuth, per-device DO, wire protocol |
| 02-mcp | MCP tool catalog, result shapes, host compatibility |
| 03-client | Node daemon, IPC, local persistence, Shell and workspace |
| 04-execution | Foreground sync execution, batches, explicit background sessions |
| 05-filesystem | Files, ripgrep search, native archiving |
| 06-transfer | Agent↔Desk binary transfer; never persisted in cloud |
| 07-network | TCP/DNS/TLS diagnosis and local HTTP requests |
| 08-system | OS snapshots, process listing, screenshots |
| 09-tui | (( · )) text UI, searchable timeline, bottom running tasks |
| 10-security | Trust boundaries, OAuth/session integrity, no duplicate approval |
| 11-delivery | Milestones, dependencies, acceptance criteria |
| 12-tracking | Live status, task matrix, decisions/questions/test ledger |

## Execution report policy (mandatory for every Agent)

- **Never add or commit execution reports to the repository.** This includes task completion reports, investigation summaries, debugging reports, benchmark findings, test/run output, performance notes, migration execution records, release verification notes, or other Agent-generated work summaries.
- Create and update these reports **only inside `.agent/`**, organized by topic (for example `.agent/12-tracking/` or `.agent/11-delivery/`). Do not put them in `docs/`, the repository root, `README.md`, or a source directory.
- Keep all report, test-fixture, scratch, and temporary files under `.agent/` **untracked**. Never use `git add -f`, `git -f add`, or ignore-rule changes to stage such files. The **only** Git-tracked exception in `.agent/` is this `README.md`, which must contain instructions/indexes, not execution reports.
- Before every commit, inspect `git diff --cached --name-only` and `git status --short`. Remove any execution report or generated artifact from the Git index before committing or pushing.
- Product documentation, code, tests, and user-requested configuration changes are permitted to be committed; distinguish them from Agent execution reports. Report outcomes to the user in the conversation, and store optional detailed evidence only under ignored `.agent/`.

## Documentation rules

Each feature should identify Agent-facing tool, client executor, Worker/DO involvement, local storage, cancellation/timeout semantics, MCP response budget, errors, and tests. If details are unproven, mark as **TBD / verify**, not completed.

**Priorities:** correctness across interruptions; low idle DO activity; native tools where CLI emulation would be inefficient; concise structured results; Windows shell reliability; file transfer that does not leak raw binary to model context.

## Current phase

Implementation and live-device testing are underway. For current Linux tool findings read 12-tracking/2026-10-19-linux-tools.md. Local-only engineering reports are at 11-delivery/npm-release.md and 09-tui/tui-performance.md. These files must remain ignored by Git.
