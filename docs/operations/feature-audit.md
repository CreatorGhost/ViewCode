# ViewCode feature audit (for an independent reviewer)

A full, read-only audit of everything ViewCode adds on top of T3 Code. Branch
`claude/modest-meitner-9cuywa`. Upstream fork point: `ed809f7ad`, so
`git diff ed809f7ad..HEAD` is the whole fork. Context:
[`../internals/viewcode.md`](../internals/viewcode.md) (decisions and traps),
[`../NEXT_AGENT.md`](../NEXT_AGENT.md), [`managed-mode-plan.md`](managed-mode-plan.md).
The earlier, narrower request [`review-request.md`](review-request.md) covers
the managed-mode build only; this document supersedes it for scope.

**Rules for the reviewer:** don't edit, commit, or run the app. Read code and
tests; run targeted tests only if you need evidence (`vp test run <files>`,
never repo-wide). Nothing may hide behaviour from security software.

**For each feature, answer:** (a) does the code do what "Intended behaviour"
says, (b) the listed risk questions, (c) anything missing (tests, other
clients, reverse states, docs). Cite `file:line`.

**Reply format:** per feature: Blocking / Should fix / Fine as is. Then an
overall top-10 list by severity, then Ideas, then Questions for the user.

---

## 1. Handoff: switching model or provider mid-chat

**Intended behaviour.** The projected transcript is the truth. Same
continuation key → the native session continues. Different key → a fresh
session whose first turn gets a `<handoff>` prelude. If the conversation fits
in 25 % of the **incoming** model's context window
(`HANDOFF_CONTEXT_SHARE`, window read from `context-window.updated`
activities, 128k default) it's carried verbatim. Otherwise **compact mode**:
the user's own messages (never model-summarized, newest first), the last 3
replies verbatim, older final answers, and deterministic key facts (links,
PR/issue numbers, branches, commits, paths from messages and tool results); the
new model builds its own summary and can call `viewcode_search_history`. The
full transcript is written to `<stateDir>/transcripts/<thread>/` for providers
without MCP.

**Code.** `apps/server/src/orchestration/Handoff.ts`,
`orchestration/Layers/ProviderCommandReactor.ts` (`takeHandoffPrelude`,
`observedContextTokens`), `agents/searchHistory.ts`. Tests:
`Handoff.test.ts`, `ProviderCommandReactor.test.ts`.

**Verified.** Between two Claude accounts, live. **Not verified:**
Claude ↔ Codex live, compact mode on a real long thread.

**Risk questions.**

1. Can a very long user message or a huge tool result blow the budget even in
   compact mode (clip rules, 300-char clipped user messages with a pointer)?
2. Is the window lookup right when the incoming model has never reported
   (default 128k) or reports a smaller window than the conversation?
3. Key-fact extraction: false positives or missed PR links, and a size bound?
4. Does anything leak between threads (search_history scope)?
5. Is "the user's own words are never summarized by a model" actually true on
   every path?

## 2. ViewCode agents (child agents) and agent-to-agent messaging

**Intended behaviour.** A child agent is a full thread with `parentThreadId`,
shown nested in the sidebar; the user can open, prompt and switch its model.
Agents talk through the `t3-code` MCP toolkit, **all tools prefixed
`viewcode_`** (`viewcode_list_agents`, `viewcode_list_models`,
`viewcode_spawn_agent`, `viewcode_send_message`, `viewcode_read_transcript`,
`viewcode_search_history`, `viewcode_configure_agent`). A message is a normal
turn whose text starts with a `<viewcode-agent-message …>` envelope; an idle
receiver starts at once, a busy one queues; `reply_expected` routes the
receiver's final answer **from that turn** back. Scope: the caller's own tree.
Hop limit 24. A usage/plan-limit error marks the agent out of quota: the
sender is told once, further sends are refused. `viewcode_list_models` says to
prefer the vendor's own provider unless the user names a reseller.

**Recent fix to check.** Codex ships a built-in tool named `spawn_agent`;
with the bare name, requests for "sub-agents" went to Codex's own inline
sub-agents. Tools are now `viewcode_*` (like Traycer's `traycer_*`) and the
runtime instructions (`provider/RuntimeInstructions.ts`,
`<viewcode_agents>`) define ViewCode agents vs harness-native ones.

**Code.** `apps/server/src/agents/AgentMessaging.ts`
(`AGENT_MESSAGE_MAX_HOPS`), `mcp/toolkits/agents/{tools,handlers}.ts`,
`mcp/McpProviderSession.ts`, `provider/Layers/ProviderService.ts`
(`prepareMcpSession`, `agentAccessCapabilities`),
`packages/shared/src/agentMessages.ts`, web `components/agents/*`,
`components/sidebar/sidebarThreadTree.ts`,
`components/chat/agentTimeline.logic.ts`, `hooks/useThreadActionMenu.ts`
("New child agent"). Contracts: `parentThreadId` in `orchestration.ts`,
migration `055_ProjectionThreadsParentThreadId`.

**Not verified:** the renamed tools with a real Codex session; child agents
from Claude on a machine with a Claude Code enterprise MCP policy (the policy
may ignore ViewCode's MCP server).

**Risk questions.**

1. Will models reliably pick `viewcode_spawn_agent` over a harness's own
   sub-agent tool now? Is anything else in the instructions or tool
   descriptions still ambiguous (e.g. `viewcode_send_message` vs other
   harness tools)?
2. Tree scoping and the hop limit: can an agent reach outside its tree, or
   loop under the limit forever (A↔B ping-pong with reply_expected)?
3. Reply routing: can the wrong turn's answer be sent back (race between a
   queued message and a user prompt on the same child)?
4. Out-of-quota handling: false positives from `LIMIT_ERROR_PATTERN`; is the
   state cleared correctly?
5. "Stop all" stops children; does a queued delivery restart a stopped or
   disabled agent?
6. Old sessions' tool calls still render (bare names accepted in
   `agentTimeline.logic.ts`); is anything else keyed on the old names?
7. Mobile: child agents show flat and envelopes as raw text; acceptable?

## 3. In-chat (harness-native) sub-agents

**Intended behaviour.** Codex's own sub-agents (`collabAgent/*` events) and
Claude's `Task` are shown inline in the parent chat, read-only ("Kicked off 2
subagents"). Used only when the user asks for built-in/inline ones.

**Code.** `provider/Layers/CodexAdapter.ts` (`mapCollabAgentEvent`), web
`components/chat/agentSpawnSummary.ts`, `MessagesTimeline.logic.ts`,
`session-logic.ts`.

**Risk questions.** Is the inline view clearly distinguishable from ViewCode
agents? Any state (status "Working") that can get stuck when a native
sub-agent is killed?

## 4. Providers: Command Code, provider choice, launch guard

**Command Code.** Headless CLI adapter (`cmd -p --output-format json`,
`--resume`). MCP only via files, so no agents toolkit; works as a worker.
Credits read from `~/.commandcode/auth.json` only when
`readAccountCredits` is on (default off), cached 5 min, every read logged
(never the key). Code: `provider/commandCodeCli.ts`,
`provider/Layers/CommandCode*.ts`, `Drivers/CommandCodeDriver.ts`,
`Layers/commandCodeUsageLimits.ts`.

**Provider choice (first run).** Fresh home → `providerSelection: "pending"`,
every instance effectively off (gate in `deriveProviderInstanceConfigMap`),
nothing launched until the user chooses in onboarding / Settings → Providers;
existing homes migrate to `chosen`. RPCs `server.detectProviders`
(filesystem only) and `server.chooseProviders` (initial choice only). Code:
`provider/providerSelection.ts`, `providerLaunch.ts`, web
`onboarding/ProviderChoiceStep.tsx`, `ProviderChoicePendingNotice.tsx`,
`onboarding/providerChoice.logic.ts`, `settings/ProviderSettingsPanel.tsx`.

**Launch guard.** Every provider launch resolves the executable (uncached,
right before launch), runs the resolved path, fails closed; Windows
`.cmd/.bat` recovered from the shell wrapping; OpenCode server owner and Claude
SDK covered. Code: `provider/providerBinary.ts`, `withProviderLaunchGuard` in
`Layers/ProviderInstanceRegistryLive.ts`, `Drivers/ClaudeExecutable.ts`.

**Claude enterprise policy.** With `managed-mcp.json` present the probe and
title generation drop `--strict-mcp-config`, the probe error is shown, and
`claude auth status` is the fallback. Code:
`Drivers/ClaudeEnterprisePolicy.ts`, `Layers/ClaudeProvider.ts`,
`textGeneration/ClaudeTextGeneration.ts`.

**Verified on the managed laptop:** the app survives with Codex/OpenCode/Grok
off (see [`managed-mac-experiments.md`](managed-mac-experiments.md)).
**Not verified:** the new build there; the enterprise-policy fix against the
real policy file.

**Risk questions.** Any launch path the gate or guard misses? The Windows
un-escaping approach? Migration edge cases (pending across restarts,
malformed settings, persistence failure)? Stale second `choose`?

## 5. Composer: model/effort picker, usage, context window

**Intended behaviour.** One chip opens a fixed-width popover (Droppy-style):
fast-mode button, effort title, reset, a continuous-drag slider that springs
to a stop. Claude's slider ends at Max; Ultracode is a switch; Ultrathink is
never written into the user's text. Track looks: plain, Max (brand colour +
particles/lightning on a small canvas), fast, fusion; Grok silver. The effort
name rolls letter by letter when it changes (keyframes in
`viewcode-theme.css`, longhands because the minifier breaks the shorthand).
Model view: provider rail, four rows, 360 px. Usage popover shows the context
window plus plan limits.

**Code.** web `components/chat/ComposerModelEffortPicker.tsx`,
`effortTrack.ts`, `composerModelEffort.logic.ts`, `ModelPickerContent.tsx`
(`fillContainer`), `ComposerUsageLimitsPopover.tsx`,
`composerUsageLimits.logic.ts`, `providerIconUtils.ts`.

**Risk questions.** The canvas animation is the documented exception to "no
continuous animations": does it really stop when the popover closes, the
window is hidden, or reduced motion is on? Any re-render per pointer move
outside the slider? Keyboard access to the slider and the rail?

## 6. Desktop: local mode, phone access, identity, resilience

**Intended behaviour.** The desktop backend listens on a Unix socket (named
pipe on Windows), reached through the main process as `t3code-backend://`;
providers reach MCP through a stdio bridge; no TCP port. Settings →
Connections → Network access relaunches on TCP for phone pairing. App identity
is `viewcode` / `dev.viewcode.app`, never T3's. A backend killed 3 times in
2 minutes stops being restarted (native dialog); Help → Open Logs Folder;
built-in spawn trace at `<stateDir>/logs/spawn-trace.log`.

**Code.** `apps/server/src/socketListener.ts`, `mcp/McpStdioBridge.ts`,
desktop `backend/DesktopLocalBackend*.ts`, `backend/backendRestartCap.ts`,
`app/DesktopEnvironment.ts`, web `lib/desktopBackendWebSocket.ts`, server
`diagnostics/spawnTrace.ts`.

**Not verified:** Windows named pipes; macOS Finder launch of a packaged DMG.

**Risk questions.** Anything still opening a TCP port in local mode (OpenCode
`serve` does, by design; others)? Socket permissions? Does the spawn trace
ever record prompt text?

## 7. Look: theme, glass window, amber, logo, migration

**Intended behaviour.** `VIEWCODE_THEME` (neutral palette, logo-amber accent,
used on the send button, focused composer, user bubble tint, links, active
thread); Droppy-derived named themes; all ViewCode-only CSS in
`viewcode-theme.css`. Desktop glass: macOS vibrancy / Windows 11 Mica, for
every theme, toggle in Settings → Appearance, off under Reduce transparency.
Old profiles switch once to the ViewCode theme with an Undo toast. New logo;
platform icons regenerated in place under T3's file names.

**Code.** `packages/shared/src/{themePalettes,viewcodeThemes}.ts`,
`apps/web/src/viewcode-theme.css`, `apps/desktop/src/window/WindowGlass.ts`,
`windowGlassPreload.ts`, web `settings/WindowTransparencySetting.tsx`,
`viewcodeLookMigration.ts`, `components/T3Wordmark.tsx`, `assets/`.

**Not verified:** real vibrancy on macOS, Mica on Windows.

**Risk questions.** Contrast in light and dark; any surface that paints a
solid block under glass; GPU cost (no `backdrop-filter` on large areas); is
the one-time theme switch acceptable?

## 8. Build and install

**Intended behaviour.** `./build.sh` pulls, installs, builds, opens the
desktop app; private Node 24 and pnpm in `~/.viewcode-tools` (never in the
data folder); `--use-system-ca` for corporate TLS; `--fresh` moves data aside
(timestamped, restorable); `--managed` pre-chooses Claude + Cursor; `--web`.
SPDX license texts vendored (offline builds); `dev-runner` finds `vp` in
`node_modules/.bin`; installers named `ViewCode-<version>-<arch>`.

**Code.** `build.sh`, `.generated/third-party-licenses/`,
`scripts/dev-runner.ts`, `scripts/build-desktop-artifact.ts`.

**Risk questions.** `build.sh` on a stock Mac without GNU tools; `--fresh`
while the app is running; a settings file with comments under `--managed`.

## 9. Session import (hidden) and cleanup

**Intended behaviour.** Importing Claude/Codex session files is hidden (menu
items removed, onboarding step off via `SHOW_SESSION_IMPORT_STEP`); "Remove
imported sessions…" stays. Code: `project/AgentSessionScanner.ts`,
`AgentSessionImporter.ts`, web `components/agentSessions/`.

**Risk question.** Is anything still reachable that imports files
automatically?

## 10. Cross-cutting

1. **Upstream mergeability:** list the upstream files with the largest ViewCode
   diffs (`git diff --stat ed809f7ad..HEAD`) and where a smaller hook would do.
2. **Surfaces:** web, desktop, mobile. What's missing on mobile?
3. **Performance:** WebSocket payload growth (agent envelopes, activities),
   new always-on work, render hot paths.
4. **Security and privacy:** credential file reads (telemetry identity reads
   `~/.codex/auth.json` / `~/.claude.json` even with telemetry off, a known
   item), MCP bearer tokens in env, logs.
5. **Docs:** anything in `docs/` now wrong.

## What is verified vs not (summary)

| Area                    | Verified                                                                              | Not verified                                                        |
| ----------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Handoff                 | Claude ↔ Claude live, unit tests                                                      | Claude ↔ Codex live, compact mode live                              |
| ViewCode agents         | earlier live demos (spawn, message, stop all), unit tests                             | renamed `viewcode_*` tools live; Claude under enterprise MCP policy |
| Provider choice / guard | unit + integration tests, web screenshots, laptop survival with blocked providers off | new build on the laptop                                             |
| Composer / theme        | browser screenshots, unit tests, production-bundle check of the roll                  | real glass on macOS / Windows                                       |
| Local mode              | Linux                                                                                 | Windows pipes, packaged macOS                                       |
