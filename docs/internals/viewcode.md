# ViewCode: what this fork adds, and what we learned building it

ViewCode is a fork of T3 Code. Everything in `AGENTS.md` still applies. This page
records the decisions ViewCode made on top of T3, and the traps that cost time,
so the next person (or agent) doesn't rediscover them. Product intent lives in
[`docs/PLAN.md`](../PLAN.md); verification status in [`docs/END_GOALS.md`](../END_GOALS.md).

## Where the ViewCode code lives

| Feature                                  | Main files                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mid-chat model/provider switch + handoff | `apps/server/src/orchestration/Handoff.ts`, `orchestration/Layers/ProviderCommandReactor.ts` (`takeHandoffPrelude`)                                                                                                                                                                                                                                                                                                                                   |
| Child agents                             | `parentThreadId` on threads (contracts `orchestration.ts`, migration `055_ProjectionThreadsParentThreadId`), web `components/agents/*`, tree client-runtime `state/threadTree.ts`                                                                                                                                                                                                                                                                     |
| Side chats (quick questions)             | `kind: "sidechat"` on threads (migration `057_ProjectionThreadsKind`), server `orchestration/sidechatExpiry.ts`, `SidechatExpiryReactor.ts`, `ProviderCommandReactor.ts` (`sidechatOf`), web `components/chat/SidechatDock.tsx`, `SidechatHost.tsx`, `sidechatDockStore.ts`                                                                                                                                                                           |
| Agent-to-agent messaging                 | `apps/server/src/agents/AgentMessaging.ts`, `agents/searchHistory.ts`, MCP toolkit `apps/server/src/mcp/toolkits/agents/`, envelope in `packages/shared/src/agentMessages.ts`                                                                                                                                                                                                                                                                         |
| Command Code provider                    | `apps/server/src/provider/commandCodeCli.ts`, `Layers/CommandCode*.ts`, `Drivers/CommandCodeDriver.ts`, `Layers/commandCodeUsageLimits.ts`                                                                                                                                                                                                                                                                                                            |
| Desktop local mode (no TCP port)         | `apps/server/src/socketListener.ts`, `mcp/McpStdioBridge.ts`, desktop `backend/DesktopLocalBackend*.ts`, web `lib/desktopBackendWebSocket.ts`                                                                                                                                                                                                                                                                                                         |
| Composer model/effort picker, usage ring | web `components/chat/ComposerModelEffortPicker.tsx`, `composerModelEffort.logic.ts`, `ComposerUsageLimitsPopover.tsx`, `composerUsageLimits.logic.ts`                                                                                                                                                                                                                                                                                                 |
| Session import (picker, nesting, titles) | `apps/server/src/project/AgentSessionScanner.ts` (`classifyAgentSession`, `codexSessionOrigin`), `AgentSessionImporter.ts`, `T3CodeHistory.ts`, web `components/agentSessions/`                                                                                                                                                                                                                                                                       |
| Phone notifications (Expo push)          | `apps/server/src/notifications/`, contracts `pushNotifications.ts`, mobile `features/agent-awareness/directPush*.ts` and `useDirectPushRegistration.ts`                                                                                                                                                                                                                                                                                               |
| Computer use (agents drive the desktop)  | `apps/server/src/computerUse/` (`ComputerUseService.ts` gate, `ComputerUseCli.ts` CLI + manual, `Xa11yDriverCore.ts` driver), contracts `computerUse.ts`, web `settings/ComputerUseSetting.tsx`                                                                                                                                                                                                                                                       |
| Browser CLI (no MCP)                     | `apps/server/src/browserCli/` (`BrowserCli.ts` CLI + manual, `BrowserCliRoute.ts` runs the preview handlers), `mcp/toolkits/preview/handlers.ts`                                                                                                                                                                                                                                                                                                      |
| Theme                                    | `packages/shared/src/themePalettes.ts` (`VIEWCODE_THEME` and `VIEWCODE_TEAL_THEME`, the web-only default; `isViewCodeThemeId` names the glass themes), `viewcodeThemes.ts` (Droppy themes), `apps/web/src/viewcode-theme.css` (structure, keyed on `viewcode*` theme ids); `apps/web/src/viewcodeLookMigration.ts` runs two one-time moves to the teal default (upstream themes, then plain `viewcode`) that share one Undo target, the original look |

## Decisions

### Staying mergeable with upstream

- ViewCode tracks upstream T3 Code by merging it. Features live in new files
  and hook into upstream code with small edits; theming goes through tokens
  and `components/ui` variants; contracts only gain optional fields; upstream
  features are hidden behind flags rather than deleted. Details and current
  hot spots: [`docs/NEXT_AGENT.md`](../NEXT_AGENT.md#staying-mergeable-with-upstream-t3-code).

### Handoff (switching provider or account mid-chat)

- The projected transcript is the source of truth; provider sessions are only a
  resume cache. A thread has one persisted binding, so a resume cursor belongs to
  the instance that wrote it and is never handed to another. Same continuation
  key → the native session continues. Different key → the new session starts
  with `freshSession: true` and the first turn gets a `<handoff>` prelude.
  Switching back before that turn is delivered (A → B → A) resumes A's native
  session, whose cursor the pending handoff keeps, and drops the recap.
  Claude's cursor carries `resume` only once the CLI has reported the session
  (`nativeSessionConfirmed` in `ClaudeAdapter.ts`); saving the id ViewCode
  generates before that pointed threads at a transcript that was never written,
  and every later send failed with "No conversation found with session ID". A
  provider that still refuses to resume (`provider/staleSession.ts`) never
  strands a thread: once per send the reactor replaces the session with a fresh
  one on the same model, hands the conversation over as a recap, resends the
  message and records one info row in place of the handoff card. A second
  failure is reported as an ordinary error. Codex and OpenCode already fall back
  to a fresh native thread inside their adapters, without a recap.
- A model's context-window variant (Claude's 200k / 1M `contextWindow`
  option, which picks the `[1m]` API id) is a model option, not a separate
  model. Changing it keeps the thread's instance and model, so it never hands
  off: the reactor restarts the Claude session with its resume cursor on the
  new API id, and the conversation continues natively. The composer trigger
  names the variant ("High · 1M" on web, "Opus 5.5 · 1M" on mobile) because it
  is part of what runs.
- Clients never lock a started thread to its provider (stock T3 does): web
  (`lockedProvider = null` in `ChatView.tsx`) and mobile (`ThreadComposer.tsx`)
  offer every enabled provider, and the next turn's `modelSelection` is the
  whole request; the server decides the handoff. Clients only label it, from
  the continuation group of `session.providerInstanceId`, not of the staged
  selection. Upstream merges that bring the lock back must drop it again.
- A handoff's "from" model is never read from `thread.modelSelection`: the
  client saves the new selection (`thread.meta.update`) before the turn, so
  once the live session is gone (idle reaper, restart) that field already
  names the target, and every such switch was recorded as "opus → opus". The
  reactor reads the leaving model from the live session, the persisted
  binding, then the last turn's selection. Same model on both sides is a real
  case (another account), so labels then name the instances instead.
- The recap has one fixed budget for every incoming model,
  `HANDOFF_BUDGET_TOKENS` (50k tokens, ~200k characters), covering the **whole
  rendered prelude** (header, recap, omission note). It is not a share of the
  target's window on purpose: only Codex (at runtime, after the model has run)
  and Claude (through its model catalog) report one, and a fixed size keeps the
  handoff predictable. 50k is about a quarter of a 250k window, leaves a ~120k
  model under half full, and does not matter to a 1M model; the transcript
  file and `viewcode_search_history` cover everything older.
  If everything fits, it is carried verbatim ("full"). Otherwise ("compact") the
  budget is filled in priority order: the user's messages newest first in full,
  then older user messages clipped to 300 characters, then replies newest first
  (the last 3 verbatim only if they fit, else condensed to the final answer),
  then key facts, then plan/files/commands. Whatever did not fit is counted in a
  "Not shown here" section that points at `viewcode_search_history` and the
  transcript file. The user's words are prioritized but not guaranteed whole: a
  message too large for the budget is clipped, and on a very long thread older
  messages are left out.
- That budget does not fit the 120k-character user input limit, so a turn that
  carries a prelude is sent with `handoff: true` and held to
  `PROVIDER_HANDOFF_MAX_INPUT_CHARS` (240k) instead (`ProviderSendTurnInput`
  and `ProviderService.sendTurn`). The user's own message keeps the 120k limit:
  a longer one is sent without the flag and fails as it would anyway. Every
  adapter takes the input over stdin, JSON-RPC or HTTP, never argv. Within the
  240k the recap gets what the message leaves (minus a 2k margin and 400 per
  attachment, `maxChars`). A prelude that still does not fit (tiny room, or a
  transcript path longer than the reserved 400 characters) becomes a minimal
  one: header plus "the full transcript is at <path>; search it". The reactor
  re-checks the combined input, shrinks the prelude (down to none) and logs a
  warning; the user's message is never trimmed and the turn never fails
  because of the handoff.
- Key facts (links, PR/issue numbers, branches, file paths including root-level
  names and Windows paths, and hex hashes only next to a git word such as
  `commit`/`sha`/`git show`) are extracted deterministically from messages and
  tool results, at most 60, each at most 200 characters.
- Nothing is ever summarized by a model. The outgoing model is never asked to
  summarize (it is usually out of quota — that's why the user switched).
- The pending handoff survives a failed send and a restart: it lives in memory
  and in `<stateDir>/handoffs/<thread>.json` until the provider accepts the
  turn that carries it; only then is the handoff card recorded and the file
  removed.
- The transcript written under `<stateDir>/transcripts/<thread>/` (for
  providers without MCP, e.g. Command Code) holds every message and every
  completed tool result. `viewcode_search_history` searches every message but
  only tool results among the thread's newest 500 activities; older tool output
  is in the transcript file only.

### Agent-to-agent messaging

- Every agents-toolkit tool carries the `viewcode_` prefix (as Traycer prefixes
  `traycer_*`). Codex has its own built-in `spawn_agent`; with the bare name the
  model picked the built-in one, so "sub-agents" never became visible ViewCode
  agents. The runtime instructions (`provider/RuntimeInstructions.ts`) name the
  ViewCode path as the default and say when the harness's own sub-agents are
  appropriate. On every provider, a missing or failing `viewcode_spawn_agent`
  is announced in one sentence and the agent continues with native sub-agents
  without asking (the user chose this over a confirmation prompt). Native
  sub-agents stay inline, with no chat or model picker of their own, so a
  request for a specific provider/model or a separate chat is reported as a
  limitation instead of substituted. An agent may also pick native sub-agents
  itself for a quick lookup when the user did not ask for agents.

- A message is a normal `thread.turn.start` whose text begins with a
  `<viewcode-agent-message …>` envelope. Idle receiver → starts now; busy,
  paused or out of quota → queued. `reply_expected` routes the receiver's final
  answer **from that turn only** back to the sender. "That turn" is the provider
  turn id returned by the provider's send call, correlated to the request's
  message id in an acceptance receipt. Lifecycle events can precede that
  receipt; the next running session alone cannot identify the request, since
  an earlier user prompt may still be starting.
- Archive, unarchive, snooze and unsnooze of a thread cascade to its child
  agents in the decider (the per-thread commands carry `cascade: false`), so
  every client and entry point moves a tree as one. The sidebar floats a child
  whose parent is hidden to the top level, which read as a stray chat. Snooze
  skips children blocked on the user (pending request or queued turn) rather
  than failing. Settle and pin do not cascade. The project-folder sidebar still
  places a tree as one: the lead's settled state decides whether the whole tree
  sits in its folder's Settled group, and any live thread in it (working or
  waiting on the user) keeps it active. Child agents therefore offer no Settle
  there (`sidebar/sidebarFolderSections.logic.ts`).
- Agents can reach only their own tree (root thread and all descendants). A hop
  limit (24) stops ping-pong loops; spawning counts as a hop too.
- Stopping an agent that belongs to a tree **pauses** it (user decision): any
  `thread.turn.interrupt` / session stop from any client, or the `agents.stop`
  RPC (Stop all = whole tree). The command palette's "Restart agent session"
  stops with `restart: true`, which does not pause an idle agent (it only
  reloads skills and plugins); one that cuts a running turn short still pauses. While paused, messages and replies to it queue,
  senders are told it is paused, and a stopped turn's pending reply is held.
  `agents.resume` sends "Continue where you left off." when a turn was cut
  short (its answer still goes to the original requester) and drains the queue.
  A Stop that lands before a delivery's turn is bound interrupts it once it
  binds; if it still finished normally, Resume delivers its answer instead of
  continuing. A delivery whose receipt is lost or arrives after the session
  already ended is finished, never left blocking the queue.
  `agents.discard` drops the held work. Resume and Discard requested while an
  interruption is pending wait for it to settle; its partial answer must not
  be forwarded as the requested result. Typing a prompt into a paused agent
  resumes it. Pause and queues live in server memory only
  (`subscribeAgentControl` streams them); a restart forgets them. Web and
  mobile decide which of Stop / Resume / Discard an agent offers with the same
  rule (`resolveAgentControlAvailability`, client-runtime `state/childAgents.ts`).
- Providers report limits only as text, so `classifyLimitError`
  (`packages/shared/src/usageLimit.ts`, shared with the web notification) sorts a failure into
  a **usage limit** (quota or plan spent: anchored to the providers' own phrasing such as
  "usage limit reached", "hit your limit", "5-hour limit", "out of extra usage", "insufficient
  credit", `usage limit reached|<unix>`), a **transient throttle** (HTTP 429 named as "Too Many
  Requests" or "rate limit", overload, or a proxy saying "not your usage limit", as litellm
  does), or neither. Loose words ("429", "credits", "quota") and `Cause.pretty` stack frames are
  not evidence: a live litellm 429 used to read as "Claude usage limit reached" and mark a whole
  tree out of usage. The server's `limitKindOf` (`agents/usageResetTime.ts`) also treats a retry
  hint under five minutes ("try again in 1.2s") as a throttle, unless the turn saw a rejected
  usage window. Claude's adapter only says "Claude usage limit reached" (in the result and in
  the mid-turn "paused" row) when a `rate_limit_event` rejected a window during the turn and
  nothing contradicts it: not the reply's own words ("not your usage limit"), not another HTTP
  status than 429, not a terminal reason other than an API error or blocking limit
  (`isClaudeUsageLimit`, `provider/Layers/claudeUsageLimitRule.ts`). A bare `rate_limit`
  response keeps its own text.
- A turn that ends with a usage limit marks the agent out of usage in AgentMessaging
  (`limited`, a `LimitMark`); a throttle never does. The mark never refuses a send: messages
  queue until `retryAfter` (the reset plus 60s; ten minutes on when no reset time is known),
  and the sender is told when they will be delivered and when the limit was last checked. One
  timer wakes at the earliest `retryAfter`. A known reset deletes the mark and drains the queue;
  an unknown one releases the queue so the oldest queued message is the probe (no separate
  provider test call: that would launch the CLI). A successful turn on the same provider
  instance, or a usage snapshot showing no window at 95%, clears every mark on that instance;
  a probe that fails re-marks. Clearing a child's mark delivers its queued mail, else messages
  the lead (a new lead turn, whatever its provider) that the child stopped mid-task and is
  available: the child itself is not continued, so a lead that moved the work does not get
  double work. Nothing starts in an archived agent: sends to it fail and its queue waits.
  `viewcode_list_agents` (`outOfUsage`) and `viewcode_list_models` (`usage`) show the state so
  agents check instead of guessing. `viewcode_configure_agent` moving the agent to another
  model also clears its mark and starts its queued work.
- A failed turn stays failed until a new turn starts: ingestion keeps `lastError` when the
  provider reports idle after an error (Claude's CLI sends `session_state_changed` idle after
  the result). Clearing it there used to wipe the LimitMark, the resume state and the limit
  notification a moment after they were set.
- Resume after a limit (`agents/UsageResume.ts`, top-level threads and leads; not child agents,
  which are left to their lead). A usage limit schedules "The usage limit has reset. Continue
  exactly where you left off and finish the task." at `max(resetsAt + 60s, now + 5s)`. The
  reset time comes from, in order: the provider's own signal recorded during the turn (a
  `runtime.warning` activity whose detail is Claude's rejected `rate_limit_event` info; the
  later signal with a time wins; cleared when a turn starts), the error text, then a usage
  reading under ten minutes old: the window the signal named as rejected, else the most-used
  window if it is at least 95% used. Only a future time counts; a source naming a past time
  falls through to the next, so a stale reset never resumes at once. Codex reports only the
  failed turn's error text. A throttle is instead retried with "Continue where you left off."
  after 10s, 30s and 60s (or the provider's short hint), shown as "Rate limited by the server;
  retrying at …", then left to the user; it never sets a mark or uses the usage-reset prompt.
  One failure is decided once: a Claude failure arrives as a runtime error, the turn's end and
  an idle, so the decision is keyed by the turn request that failed and later events of it are
  ignored (they used to flip "unknown" into a schedule). Schedules are JSON files in
  `<stateDir>/usage-resume/` (like pending handoffs) so they survive a restart; overdue ones run
  5s after boot. One sleeping fiber waits for the earliest, woken on changes. A user turn,
  model switch, Cancel, archive or delete drops it; a second limit failure reschedules once,
  then stops. A due resume is taken out of the schedule before it is sent and put back if
  nothing started: busy → a minute later, stopped by the user → cancelled, archived or deleted →
  dropped silently. Only a started turn records "resumed" ("Trying to continue after the usage
  limit…", or "Resumed by you." for Resume now). The state clients show is a
  `viewcode.usage-resume` activity (latest wins). The desktop notification comes from the
  agent-control stream, not the failure: `AgentControlState.usageResume` is set (with
  `resumeAt` when scheduled) once the server has decided on a usage limit, and
  `ThreadNotificationCoordinator` skips its "Thread failed" alert for a top-level limit failure
  and sends "Usage limit reached. Continuing at 3:31 PM." (or "Send a message to continue.")
  when that entry arrives. Times are worded by `formatResumeTime` in
  `packages/shared/src/usageLimit.ts`, which web, mobile, the notification and the server's
  messages to agents all use. The server tells the desktop to hold
  `powerSaveBlocker("prevent-app-suspension")` over the telemetry control fd (`setKeepAwake`)
  while any schedule exists. There is deliberately no scheduled wake: `pmset schedule wake`
  needs admin, which managed laptops lack, so the computer must stay awake and a closed lid may
  still sleep.
- Context-window activities carry the `providerInstanceId` that reported them. The web "resume
  with less context" offer only appears for usage from the thread's current instance with no
  handoff pending; after a handoff the last row is the old provider's, and Compact would run on
  the new, empty session. Mobile has no such offer.
- `viewcode_list_models` lists every enabled provider with `usable` and a `note`, and
  tells agents to use a vendor's own provider (GPT → Codex) over resellers
  (Command Code, OpenCode, Cursor) unless the user names the reseller. It hides
  models the manifest classifies as legacy; a Codex model whose GPT version is
  newer than every one in the manifest's `currentModels` is never legacy, since
  Codex's `model/list` ships new models before the manifest names them.
- A turn that names no model (every agent message, resume and continue) runs on
  the thread's `modelSelection` when that belongs to the live session's
  instance. A restarted session can come back on another model (Codex reported
  its default after an error), and the turn used to inherit it while
  `viewcode_list_agents` named the configured one. `list_agents` also reports
  `runningModel` when the live session's model differs.

### Browser CLI

- `viewcode-browser` reaches the collaborative browser without MCP, for providers whose
  organization blocks MCP servers (or sessions run without ViewCode's tools). `POST /api/browser`
  runs the MCP preview tools' own handlers with the session credential's scope, so validation, the
  `preview` capability gate ("Agent browser access"), broker routing and the agent's current tab
  are shared with the `preview_*` tools; nothing browser-specific is reimplemented. Only snapshot
  output differs: a shell cannot receive an image, so the PNG is always saved
  (`browserArtifactsDir`) and its path returned, with the same 20 KB bounding.
- The host is the desktop app's webview (`PreviewAutomationHosts.tsx`); web and mobile register
  no host, so the CLI, like the MCP tools, needs a desktop app connected to the environment.

### Computer use

- No MCP. Managed Macs block client-supplied MCP servers for Cursor (team policy, enforced
  server-side; a server sent over ACP is accepted and silently ignored) and Claude
  (`managed-mcp.json`), so agents run the `viewcode-computer` CLI through their own shell. The
  CLI is a thin client: it POSTs to `/api/computer-use` with the session's credential, and the
  **server is the only gate**. The provider's own permission prompt is not one: in full access
  Cursor runs `--force`, Grok `--always-approve`, Codex `never` and Claude `bypassPermissions`, so
  ViewCode never sees the command. Everything (mode, running turn, denylist, approval, stale
  targets) is enforced in `ComputerUseService` against the contract schema, assuming the agent
  ignores every instruction and crafts raw requests with its credential.
- Because that prompt is not the gate, adapters answer it themselves (allow once, no card) for a
  session spawned with computer use when the shell command is exactly one plain invocation of
  that session's launcher (`computerUse/computerUseCommand.ts`); otherwise every action asked
  twice. "Plain" is a conservative lexer over the raw command the provider will run (never a
  display title): words and quotes only, nothing a shell would chain, redirect, substitute or
  glob. The command word must be exactly `<shimDir>/viewcode-computer` (`computerUse.cli` on
  `McpProviderSession`), bare or wholly quoted, never the bare name: login shells (Codex runs
  `bash -lc`) rebuild PATH from the user's profile, so a workspace entry (direnv `PATH_add bin`,
  `./node_modules/.bin`) would let an agent that can write files plant its own
  `viewcode-computer` and have it approved. The instructions and `viewcode-computer help`
  (`VIEWCODE_COMPUTER_CLI`) give the agent that path, quoted the way the lexer accepts
  (`shellCommandWord`); the bare name still runs but the provider asks. Claude (Bash), Codex
  (command approvals, not stdin or network), Cursor, Grok and Antigravity do this. OpenCode does
  not: its request carries only per-command patterns with redirections dropped, so it cannot be
  proven plain. Claude under a managed policy that narrows Full access is the exception: the
  thread (and so the gate) is still full access, which would wave the action through unasked,
  so the adapter asks instead (`effectiveRuntimeMode` in `ClaudeAdapter`).
- The credential is the MCP session credential with a `computer` capability, issued even when the
  provider never loads MCP; the thread always comes from the credential. The CLI's env
  (`VIEWCODE_COMPUTER_ENDPOINT`, `VIEWCODE_COMPUTER_AUTH`, PATH shim) rides the agent-device env
  seam every adapter already applies at spawn. Names avoid KEY/SECRET/TOKEN because Codex's shell
  env policy strips those. The mode is re-read on every request, so turning it off is immediate.
  Env and instructions are fixed at spawn, so the session records the setting it was prepared
  under (`computerUseSetting`) and a turn that starts on an idle session prepared under another
  setting first restarts it with its resume cursor, the same in-place restart as a runtime-mode
  change, and adds one info row (`ProviderCommandReactor`). The new session records the current
  setting, so it never loops, and a session with no record (no MCP credential) never restarts;
  a failed shim still records the setting, so it is not retried every turn. A handoff already
  starts a fresh session. `computerUseApprovals` is read live and never restarts anything.
- Instructions are a few lines: the launcher path, `help` (whose output is the manual), the focus
  rule, and that no other installed desktop or browser automation (osascript, screencapture,
  Playwright skills) replaces it. Like agent-device, and unlike a SKILL.md: no files to manage in
  six providers' skill folders, nothing loaded when unused, and it cannot drift from the CLI.
  Codex sends the computer-use and browser CLI guidance as separate `additionalContext` entries,
  like diagrams: its 1,000-token per-entry cap truncates the middle of combined runtime guidance.
  Security never depends on the model following it.
- Approvals are ViewCode's own `permission_approval` requests published on the provider runtime
  stream (`computer-use:<uuid>` ids), so web, desktop and mobile render them unchanged;
  `ProviderService.respondToRequest` answers ids it owns before routing to an adapter. When input
  asks is the `computerUseApprovals` setting (`inputNeedsApproval`): `thread` asks for routine
  input unless full access is on both the thread and the live session, `risky` asks only for
  destructive-looking input, `never` asks for nothing. "For the rest of this turn" ends with the
  turn. Destructive-looking means a target label matching the heuristic, or a quit/close chord;
  it is not a detector. The setting is read with the turn before the hit test and again at every
  final check, so moving to a stricter value (or leaving full access) mid-action refuses an input
  that was not asked about instead of letting it through. **No input is dispatched while any approval in
  the environment waits** (`CU-CON-008`, computer-use and provider approvals alike): that, not
  window identity, is what stops an agent answering an approval for itself in a ViewCode window, a
  browser tab or a mirrored screen. The denylist (protected apps, ViewCode by name and `.app` path,
  the server's own process ancestry, browser tabs titled like ViewCode) is defense in depth. The
  worker asks the server to re-read the mode, turn, approvals and the freshly resolved native
  target twice per input: before it activates, raises or focuses anything, and immediately before
  native input, including an accessibility action's fallback click or typing. Only that last check
  takes the environment-wide dispatch lock, and an allowed one keeps it until the native action
  returns, even when the caller gave up; waiting in the worker queue and preparing the target hold
  nothing, so a slow observe cannot stall provider events. Approval publication and the tracking of
  provider requests share the lock, so no card can open between the final check and the input
  landing. Every provider `request.opened` except a `tool_user_input` question (the projection's
  rule for approval cards) is tracked before publication, because the projection can lag; a turn's
  end clears what it left open. Turn-end receipts and interrupts invalidate input immediately,
  without waiting for the thread projection.
- Two ways to act, chosen per step by the agent: accessibility refs (exact) and screenshot pixel
  coordinates (Codex style, for canvases, browsers and apps with no tree). Window ids, refs and
  shots are per-thread integers starting at a random per-run base; a newer observe retires a
  window's refs, only a window's newest shot accepts coordinates, and the driver re-reads the
  element or window bounds at dispatch and refuses on change. Every input returns a fresh shot.
- Ref actions run in the background: press (AXPress), set-value (AXValue) and type --ref
  (accessible text insertion) act on the element itself, which never needs focus, so they never
  activate, raise or focus anything; activating first took the user's focus for no reason. Only
  their synthetic fallbacks (after `ActionNotSupported`), key, type --window, scroll and
  coordinate input bring the exact window to the front. Input results carry `tookFocus` from the
  driver, so the agent and the logs can tell the two apart.
- `VIEWCODE_COMPUTER_BACKGROUND=1` opts macOS into process-directed clicks, scrolling and
  single-window shortcuts for inactive targets, through one background-only JXA helper per worker.
  The same flag enables a separate cursor on desktop-managed hosts. Its request and arrival reply
  use the existing typed desktop-host FD channel; headless servers skip it. Cursor arrival precedes
  the dispatch lock and policy is checked again afterwards. The panel cannot focus or receive input,
  uses one-shot motion and is hidden after idle. Single-window captures exclude it; content
  protection alone is not a guarantee for every third-party screen recorder.
  The routing fields are undocumented and the JXA bridge may lack `CGEventSetWindowLocation`.
  AX state must change across complete bounded reads; a post returning success is not evidence.
  A refusal after posting reports an uncertain effect, never a foreground retry. Explicit focus
  still goes through Show on screen. No private SkyLight activation or background drag is shipped.
- xa11y elements and window lists are snapshots (`tree(0)` reads no live state), so the driver
  records each element's child-index path at observe and re-walks it from a fresh window read at
  dispatch, refusing on any role, label, native identifier or bounds change. The retained window
  and observed element must still have a native parent before a fresh snapshot can be matched:
  titles and `AXIdentifier` values can be reused after close, even without an intervening empty
  listing. xa11y exposes no native identity (no AXUIElement handle or `CFEqual`), so a twin
  identical in every compared field, at the same path while the observed control is still alive
  elsewhere, cannot be told apart and receives the action.
  Handles carry a per-worker random epoch,
  so a restarted worker (crash, timeout, recycle) can never resolve an old handle to another app.
  It refuses one as `stale` with `reason: "restarted"`, which the service maps to the usual codes
  (window → CU-NOT-001, ref → CU-CON-003) with "the driver restarted; list windows again" rather
  than "window closed". On macOS, AXRaise does not activate an app; the driver runs
  `open -a <bundle>` (which also switches to the window's Space or full-screen app; `focus` is
  that activation alone, so a listed window on another Space can be captured) and then requires
  the exact target window to be active within 3 s (500 ms was
  too short on a slow managed Mac), failing closed. Windows is refused until there is a real win32
  window model (xa11y treats each top-level window as an app there).
- The driver is xa11y in a child process spawned from the app's own executable with
  `ELECTRON_RUN_AS_NODE=1`: macOS keys the Accessibility grant to the responsible app. The sibling
  Helper host is opt-in (`VIEWCODE_COMPUTER_DRIVER_HOST=helper`); its grants and Dock behavior need
  confirmation in the actual build before it can become the default. Chromium and
  Electron build their tree only on request: before a pid's first observe the driver sets
  `AXManualAccessibility` (xa11y cannot) and waits 500 ms. `AXEnhancedUserInterface` is never
  used; it changes window animation and resizing in other apps.
- xa11y's macOS mouse down and up are posted at (0,0), not at the pointer (still true in 0.15), so
  its drag presses the top-left screen corner. On macOS the driver posts drags and the
  dead-worker button release itself as positioned Quartz events from a constant JXA script run
  by `/usr/bin/osascript` (`MacQuartz.ts`), which needs no compiler on the user's Mac. They come
  from a HID-state source after warping the real cursor, since WebKit and Chromium filter drags
  that do not look like hardware input (Synara's driver notes); xa11y's
  `click` is positioned and stays on xa11y. macOS captures are planned from Quartz's on-screen
  window list, never from AX focus, which can survive a Space switch (`planWindowCapture`). With
  no other app's window over it, the window is captured as its screen region (`-R`), so its open
  menus show at exact geometry, and the list is read again afterwards in case another app's window
  arrived. When another app covers it, only its own pixels (`-l -a`): attached windows would stretch
  a `-l` image past the window bounds, and `-a` drops the menus. With no single on-screen window at
  the AX bounds the capture is refused. A failed AXParent read is reported as "no parent" even when
  the app is only busy (long typing), so window and element liveness retry for 1.5 s before a
  window counts as gone. xa11y's macOS `typeText`
  sends 20 characters per key event and some apps keep only the first, so text goes one code
  point per event. AXValue and AXSelectedText writes can succeed without changing a web field
  (Safari), so the driver re-reads the value and types by keyboard when it did not change.
- On macOS an open context menu is an AX child of the app, not of any window, and menu bar menus
  hang off the app's `AXMenuBar`, so neither shows up in a window's observe. Both are listed as
  their own targets (`kind` "menu" / "menu-bar"; the menu bar only for apps with a window, never
  `AXExtrasMenuBar`), with the same identity and re-walk rules as windows. They take refs only:
  `activate` refuses on them before touching anything, because a menu is never the active window
  and activating its app closes an open one. An open menu is captured by its own pop-up-level
  Quartz window (`-l`); the menu bar is never captured.
- Input that takes the screen refuses with CU-CON-009 while the hardware event system reports
  input in the last 1.5 s (`CGEventSourceSecondsSinceLastEventType`, no Input Monitoring needed).
  The driver's own posted events can count as that input, so only input newer than the driver's
  last dispatch counts as the user's. It is a time window, never a latched pause: Synara's
  latched "input paused" state stayed on and blocked every action.
- Logs and approval text never carry typed text or values (approvals show a character count).
  The service logs one INFO line per request (thread, command, outcome or CU code, effect,
  tookFocus, duration) and one when the pause or a policy check refuses input (code, stage); the
  driver logs worker start, stop, per-op timeouts and shim rewrites. None carry labels, titles,
  paths, values or coordinates; window and ref ids stay at debug.
  Ad-hoc signed builds lose the TCC grant on every rebuild while System Settings still shows it on;
  the settings status line is a fresh check for that reason. Unverified on real hardware: the TCC
  grant under Electron-as-node, xa11y input on macOS and Windows, and whether managed-Mac security
  software tolerates synthetic input; the first run on such a machine should be one
  `list-windows`.

### Pull request watches (port of upstream's v2 PR watch onto v1)

- The watch is an optional `watch` on the thread's pull request link, persisted in
  `projection_thread_pull_requests.watch_json` (migration 056, idempotent like 055 so it can be
  renumbered after upstream's). `thread.pull-request.watch` and the internal
  `thread.pull-request-watch.sync` emit the existing `thread.pull-request-linked` event with the
  new link, so the projector, projection pipeline and client reducers needed no new case and older
  clients ignore the field. A side effect: each recorded watch change also triggers one pull
  request sync read (`PullRequestSyncReactor` refreshes on every linked event).
- The watch records what the agent was **told**, not what was seen. `PullRequestWatchReactor`
  starts the wake through `AgentMessaging.wake` (the same turn path as agent messages and usage
  resume), and only a started turn records the new state. A busy, paused or out-of-usage thread
  keeps the wake in memory and gets it on the next `thread.session-set` that is not live, or the
  next pass; a restart loses it and the next pass reports the same news again. Passes and those
  turn-end deliveries are serialized, and a sync applies only to the watch whose `startedAt` it
  read, so a stop wins over a pass in flight.
- Left out of the port for now: upstream's required-check gate (`isRequired` in the GraphQL core
  read), its host fingerprint gating, paging long review threads, and edited-comment wakes. A
  pull request with nothing in flight and an unmoved sync snapshot is re-read every 10 minutes.

### Side chats

- A side chat is an ordinary thread with `parentThreadId` plus the optional
  `kind: "sidechat"` (contracts `ThreadKind`, shell and detail, create and
  `thread.meta.update`, which can only clear it). The decider refuses a side
  chat without a parent. Reusing `parentThreadId` makes the parent's archive
  and delete cascade cover its side chats; unarchive deliberately skips them,
  since they expired for a reason. `kind` is what separates it from a child
  agent: walks of `parentThreadId` as "agents" go through `isChildAgent`
  (`agents/AgentMessaging.ts`: the tree, usage-limit release, usage resume)
  and `collectChildAgents` (client-runtime), and push titles stop at a side
  chat. Anything new that walks `parentThreadId` must do the same: a usage
  limit on a side chat used to start a turn on its parent.
- Context is a handoff, not a copy: on its first turn the reactor queues a
  pending handoff whose recap is built from the **parent's** detail
  (`sidechatOf` in `PendingHandoff`, `sidechat: true` in `buildHandoff` for the
  "read-only context" header). It is a snapshot at that first turn; a side chat
  does not follow later work. Everything else about the budget and shrinking is
  the ordinary handoff.
- Expiry archives (never deletes) a side chat idle for 24h and not working,
  swept every ten minutes (`findExpiredSidechats`). It runs the same archive
  cleanup as a client archive (`orchestration/threadArchiveCleanup.ts`: stop
  sessions, close terminals) and stays reversible.
- The dock is its own compact transcript and composer, not an embedded
  `ChatView`: `ChatView` is route-bound with global key handlers, so a second
  instance would fight the first. It uses `ProviderModelPicker`, never the
  composer's `ComposerModelEffortPicker`. The sidebar, the mobile home list and
  the palette, tabs, Ctrl-Tab and the split companion hide side chats; mobile
  has no dock.
- `openSideChat(parentRef, prefill?)` (`sidechatDockStore.ts`) is the hook for
  other code, such as a selection toolbar's "Ask in side chat".

### Command Code

- Headless CLI adapter (`cmd -p --output-format json`, `--resume <id>`). Its stdin
  closes after the initial prompt, so it cannot accept mid-turn steering. Clients
  queue follow-ups until completion, including after a provider handoff; tool
  completion alone is not a safe send boundary. A rejected follow-up must not
  mark the existing live turn as failed, since agent messaging uses that state
  to decide when to deliver queued work and return results.
- Its CLI loads MCP servers **only** from files (`~/.commandcode/projects/<slug>/mcp.json`,
  project `.mcp.json`, `~/.commandcode/mcp.json`); there is no flag, env var or
  mod API for a per-run config. So Command Code agents do not get the agents
  toolkit; they work as workers (receive tasks, their answers route back).
- Usage reads Command Code's existing login and `/alpha/billing/*` endpoints
  for enabled, installed instances. `readAccountCredits` defaults on; an explicit
  off setting still prevents credential and billing reads. Successful readings
  are cached for five minutes. Monthly percentages use reported spend plus
  remaining monthly credits, not a plan-price table; five-hour and weekly caps
  come from `windowLimits`. Logs contain key source and request statuses, never keys.

### ACP and the ViewCode MCP server

- An ACP agent that does not advertise the configured MCP transport (`mcpCapabilities.http` absent or false, for the HTTP config used without a stdio bridge) still starts: `AcpSessionRuntime` logs a warning with the provider and drops that server, so the chat works without ViewCode agent tools. Never fail `initialize` over it.
- A chat that ends up without ViewCode tools must not start silently (OB8). When ViewCode drops the server (unsupported transport) or never issues an MCP session, the Cursor, Grok and Antigravity adapters emit a `runtime.warning` (`viewcodeToolsUnavailableWarning` in `AcpMcpDiagnostics.ts`), which the existing work log renders. When the server was sent but the agent loads no tools anyway (Cursor Enterprise blocks every MCP server by team policy), ACP gives no cheap signal: `session/new` confirms a session, not a tool inventory, and `cursor-agent mcp list` is an extra spawn that is risky on managed machines. So the `<viewcode_agents>` block in `RuntimeInstructions.ts` tells the agent to say plainly that the tools are missing, name the likely cause and offer sidebar child agents, instead of falling back silently.
- Claude Code with an enterprise MCP config (`managed-mcp.json`, paths in `Drivers/ClaudeEnterprisePolicy.ts`) exits 1 at startup on any client-supplied MCP server ("You cannot dynamically configure MCP servers when an enterprise MCP config is present"), which used to kill every Claude turn. The managed config is the organization's security control: ViewCode **respects it and never routes around it** (no project `.mcp.json`, settings files, env vars or edits to the managed file). `ClaudeAdapter` starts without `mcpServers` when the file exists, when the `runWithoutViewCodeTools` instance setting is on, or after the CLI refused once on that instance (remembered for the server's lifetime; the refusal triggers one relaunch of the same session without MCP that resends the unstarted prompts, and only that exact stderr does). Such sessions get instructions without the PR-linking and agents blocks, and a `runtime.warning` whose detail is `ViewcodeToolsUnavailableDetail`; clients turn the latest one into the thread notice (`client-runtime/viewcodeTools.ts`). Unmanaged machines get byte-identical options and no notice. The supported fix for such users is their IT adding ViewCode's server to the managed config.
- A provider CLI that exits on its own is reported as that exit, attributed to the process and carrying its stderr ("Claude Code exited (code 1): …", last ~2KB, redacted; `provider/providerProcessExit.ts`), in the runtime error, the failed turn and the top-level log line. A request that merely touched the dead process (Claude's `setPermissionMode` is usually first) waits for the stream to settle and fails with that exit instead of "`turn/setPermissionMode` failed". ACP adapters already attach stderr to `AcpProcessExitedError`.
- The MCP endpoint is announced on `127.0.0.1` even on a wildcard bind, on purpose (`mcp/McpSessionRegistry.ts`, `getHttpMcpEndpointHost`). Provider subprocesses are local, and MCP never crosses remote connections or tunnels, so "MCP unreachable from remote" is expected, not a bug.

### Inline HTML pages (`html_render`)

- Ported from upstream's v2 feature onto v1. The `html_render` tool
  (`apps/server/src/mcp/toolkits/html/`) stores the page as a `<id>-html`
  thread attachment and then appends an `html.render` thread activity itself.
  Upstream renders the page from the tool call's result, but v1 adapters do not
  carry MCP tool results to clients reliably, so the activity is the only
  thing clients read. The activity takes the thread's active turn, so
  reverting that turn removes the page too.
- Revert pruning (`ProjectionPipeline` `applyAttachmentSideEffects`) keeps only
  attachments something still references; `html.render` activities count as a
  reference, or a revert would delete every page in the thread.
- Left out on purpose: `html_preview`, the headless Chrome download and
  server-side height measurement. The page reports its own height
  (`ui/notifications/size-changed`) and the web frame fits it; mobile shows the
  agent's height and lets a taller page scroll inside its frame.

### Desktop local mode and phone access

- By default the desktop backend listens on a Unix socket (named pipe on
  Windows), reached by the window through the main process as
  `t3code-backend://<id>/`; providers reach MCP through a stdio bridge. No TCP
  port. `T3CODE_DESKTOP_BACKEND_TCP=1` forces TCP.
- Network access relaunches the app on TCP for phone pairing; turning it off
  returns to socket-only. `pnpm dev:desktop` is development mode and always
  uses a Vite port.
- The Same Wi-Fi LAN self-test (`checkLanReachability`) runs only when the user
  clicks "Test this network", never on dialog open, and dials loopback before
  the LAN address. On a managed Mac, Cortex XDR read an ad-hoc-signed app
  connecting to its own LAN address as reconnaissance and killed the whole
  process tree, parent terminal included. Keep it an explicit action.
- Connect phone (`web/src/components/connectPhone/`) is the user-facing path to
  that toggle, and every mode ends in a pairing QR the stock T3 Code app scans
  (no phone sign-in). Modes come from `resolveConnectModes`: Same Wi-Fi and Quick
  connect always (Quick connect and Tailscale sit under one Anywhere tab, Quick
  connect first); Tailscale only when the desktop finds the `tailscale` CLI on disk
  (a PATH search, never a spawn; `DesktopTailscalePhoneAccess.ts`), whose "Turn on"
  reuses `setTailscaleServeEnabled`, and whose launch-time opt-in
  (`tailscaleAutoServe`) defaults off because managed laptops' security software
  kills tailscaled. The dialog does not offer upstream's hosted T3 Connect tunnel:
  Quick connect does that job on the user's own account, and a third choice only
  confused people. T3 Connect's server side (`cloud/`) is untouched and still
  reachable from Settings → Connections in builds that configure it.
  The relaunch kills the open
  dialog, so it leaves a timestamped `viewcode:open-connect-phone`
  localStorage flag (plus the tab) first and the root host reopens the dialog
  on boot. That works only because the packaged renderer keeps its
  `t3code://app` origin across socket and TCP modes; a mode-dependent origin
  would lose the flag. The flag goes stale after two minutes so a relaunch that
  never happened can't pop the dialog later.
- Quick connect (`apps/server/src/relay/`, `infra/viewcode-relay/`) is the recommended
  "Anywhere" path because the server dials **out** over one WSS connection on 443 to a
  Worker on the user's own Cloudflare account. On the managed Mac Tailscale is killed and
  cloudflared is blocked by TLS inspection plus an always-on VPN, but ordinary HTTPS to
  `*.workers.dev` and a long-lived WebSocket both work, so an outbound WebSocket through a
  plain HTTPS origin works where tunnels do not. The stock phone app only keeps an origin
  and speaks plain HTTP/WS, so the relay is TLS to the relay plus ViewCode's own pairing and
  session auth; it is not end-to-end encrypted and the docs and UI say so. The frame format
  (`packages/shared/src/viewcodeRelayProtocol.ts`) has a `sealed` flag for a future
  ViewCode-aware client, unused today. The forwarder reaches the server on its TCP port or
  its Unix socket, so desktop no-port mode needs no relaunch. State rides the auth-access
  stream as `viewcodeRelay`, like `managedTunnel`; the switch is the `viewcodeRelay.enabled`
  server setting and the host secret lives only in the secret store. The desktop backend is
  spawned with `--use-system-ca` so corporate TLS inspection does not break the socket.
- Cloudflare's Durable Object caps each WebSocket message at 1 MiB. Provider
  `workspaceSnapshots` stay in the server registry; config snapshots, provider
  status updates and refresh replies omit them. Composers fetch one cwd's
  snapshot through `server.getProviderWorkspaceSnapshot`. Splitting host relay
  frames cannot help because the stock phone expects one WebSocket message.
- Quick connect is set up from the app by the server (`relay/ViewCodeRelaySetup.ts`), which
  runs `npx --yes wrangler@4` from PATH: the server may run as Electron-as-node, so it never
  uses its own executable, and a missing Node is a message, not a crash. `infra/` does not
  ship, so the server build copies the Worker's TypeScript sources to
  `dist/viewcode-relay-worker/` and setup stages them with a generated `wrangler.json`
  whose `alias` maps `@t3tools/shared/viewcodeRelayProtocol` to the flat copy; wrangler
  bundles at deploy time, so there is no second bundler. Only setup writes
  `viewcodeRelay.url` (`url: null` clears it): the settings RPC drops `url` from client
  patches, because the address and the stored host secret must change together.
- The relay requests identity from the local server; compression is owned by the edge.
  Cloudflare's edge rewrites `content-encoding` to the client's Accept-Encoding without
  transcoding, so a forwarded compressed body is mislabelled (`relayForwarder.ts`).
- A new relay address can be reset for up to an hour while a firewall categorises it,
  then work unchanged, so a reset is never terminal for the connector: it keeps retrying
  and only the wording escalates (`viewCodeRelayHealth.ts`).
- ViewCode's desktop identity must never match T3 Code's: profile folder
  `viewcode`, app id `dev.viewcode.app`, WM class `viewcode`. Sharing T3's
  profile shared its IndexedDB lock and cached projects, which stalls first run
  on "Still connecting". A non-default `T3CODE_HOME` also owns its Electron
  profile under `userdata/electron`, resolved before Clerk initializes storage;
  isolating only the server database still lets concurrent desktop runs share
  IndexedDB and authentication state. The default home keeps the installed profile.
- The same holds for the mobile app (`apps/mobile/app.config.ts`): package
  `com.viewcode.app[.dev|.preview]`, schemes `viewcode[-dev|-preview]`, so it
  installs beside the store T3 Code app without Android asking which app opens
  a link. Linking still accepts `t3code://` (the Android widget builds that
  scheme but targets our package explicitly), and QR payloads accept both.
  The EAS project comes only from `VIEWCODE_EAS_PROJECT_ID`/`VIEWCODE_EAS_OWNER`:
  the config is dynamic, so `eas init` cannot write the ID itself, and the cloud
  builder re-evaluates the config, so the ID must also be an EAS environment
  variable (`docs/user/android-app.md`). Without an ID, OTA updates are off.

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

### Account usage

- Account limits live in the app rail's usage rings; the composer ring stays scoped to the
  selected provider and thread context. The rail reads the environment of the open thread
  (or draft), including remote servers, and falls back to the primary environment when no
  thread is open (`resolveRailEnvironmentId`), rather than the desktop's local credentials.
- Opening either usage panel reuses readings less than a minute old. A shared
  per-environment, per-instance guard coalesces in-flight probes and limits retry
  attempts after failure. Closing the panel stops UI updates, not the server probe.
- On macOS, Claude's banked resets need its Keychain login, which ViewCode reads
  only after the per-environment opt-in `claudeKeychainUsageEnabled`
  (Settings → Providers), like Cursor: a read can raise a macOS prompt on the
  server's screen that a remote client cannot answer. The read is bounded at 30
  seconds and cached until the account in `~/.claude.json` changes, the opt-in
  toggles, Claude refuses the token, or (at most every 15 minutes) the token has
  expired. Only the default config directory is read, because any
  `CLAUDE_CONFIG_DIR` makes the CLI suffix the Keychain service name
  (`claudeCredentialStore.ts`). With the opt-in off, the count can still come
  from a recent Claude Desktop usage-cache response for the selected CLI
  organization; cache-only counts cannot authorize redemption. A login that
  cannot be read sets `resetCreditsUnavailableReason` so clients explain the
  gap instead of showing nothing; missing data is unknown, never zero. A banked
  credit can exist before it is usable immediately.

### Phone notifications

- Upstream's push path is T3 Connect: the server publishes agent activity to
  the hosted relay, which sends FCM/APNs after a Clerk sign-in. ViewCode builds
  have no Clerk, so each environment also sends its own notifications through
  Expo's push service (`notifications/PushNotifications.ts`). The phone
  registers its Expo token with `push.register` over its normal connection; the
  environment keeps it per auth session in `<stateDir>/push-devices.json` and
  drops it on `clientRemoved`, when the session has expired (checked before
  every send), on `DeviceNotRegistered` from Expo, or when the same token
  registers from a new session. A phone with both T3 Connect and direct
  notifications on would get both; nothing dedupes across the two.
- Decisions read the thread's current shell, like `AgentAwarenessRelay`, so a
  turn is "finished" only after the service saw it working; the first sighting
  and a session booting at "ready" never notify, and a turn notifies once. A
  turn stopped by a usage limit or a throttle stays quiet: the
  `viewcode.usage-resume` note says what happens next, and only the automatic
  resume (`USAGE_RESUME_AUTO_SUMMARY`) notifies as "resumed". Keep that summary
  constant if the wording changes.
- Expo has no Android notification group key, so a child agent's notification
  is titled with its lead instead; the tap still opens the child.
- On Android the native `AgentMessagingService` (module `t3-agent-notifications`)
  replaces expo-notifications' Firebase service. It handles relay messages
  (`t3_kind=agent_activity`) itself and must keep passing everything else to
  `super`, or Expo pushes stop showing. Expo pushes use the `agent-alerts`
  channel the app creates when it asks for permission.

### Session import

- Three sources share one scan → list → import flow: Claude Code and Codex
  session files, and a T3 Code install (`t3code`, `project/T3CodeHistory.ts`).
  Nothing is imported by default: sessions are picked one by one.
- **Never read T3's live database directly.** T3 Code may be running. The file
  is attached with `mode=ro` to a private temp database, the needed rows are
  copied in one read transaction, the source is detached, and the copy is
  read and deleted. Reads are synchronous `node:sqlite`, so they copy only
  projection rows (never `orchestration_events`). Schema comes from our own
  migrations; a missing table or column reads as unsupported and surfaces as
  the scan/list `warning`, never an error.
- T3's home is `~/.t3` (`userdata`, then `dev`). `T3CODE_HOME` is not honored:
  ViewCode reads that variable for its own home, and a path equal to our own
  `dbPath` is never offered.
- T3 threads import as `import:t3code:<t3 thread id>`, independent of the
  instance they continue on, so a model change in T3 never duplicates them.
  `getImportedAgentSessionSources` knows this naming. Every T3 thread gets a
  binding; its resume cursor is T3's Claude/Codex session only when that
  session ran on the same instance the thread continues on, otherwise null.
  An `import:` thread whose binding has no cursor gets a recap on its first
  turn (`ProviderCommandReactor`, shown as the stale-session notice).
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
- Generated worktree branches use `vc/` (`WORKTREE_BRANCH_PREFIX` in
  `packages/shared/src/git.ts`). Keep `t3code` in
  `LEGACY_WORKTREE_BRANCH_PREFIXES`: threads created before the rename sit on
  `t3code/<hex>` branches and only get their generated name if that still reads
  as temporary. The `t3code://` scheme, socket paths and env vars keep T3's
  name.

### Mermaid diagrams

- Ported from upstream `5e35272fd` with our own look. On an upstream merge,
  keep ours for `apps/web/src/components/chat/MermaidDiagram.tsx` and for the
  mermaid branch of `pre` in `ChatMarkdown.tsx`; upstream's in-file
  `MarkdownMermaidCodeBlock` and the frameless `diagram` mode of
  `MarkdownCodeBlock` are replaced by `chat/MermaidCodeBlock.tsx`.
- Colours come from the live CSS tokens (`chat/mermaidTheme.ts`), resolved
  through a canvas because palettes are written in oklch, and the palette is
  part of the render cache key, so a theme switch re-renders. `theme`,
  `themeVariables` and `themeCSS` are secure keys: a diagram's own `init` or
  frontmatter cannot restyle it, though `look: handDrawn` still works.
- Group colours are appended to the source as Mermaid `class` statements,
  planned from a pre-parse of the flowchart. Author `style`/`classDef` colours
  win: Mermaid inlines them with `!important`, so we skip styled nodes (all of
  them when `classDef default` sets a fill). An author fill without a readable
  `color` keeps the theme's text colour, so `planFlowchartInk` appends an ink
  `classDef` with a readable `color` for those nodes and subgraphs. It has to
  be a class: with SVG labels only a class's `tspan` rule reaches subgraph
  titles and beats an author's own low-contrast `color`.

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
