# ViewCode: what this fork adds, and what we learned building it

ViewCode is a fork of T3 Code. Everything in `AGENTS.md` still applies. This page
records the decisions ViewCode made on top of T3, and the traps that cost time,
so the next person (or agent) doesn't rediscover them. Product intent lives in
[`docs/PLAN.md`](../PLAN.md); verification status in [`docs/END_GOALS.md`](../END_GOALS.md).

## Where the ViewCode code lives

| Feature                                  | Main files                                                                                                                                                                                      |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mid-chat model/provider switch + handoff | `apps/server/src/orchestration/Handoff.ts`, `orchestration/Layers/ProviderCommandReactor.ts` (`takeHandoffPrelude`, `observedContextTokens`)                                                    |
| Child agents                             | `parentThreadId` on threads (contracts `orchestration.ts`, migration `055_ProjectionThreadsParentThreadId`), web `components/agents/*`, sidebar `components/sidebar/sidebarThreadTree.ts`       |
| Agent-to-agent messaging                 | `apps/server/src/agents/AgentMessaging.ts`, `agents/searchHistory.ts`, MCP toolkit `apps/server/src/mcp/toolkits/agents/`, envelope in `packages/shared/src/agentMessages.ts`                   |
| Command Code provider                    | `apps/server/src/provider/commandCodeCli.ts`, `Layers/CommandCode*.ts`, `Drivers/CommandCodeDriver.ts`, `Layers/commandCodeUsageLimits.ts`                                                      |
| Desktop local mode (no TCP port)         | `apps/server/src/socketListener.ts`, `mcp/McpStdioBridge.ts`, desktop `backend/DesktopLocalBackend*.ts`, web `lib/desktopBackendWebSocket.ts`                                                   |
| Composer model/effort picker, usage ring | web `components/chat/ComposerModelEffortPicker.tsx`, `composerModelEffort.logic.ts`, `ComposerUsageLimitsPopover.tsx`, `composerUsageLimits.logic.ts`                                           |
| Session import (picker, nesting, titles) | `apps/server/src/project/AgentSessionScanner.ts` (`classifyAgentSession`, `codexSessionOrigin`), `AgentSessionImporter.ts`, web `components/agentSessions/`                                     |
| Theme                                    | `packages/shared/src/themePalettes.ts` (`VIEWCODE_THEME`, web-only default), `viewcodeThemes.ts` (Droppy themes), `apps/web/src/viewcode-theme.css` (structure, keyed on `viewcode*` theme ids) |

## Decisions

### Staying mergeable with upstream

- ViewCode tracks upstream T3 Code by merging it. Features live in new files
  and hook into upstream code with small edits; theming goes through tokens
  and `components/ui` variants; contracts only gain optional fields; upstream
  features are hidden behind flags rather than deleted. Details and current
  hot spots: [`docs/NEXT_AGENT.md`](../NEXT_AGENT.md#staying-mergeable-with-upstream-t3-code).

### Handoff (switching provider or account mid-chat)

- The projected transcript is the source of truth; provider sessions are only a
  resume cache. Same continuation key → the native session continues. Different
  key → the new session starts with `freshSession: true` and the first turn gets
  a `<handoff>` prelude.
- Size is decided by the **incoming** model's context window, read from the
  latest `context-window.updated` activity (`maxTokens`) on any thread running
  that model; 128k is assumed until the model has reported once.
- If the whole conversation fits in 25% of that window it is carried verbatim.
  Otherwise: key facts (links, PR/issue numbers, branches, commits, file paths —
  extracted deterministically from messages _and tool results_), the user's
  messages newest first, the last 3 replies verbatim, older final answers; and
  the new model is told to build its own working summary and to call
  `search_history` before asking the user about earlier work.
- The user's own words are never summarized by a model. The outgoing model is
  never asked to summarize (it is usually out of quota — that's why the user
  switched).
- The full transcript (including tool results) is written under
  `<stateDir>/transcripts/<thread>/` and linked from the prelude, for providers
  without MCP (Command Code).

### Agent-to-agent messaging

- A message is a normal `thread.turn.start` whose text begins with a
  `<viewcode-agent-message …>` envelope. Idle receiver → starts now; busy →
  queued until its turn ends. `reply_expected` routes the receiver's final
  answer **from that turn only** back to the sender.
- Agents can reach only their own tree (root thread and all descendants). A hop
  limit (24) stops ping-pong loops.
- A turn that ends with a usage/plan/rate-limit error marks the agent "out of
  quota": the sender is told once ("do not message it again"), further sends
  are refused with the reason, and queued messages wait. Cleared by a successful
  turn or by `configure_agent` moving it to another model.
- `list_models` lists every enabled provider with `usable` and a `note`, and
  tells agents to use a vendor's own provider (GPT → Codex) over resellers
  (Command Code, OpenCode, Cursor) unless the user names the reseller.

### Command Code

- Headless CLI adapter (`cmd -p --output-format json`, `--resume <id>`).
- Its CLI loads MCP servers **only** from files (`~/.commandcode/projects/<slug>/mcp.json`,
  project `.mcp.json`, `~/.commandcode/mcp.json`); there is no flag, env var or
  mod API for a per-run config. So Command Code agents do not get the agents
  toolkit; they work as workers (receive tasks, their answers route back).
- Credits: Command Code documents usage only via its `/usage` overlay and
  commandcode.ai, and asks tools not to read its stored key. Reading
  `~/.commandcode/auth.json` + its `/alpha/billing/*` endpoints is therefore an
  explicit per-instance opt-in (`readAccountCredits`), cached 5 minutes, and
  every read is logged (key source, endpoints, statuses — never the key).

### Desktop local mode and phone access

- By default the desktop backend listens on a Unix socket (named pipe on
  Windows), reached by the window through the main process as
  `t3code-backend://<id>/`; providers reach MCP through a stdio bridge. No TCP
  port. `T3CODE_DESKTOP_BACKEND_TCP=1` forces TCP.
- Settings → Connections → Network access relaunches the app on TCP for phone
  pairing; turning it off returns to socket-only. `pnpm dev:desktop` is
  development mode and always uses a Vite port.
- ViewCode's desktop identity must never match T3 Code's: profile folder
  `viewcode`, app id `dev.viewcode.app`, WM class `viewcode`. Sharing T3's
  profile shared its IndexedDB lock and cached projects, which stalls first run
  on "Still connecting".

### Composer picker

- One chip (model + effort) opens a fixed-width popover modelled on Droppy
  Code's `EffortSlider.swift` (MIT; the reference for every visual detail):
  fast-mode button, effort title (opens the model list), reset, and a slider.
- Claude's slider ends at **Max**, as in Droppy. T3's extra levels are not
  effort levels: Ultracode is a Claude Code mode (a switch under the slider);
  Ultrathink is only a prompt keyword and is never written into the user's text.
- Smoothness rules, learned the hard way: the knob follows the pointer
  continuously and springs to a stop on release (Base UI's `step: 1` makes it
  teleport); drag state stays inside the slider so the composer doesn't
  re-render per move; the chip shows a fixed label while the popover is open so
  its anchor never resizes; solid fills only (browsers can't interpolate
  gradients); move things with `transform`, not layout.
- Looks follow Droppy's `TrackLook`: a solid fill below Max (the theme accent
  in ViewCode themes, a blue ramp in upstream ones), the provider's brand
  colour at Max, gold in fast mode, both blended in fusion.
- **The one deliberate exception to "no continuous animations"**: the Max /
  fast / fusion track draws Droppy's particles, streaks and lightning on a
  small canvas at 30–60fps. It runs only while the effort popover is open and
  above the plain level, pauses when the window is hidden, and is off under
  reduced motion. Anything wider or always-on needs a maintainer's sign-off.
- Compact names drop the "Claude " prefix ("Opus 5.5"); the provider is shown
  beside them. Handoff is shown once per provider list, not on every row.

### Session import

- **Hidden for now.** The "Import past sessions" menu items are removed and the
  onboarding step is off (`SHOW_SESSION_IMPORT_STEP` in
  `onboarding/WelcomeWizard.tsx`). Provider session files mostly brought in
  agent plumbing; the intended replacement is importing threads from a T3 Code
  install (see `docs/NEXT_AGENT.md`). "Remove imported sessions…" stays so users
  can clean up earlier imports. The server RPCs and dialog code remain.
- When shown, nothing is imported by default: sessions are picked one by one.
- `agentSessions.list` reads the recent transcripts without writing and marks
  junk `hidden` with a reason (`classifyAgentSession`): Codex sub-agent and
  internal rollouts, sessions opened by an agent message (Traycer or
  `<viewcode-agent-message>`), sessions whose user messages are only injected
  context, and one-message fragments under 200 characters. Hidden sessions are
  still importable behind "Show hidden".
- `agentSessions.import` takes an optional `sessions` list. Without it (older
  clients) it imports everything recent except Codex internal runs.
- Codex writes sub-agent rollouts beside main ones: `session_meta.payload.source`
  `{subagent: {thread_spawn: {parent_thread_id}}}` (rollouts spell it
  `subagent`, the app-server protocol `subAgent`). A child nests under its
  parent when the parent is imported in the same run or already exists
  (second pass for children that arrive first); otherwise it imports flat.
  Titles skip injected blocks and Traycer headers.
- Imported threads have `import:` ids. "Remove imported sessions" archives
  them (restorable from Settings → Archive) and pre-checks only those with no
  turn and no provider session, i.e. never continued.

### Brand assets

- The logo source is `assets/viewcode-icon.svg` (app tile) and
  `assets/viewcode-mark.svg` (mark alone). The production PNG/ICO files under
  `assets/prod/` and `apps/web/public/` are regenerated from it **in place,
  under T3's file names**, so no code path changes and upstream merges only
  conflict if upstream redraws its own icons (keep ours). macOS uses the
  824px-on-1024 grid with a baked shadow; iOS and apple-touch are square (the
  OS masks them). `.icns` is built from the PNG at package time. Dev builds
  keep T3's blueprint icons in `assets/dev/`.
- In the UI the mark is `T3Wordmark.tsx` (T3's name kept for the same reason).

## Traps (things that cost hours)

- **Running as root in a sandbox:** Claude refuses `bypassPermissions` as root;
  start the dev server with `IS_SANDBOX=1`. Four server tests (keybindings,
  cli/theme, server stat, terminal Manager) fail only as root.
- **No IPv6 in some sandboxes:** port probing treats `EAFNOSUPPORT` as
  available (`packages/shared/src/Net.ts`).
- **Stale Electron processes** from earlier test runs keep the profile's
  IndexedDB `LOCK`; the renderer then never opens its WebSocket and shows
  "Still connecting". Find holders via `/proc/*/fd` pointing at the profile,
  kill by PID. A killed backend may be respawned by a surviving main process.
- **The desktop renderer uses a hash router** (`t3code://app/#/settings/…`);
  `history.pushState` does nothing there.
- **Turning on network access relaunches Electron**, so Playwright loses its
  handle; drive each phase as a separate launch against the same home.
- **Playwright's Electron launch adds `--inspect`/`--remote-debugging-port`
  listeners**; don't count them as app ports.
- **`apps/server/src/cli/triagePrompt.ts` must stay byte-identical** to
  `.github/triage/PLAYBOOK.md`; don't rebrand one without the other.
- **Effect lint** prefers `Effect.filterOrElse` over `flatMap` with an identity
  branch, and `DateTime` over `new Date()`.
- **The production CSS minifier rewrites a nameless `animation` shorthand to
  `animation: none`**, silently dropping duration and fill mode; dev (unminified)
  looks fine. Use longhands (`animation-duration`, …) in `viewcode-theme.css`,
  and check animations against a production build (`vp build`, then run the
  server without `--dev-url` so it serves `apps/web/dist`).
- **tailwind-merge** drops one of two background images in `cn(...)`; keep
  sparkle/gradient classes out of `cn()`.

## Running and verifying locally

```bash
corepack enable && pnpm install
pnpm build:desktop && pnpm --filter @t3tools/desktop start   # desktop, socket mode
pnpm dev                                                      # server + web UI
```

State lives in `~/.viewcode`; server log `~/.viewcode/userdata/logs/server-child.log`.
Screenshots proving each goal are in `docs/evidence/`.
