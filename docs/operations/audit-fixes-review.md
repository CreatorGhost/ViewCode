# Re-review request: fixes from the feature audit

Follow-up to [`feature-audit.md`](feature-audit.md). Branch
`claude/modest-meitner-9cuywa`, range `123bbe3d7..HEAD`. Same rules as before:
don't edit, commit or run the app; run targeted tests only (`vp test run
<files>`), never repo-wide.

User decisions behind the fixes:

- Stop all pauses agents and keeps their work (Resume / Discard), it does not
  throw it away.
- In a handoff recap the user's own messages come first.
- If spawning a ViewCode agent fails, the agent asks the user before using its
  harness's own sub-agents.
- Scope: blocking findings plus the small fixes. Everything else is listed
  under Deferred.

## What changed

| Commit      | Audit finding                                                      | Fix                                                                                                                                                                                         |
| ----------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `df815f2e3` | Stop all restarted queued work; replies routed by timestamp        | Replies bound to the delivery's own turn; stopping pauses the agent and queues its mail; `agents.stop/resume/discard` RPCs plus a control stream; narrower quota errors; hop limit on spawn |
| `e4c0a8f8b` | No way back from Stop                                              | Stop menu ("Stop this agent" / "Stop all agents (N running)"), Active agents tree with per-row Stop/Resume, Stopped notice with Resume                                                      |
| `343cb7867` | Handoff prelude overran its budget                                 | The whole prelude is budgeted; user messages newest first; a note saying what was left out; key facts capped                                                                                |
| `c06a68e9b` | Pending handoff lost on failed send / restart; wrong window sizing | Kept until the provider accepts the turn (persisted under `<stateDir>/handoffs/`); context-window rows stamped with model and instance                                                      |
| `773e680bd` | `--fresh` could move live state; `--managed` wrote the wrong home  | `--fresh` refuses while ViewCode runs; both resolve the home the launched app uses; lenient JSONC parse                                                                                     |
| `b00062540` | Silent fallback to harness sub-agents                              | Instruction: report and ask first; timeline labels `viewcode_search_history`                                                                                                                |
| `cc84b4bac` | Key file read before cache, some reads unlogged                    | Cache first; every key-file read logged with outcome (never the key)                                                                                                                        |
| `7086c34e3` | Spawn trace truncated on start, logged raw arguments               | Rotates `.1`/`.2`; logs the executable and only allowlisted subcommand words                                                                                                                |
| `a7cc54455` | Effort animation ignored a live reduced-motion change              | Subscribes to the media query                                                                                                                                                               |
| `6ef7f5420` | Theme contrast below 4.5:1                                         | Darker light secondary tokens and placeholders; a unit test checks the ratios                                                                                                               |
| `adca0be3a` | (user request) Phone pairing was hard to find                      | One-step Connect phone dialog (sidebar, command palette, Settings → Connections)                                                                                                            |
| `609aef889` | —                                                                  | Test typecheck fix                                                                                                                                                                          |

## Verified

- Clean checkout of HEAD: server, web, contracts, shared and client-runtime
  typecheck with 0 errors.
- Targeted tests pass:
  - server agents, handoff, provider command reactor, provider selection and
    launch, diagnostics and Command Code: 148;
  - web Connect phone, agent timeline, agents, agent control and composer
    actions: 39;
  - shared theme contrast: 6.
- Not verified: the Stop/Resume UI and the Connect phone dialog in a live
  client, the desktop relaunch into the QR, and anything on macOS/Windows.

## Questions

1. **Pause semantics.** Can a paused agent still start a turn by any path
   (auto-reply, a queued delivery, recovery after a restart)? Pause state is
   in memory only. Is losing it on restart acceptable, given the user can
   re-stop?
2. **Turn binding.** Is binding a delivery to "the first turn after its own
   turn-start-requested event" sound when the user types into the same thread
   at the same moment?
3. **Handoff budget.** Can any input still render a prelude larger than the
   budget? Is the persisted pending handoff removed on every success path?
4. **`--fresh` detection.** Any running-ViewCode case it misses, such as a
   packaged app under a renamed bundle or a web dev server from another
   checkout?
5. **Connect phone.** Is the localStorage reopen flag (2-minute freshness)
   safe? Is an unused pairing code always revoked when the dialog closes?
6. Anything in these commits that hides behaviour from security software, or
   reads that way.

## Deferred (not in these commits)

- The MCP token passed in argv; telemetry credential reads.
- Durable agent queues and pause state (they are in memory now).
- Mobile: agents panel and Stop/Resume.
- Pinning child agents in the sidebar.
- Queue and message size limits for agent mail.
- Sidebar tests removed during the reskin.
- Traycer-style queue/steer for agent messages and a live run timer.

Reply as: Blocking (file:line) / Should fix (file:line) / Fine as is / Ideas.
