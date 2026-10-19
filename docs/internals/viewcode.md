# ViewCode decisions

ViewCode is a fork of T3 Code with its own visual identity, provider choices,
agent collaboration and remote-access features. This page records constraints
that span components. Upstream's [orchestration v2 docs](../orchestration-v2/README.md)
remain the authority for the native runtime.

## Staying mergeable with upstream T3 Code

ViewCode follows upstream by ordinary `git merge` again. The v2 port merges
`13aa882c22d584de5388dfce3b3ca413387ba059` (0.1.0), replacing the cherry-pick-only
policy used after common base `024d49520`. The latest merge includes upstream
`8f026485df097cca71f80218a514f4d2e13bbf43`. Future updates start with
`git fetch upstream main` and merge on a review branch. See
[NEXT_AGENT.md](../NEXT_AGENT.md#staying-mergeable-with-upstream-t3-code).

Keep upstream names, directories, commands, events and provider contracts.
ViewCode services live in new files, with small hooks into the native graph.
Shared wire fields are optional; local presentation adapters may preserve older
ViewCode renderer shapes without reintroducing a v1 wire protocol. Native
receipts and worker drains establish completion, not sleeps. Upstream features
excluded from ViewCode are gated, not deleted.

### Feature homes after the v2 port

| ViewCode behavior                                 | Native foundation and ViewCode extension                                                                                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Provider/model handoff and account switching      | Native `ContextHandoffService`/`ProviderSwitchService`; account-scoped continuation keys in the provider drivers (covered by `provider/viewcode/accountSwitchHandoff.test.ts`) |
| Child agents, messaging and controls              | Native delegated tasks and lineage; `agents/AgentMessagingV2.ts`, `server/viewcodeAgentsLayers.ts`, MCP `toolkits/agents/`                                                     |
| Side chats and expiry                             | Native `thread.fork` with optional kind; `ViewCodeSidechatBootstrap.ts`, `ViewCodeSidechatExpiry.ts`, shared `state/sidechat.ts`                                               |
| Exact user-message forks                          | Native `thread.fork` with optional `sourceMessageId`; `orchestration-v2/ViewCodeMessageFork.ts` snapshots a target-local conversation prefix                                   |
| Goals and debug mode                              | `orchestration-v2/ViewCodeGoals.ts`, `ViewCodeTurnGuidance.ts`, MCP `toolkits/goal/`                                                                                           |
| PR/local/incremental reviews and fixes            | `pullRequest/`, `review/`, `review/ReviewActivityStoreV2.ts`; `server/viewcodeReviewLayers.ts` and `viewcodeReviewRpc.ts`                                                      |
| GitHub automatic account routing                  | Upstream GitHub API providers wrapped by `packages/source-control-github/src/server/GitHubAccountRouting.ts` and routed providers; SSH alias resolver                          |
| Review CLI and browser CLI                        | `reviewCli/`, `browserCli/`, sibling executable entries and scoped MCP-session credentials                                                                                     |
| Command Code, Droid and Devin                     | Native provider drivers in `provider/viewcode/`; Droid/Devin use upstream ACP capabilities                                                                                     |
| Pi and Muse                                       | Upstream native provider packages, with ViewCode policy and environment hooks                                                                                                  |
| First-run choice and admin policy                 | `provider/viewcode/firstRunProviders.ts`, launch gates and policy drivers; project toggles remain subordinate                                                                  |
| Provider/account usage and automatic resume       | `resourceTelemetry/`, provider usage readers, `agents/UsageResume.ts` and native lifecycle bridge                                                                              |
| Cursor/T3 session import and history tools        | Native `project/AgentSessionScanner.ts`/`AgentSessionImporter.ts`; `ViewCodeSessionSources.ts`, `CursorHistory.ts`, `T3CodeHistoryV2.ts`, `ViewCodeImportedLineage.ts`         |
| Computer use and phone notifications              | `computerUse/ComputerUseV2Bridge.ts`, server route/layer hooks; `notifications/PushNotifications.ts`                                                                           |
| Desktop without a TCP listener                    | Native Unix/socket transport, desktop backend bridge and scoped stdio MCP connection                                                                                           |
| Quick connect and Tailscale                       | `relay/`, `server/viewcodeRelayLayers.ts`, CLI pairing; native local-target resolution supports TCP and Unix sockets                                                           |
| Theme, composer, sidebar, tabs and project colors | Shared palettes/tokens, `viewcode-theme.css`, ViewCode web components; native client state plus `viewcodeThread.ts`/`viewcodeThreadAtoms.ts` presentation adapters             |
| Mobile                                            | Shared protocol-2 contracts/client runtime with ViewCode screens and navigation                                                                                                |
| Packaging and brand assets                        | `scripts/pack-viewcode-npm.ts`, ViewCode build/install scripts, approved `assets/viewcode-*` sources                                                                           |

Paths without a prefix above are under `apps/server/src/`. This is an integration
map, not a second implementation specification; behavior belongs in source and
focused tests.

## Migration ledgers and old history

Upstream owns `effect_sql_migrations`; fork schema belongs in
`viewcode_sql_migrations`. Six released ViewCode changes originally occupied
upstream ids 55–60, which upstream later reused for v2. The startup repair in
`persistence/ViewCodeMigrations.ts` transactionally moves only those exact known
names to fork ids 1–6, preserving their original timestamps. It runs before
upstream validates its ledger. Unknown or conflicting rows are never discarded.
Future fork changes must use the separate table.

The first native launch copies `state.sqlite` to `statev2.sqlite` once and
imports legacy thread transcripts lazily. The ViewCode legacy metadata adapter
also carries parent relationships, side-chat kind, goal, debug mode, project
color and PR watch. Parent aliases and native lineage must agree. Native v2
state is authoritative after cutover; reopening the old app does not synchronize
subsequent edits in either direction.

User and assistant messages survive; old provider sessions, checkpoints/diffs,
tool calls, approvals and plans are not reconstructed. Continuing an imported
thread starts a new provider runtime with upstream's context handoff. See the
[user migration guide](../user/thread-migration.md), including manual removal
of the old database only after a verified upgrade and separate backup.

## Handoff (switching provider or account mid-chat)

- The projected transcript is the source of truth; provider sessions are only a
  resume cache. Native `ProviderSwitchService` and `ContextHandoffService` in
  `apps/server/src/orchestration-v2/` own the transition. A continuation identity
  includes the provider instance/account: a resume cursor belongs to the identity
  that wrote it and is never handed to another. ViewCode's account drivers keep
  that distinction even when both sides name the same model. Native provider
  resume/fallback rules apply; do not recreate the v1 persisted binding or reactor.
- A model's context-window variant (Claude's 200k / 1M `contextWindow`
  option, which picks the `[1m]` API id) is a model option, not a separate
  model. The composer trigger names the variant because it is part of what runs.
  V2 selection transitions invalidate stale context usage/capacity assumptions
  when the model or its context-window options change; the native adapter decides
  whether it can apply the change in place or must resume the provider thread.
- Clients never lock a started thread to its provider. Web and mobile offer every
  enabled provider, and the next turn's `modelSelection` is the whole request;
  the server decides the handoff. Admin policy and project provider restrictions
  remain authoritative. The model picker labels the pending transfer; a staged
  target does not make it the provider that produced the previous turn.
- A thread's `modelSelection`, `runtimeMode` and `interactionMode` are what its
  next turn uses, and every client sees them change. A composer's pick is only
  an unsent intent kept in its local draft. Mobile retains `serverBasis`
  (`packages/client-runtime/src/composerSettingsBasis.ts`) so a stale local pick
  gives way to a switch from another client. Web uses upstream's native draft
  state and selection transition. Do not prefer a stale provider session's model
  over the selected next-turn model.
- A handoff's "from" identity comes from the leaving native provider thread and
  its continuation identity, not just the thread's newly saved target selection.
  Same model on both sides is a real case (another account), so account identity
  must remain visible to the planner even when a model-only label looks unchanged.
- Portable handoffs select complete historical user/assistant messages with
  attribution and retrieval references; they are not the old fixed 50k-token recap.
  The native budget leaves room for current provider context, the user's request,
  attachments, tools and subsequent work. `packages/provider-core/src/server/handoffBudget.ts`
  owns the capacity accounting; see [portable handoffs](../user/portable-handoffs.md).
  The user's own message is never trimmed to make history fit. If even retrieval
  references cannot fit, fail with an actionable context-limit error rather than
  silently shortening the request. Older text stays in durable history.
- Nothing is ever summarized by a model. The outgoing model is never asked to
  summarize (it is usually out of quota — that's why the user switched).
  Native deterministic compact summaries remain for supported delta/merge-back
  contexts, while selected full messages preserve their roles and order. Codex
  receives historical messages natively when supported; other adapters receive
  the same selection as attributed context.
- Pending transfers and their delivery status are native persisted state. A failed
  send or restart must not claim the handoff was consumed; only native delivery
  receipts establish that. The v1 `<stateDir>/handoffs/<thread>.json` files,
  larger handoff-only input limit, key-fact extractor and transcript-file recap
  transport are no longer the runtime. History retrieval uses native thread/MCP
  services and includes omitted text without depending on a v1 transcript file.

## Agent-to-agent messaging

- Every agents-toolkit tool carries the `viewcode_` prefix (as Traycer prefixes
  `traycer_*`). Codex has its own built-in `spawn_agent`; with the bare name the
  model picked the built-in one, so "sub-agents" never became visible ViewCode
  agents. V2 also exposes native `delegate_task` and its task lifecycle tools.
  Native runtime instructions in `packages/provider-core/src/server/orchestrationInstructions.ts`
  distinguish same-provider native subagents from cross-provider or explicitly
  ViewCode-owned tasks. Use native delegated tasks with `isolation: "worktree"`
  when a separate checkout is needed; never substitute an invisible native child
  for an explicitly requested provider/model or separate ViewCode chat.
- A message still begins with a `<viewcode-agent-message …>` envelope, but
  `agents/AgentMessagingV2.ts` sends it through native `sendToThread`/queued runs,
  not `thread.turn.start`. Idle receiver → starts now; busy → native queue;
  paused → held mail. `reply_expected` routes the receiver's final answer
  **from that run only** back to the sender. The accepted native run ID binds the
  delivery; terminal events are correlated with that ID, not the next session
  that happens to report running. A failed child yields a useful failure reply,
  and a stopped/interrupted run does not produce a spurious completion reply.
- Agents can reach only their own tree (root thread and all descendants). A hop
  limit (24) stops ping-pong loops; spawning counts as a hop too. V2 uses native
  `lineage.rootThreadId` and rejects missing, ambiguous or archived destinations.
  Do not infer tree authority from an optional legacy parent alias alone.
- Child creation and its own worktree use upstream delegated tasks. Their native
  preparation, cancellation and completion wake-up remain authoritative.
  A request accepted through client command intake must also schedule
  `ThreadLaunchService.prepareRun`, as the MCP path does: a persisted child/run
  alone can sit in `preparing` forever. The native launch service owns cancellable
  setup; retries must not create another worktree or setup run.
- Manual **New child agent** uses the same delegated path, with explicit user
  provenance and a real completed parent run/root. Empty/imported-uncontinued
  parents need a message first. A stopped/disposed reporting cohort is not revived:
  ask the user to send another message before creating a child. The new child
  starts from the parent's local commit; uncommitted changes are not copied.
- Stopping an agent that belongs to a tree **pauses** it (user decision).
  `agents.stop` targets one thread or its tree, dispatches native `thread.stop`
  and stops delegated tasks. While paused, messages and replies queue.
  `agents.resume` resumes the native queue, drains held mail, and sends
  "Continue where you left off." for interrupted work. `agents.discard` drops
  held work and discards the affected queued run. Typing a user prompt into a
  paused agent resumes it. Pause/delivery correlation lives in server memory
  (`subscribeAgentControl` streams it); native queued runs remain native persisted
  state. A restart is not a durable store for held mail. Web and mobile share
  `resolveAgentControlAvailability` in client-runtime `state/childAgents.ts`.
- Thread archive/snooze/settlement use native lifecycle commands and guards.
  Sidebar grouping still places a tree as one: the lead's settled state decides
  its folder group, and working/waiting descendants keep it active. Do not restore
  the v1 decider's cascade flags, ancestor wake traversal or timestamp-based
  auto-settle provenance assumptions as if those were native v2 commands.
- Usage limits and transient throttles are different states.
  `classifyLimitError` (`packages/shared/src/usageLimit.ts`, shared with web
  notifications) requires a provider's own quota/plan wording, not loose words
  such as "429", "credits" or "quota", or a `Cause.pretty` stack frame.
  A proxy saying "not your usage limit" is a throttle, not a reason to mark an
  entire tree out of usage. `limitKindOf` (`agents/usageResetTime.ts`) treats a
  retry hint under five minutes as a throttle unless the turn has a stronger
  recorded usage-limit signal. V2 consumes native structured failures/reset
  metadata through `UsageResumeRuntime.ts`; the deleted v1 Claude event ingestor
  and its `LimitMark` timers are not a second source of truth.
- Resume after a limit (`agents/UsageResume.ts`) is for top-level threads and
  leads; child recovery is left to the lead so moved work is not done twice.
  A usage limit schedules "The usage limit has reset. Continue exactly where
  you left off and finish the task." at `max(resetsAt + 60s, now + 5s)`.
  Reset selection uses the recorded provider signal, error text, then a recent
  usage reading; only a future reset counts. A throttle instead retries
  "Continue where you left off." after 10s, 30s and 60s (or its short hint),
  then leaves it to the user. It never uses the usage-reset prompt.
- One failure is decided once, keyed by its failed native run request, so its
  terminal/idle observations cannot turn one failure into several schedules.
  Schedules are JSON files in `<stateDir>/usage-resume/` and survive restart;
  overdue ones run after the startup grace. One sleeping fiber waits for the
  earliest schedule, woken on changes. A user turn, model switch, Cancel,
  archive or delete drops it; another limit failure reschedules once, then stops.
  A due resume is removed before send and restored if nothing started: busy →
  a minute later, user-paused → cancelled, gone/archived → dropped. Only a started
  turn records "resumed". Native `UsageLimitRecoveryWorker` defers message
  dispatch while the ViewCode resume policy owns it, preventing duplicate work.
- The state clients show is a `viewcode.usage-resume` activity (latest wins),
  carried as an optional payload on a native system notice. Desktop notification
  decisions use `AgentControlState.usageResume`, not an early generic failure
  alert. `formatResumeTime` in `packages/shared/src/usageLimit.ts` is shared by
  clients, notifications and messages to agents. The server holds
  `powerSaveBlocker("prevent-app-suspension")` through the typed telemetry channel
  while a schedule exists. There is deliberately no scheduled wake:
  `pmset schedule wake` needs admin, which managed laptops lack, so the computer
  must stay awake and a closed lid may still sleep.
- `viewcode_list_models` lists provider availability with `usable` and a `note`.
  A provider is a separate subscription. Use the vendor's own provider (GPT →
  Codex) over a reseller unless the user names that reseller. Models and tuning
  come from the live native registry; do not copy the old manifest-filtering or
  `runningModel` projection into a second catalog. Agent messages and continues
  use the receiver thread's current model selection rather than a provider
  process's accidental default after a restart.

Ordinary native forks retain upstream run boundaries. ViewCode's user-message
fork passes optional `sourceMessageId` and copies an immutable conversation
prefix through that user message, excluding its later assistant reply. The
prefix belongs to the target thread and is runless, including after paging or
projection replay. Its first continuation uses portable context, even when the
provider supports native forks: native provider turns cannot express this
mid-turn boundary. Do not replace this with an inclusive run fork or read the
source's current history during later handoffs.

Side chats use native fork history with `kind: sidechat`. While a parent has no
stable provider run, a bounded transcript bootstrap supplies context without
changing ordinary fork stability rules. They remain outside delegated-child
usage-resume walks. Idle side chats archive after 24 hours; the 10-minute sweep
rechecks timestamps, active runs and pending requests under the native command
lock before archiving. A stale sweep must not archive a newly active chat.
Unarchive stays available through the normal native path.

## Browser CLI

- `viewcode-browser` reaches the collaborative browser without MCP, for providers whose
  organization blocks MCP servers (or sessions run without ViewCode's tools). `POST /api/browser`
  runs the MCP preview tools' own handlers with the session credential's scope, so validation, the
  `preview` capability gate ("Agent browser access"), broker routing and the agent's current tab
  are shared with the `preview_*` tools; nothing browser-specific is reimplemented. Only snapshot
  output differs: a shell cannot receive an image, so the PNG is saved when an image is requested
  (`browserArtifactsDir`) and its path returned, with the same 20 KB bounding.
- The host is upstream's native Browser host (`preview/ServerBrowser.ts` and
  `apps/desktop/src/preview/DesktopBrowserHost.ts`), selected by the shared broker.
  Use its actual availability/status rather than requiring the deleted renderer
  `PreviewAutomationHosts.tsx`; native browser access works on supported server hosts.
- `viewcode-review submit` is the same escape hatch for `submit_review_findings`, without which a
  reviewer on a machine that blocks MCP finishes its review but the Review panel stays empty:
  `POST /api/review-findings` decodes the tool's own input schema and runs the handler it shares
  with the tool (`makeSubmitReviewFindings`). It is on every session's PATH, as the tool is offered
  to every session; the playbook sends reviewers to it only when the tool is missing.
- CLI routes support both loopback TCP and Unix-socket local targets. A desktop
  no-port environment must not invent a TCP listener just to reach these services.

## Computer use

- The computer-use action transport is the CLI, not a separate MCP action toolkit. Managed Macs block client-supplied MCP servers for Cursor (team policy, enforced
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
  that session's launcher (`packages/provider-core/src/server/computerUseCommand.ts`); otherwise every action asked
  twice. "Plain" is a conservative lexer over the raw command the provider will run (never a
  display title): words and quotes only, nothing a shell would chain, redirect, substitute or
  glob. The command word must be exactly `<shimDir>/viewcode-computer` (`computerUse.cli` on
  `McpProviderSession`), bare or wholly quoted, never the bare name: login shells (Codex runs
  `bash -lc`) rebuild PATH from the user's profile, so a workspace entry (direnv `PATH_add bin`,
  `./node_modules/.bin`) would let an agent that can write files plant its own
  `viewcode-computer` and have it approved. The instructions and `viewcode-computer help`
  (`VIEWCODE_COMPUTER_CLI`) give the agent that path, quoted the way the lexer accepts
  (`shellCommandWord`); the bare name still runs but the provider asks. Native Codex, Claude and supported ACP shell approvals use this recognizer.
  Cursor's local SDK has no shell-environment injection hook; do not claim the CLI
  shortcut works there merely because its native MCP tools do. OpenCode does
  not automatically approve ambiguous patterns: its request carries only per-command patterns with redirections dropped, so it cannot be
  proven plain. Claude under a managed policy that narrows Full access is the exception: the
  thread (and so the gate) is still full access, which would wave the action through unasked,
  so the adapter asks instead (the effective mode from enterprise policy in `ClaudeAdapterV2`).
- The credential is the MCP session credential with a `computer` capability, issued even when the
  provider never loads MCP; the thread always comes from the credential. The CLI's env
  (`VIEWCODE_COMPUTER_ENDPOINT`, `VIEWCODE_COMPUTER_AUTH`, PATH shim) rides the agent-device env
  seam (`withAgentDeviceEnvironment`) at supported adapter boundaries. Names avoid
  KEY/SECRET/TOKEN because Codex's shell env policy strips those. The mode is re-read on
  every request, so turning it off refuses input immediately. `McpSessionRegistry` and
  `ProviderSessionManager` compare capability eligibility on reuse and revoke stale grants.
  For shared Codex app-server processes, credentials are thread-scoped start/resume/fork
  config, never process-wide spawn env. Changing capability waits for that native thread's
  matching closed receipt before resuming new config; it never detaches the shared process
  or another thread. ViewCode-managed Codex uses `thread_unload_delay_secs=0` so native
  retention cannot make the refresh time out and silently replace conversation identity.
  `computerUseApprovals` is read live and never needs a provider restart.
- Instructions are a few lines: the launcher path, `help` (whose output is the manual), the focus
  rule, and that no other installed desktop or browser automation (osascript, screencapture,
  Playwright skills) replaces it. Like agent-device, and unlike a SKILL.md: no files to manage in
  providers' skill folders, nothing loaded when unused, and it cannot drift from the CLI.
  `computerUseInstructions` joins native per-turn app context through the ViewCode turn-guidance
  seam; Codex uses native app context and other providers get the ordinary-text fallback.
  Provider commands/compact text are not rewritten. Security never depends on the model
  following it.
- Approvals are native v2 runtime requests (`computer-use:<uuid>` ids), published by
  `ComputerUseV2Bridge` with their real owning run/session and the optional computer marker.
  `runtime.request.respond` routes through the native control service and shared responder,
  so WebSocket, HTTP, MCP and mobile all reach the same validation before any adapter. When input
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
  landing. Native pending runtime requests are read from v2 projections (user-input/auth-refresh
  questions are excluded); unreadable state fails closed. Live approval publication and
  native turn/session invalidation also reach the bridge before stale input can dispatch. Turn-end receipts and interrupts invalidate input immediately,
  without waiting for the thread projection.
- Two ways to act, chosen per step by the agent: accessibility refs (exact) and screenshot pixel
  coordinates (Codex style, for canvases, browsers and apps with no tree). Window ids, refs and
  shots are per-thread integers starting at a random per-run base; a newer observe retires a
  window's refs, only a window's newest shot accepts coordinates, and the driver re-reads the
  element or window bounds at dispatch and refuses on change. Every input returns a fresh shot.
- Ref actions run in the background: press (AXPress), set-value (AXValue) and type --ref
  (accessible text insertion) act on the element itself, which never needs focus, so they never
  activate, raise or focus anything; activating first took the user's focus for no reason. Only
  their synthetic fallbacks (when press is not advertised or after `ActionNotSupported`), key, type --window, scroll and
  coordinate input bring the exact window to the front. Input results carry `tookFocus` from the
  driver, so the agent and the logs can tell the two apart.
  Check the advertised actions before AXPress: Chrome can accept it without doing anything
  on a web button that only advertises ShowMenu and ScrollToVisible.
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
  public `NSRunningApplication` activation by PID. A bundle-name launch can activate another
  running instance (such as a second Chrome profile), so it is never an activation fallback.
  Listed windows are still raised by AX, and the driver then requires
  the exact target window to be active within 3 s (500 ms was
  too short on a slow managed Mac), failing closed. Windows is refused until there is a real win32
  window model (xa11y treats each top-level window as an app there).
- The driver is xa11y in a child process spawned from the app's own executable with
  `ELECTRON_RUN_AS_NODE=1` (or `viewcode __computer-use-driver` when the backend is standalone
  ViewCode, as on Apple Silicon desktops): macOS keys the Accessibility grant to the responsible app. The sibling
  Helper is the macOS bundle default after real desktop AX/capture and Dock verification.
  `VIEWCODE_COMPUTER_DRIVER_HOST=main` restores the main host; missing Helpers and standalone
  Node keep the main executable. Chromium and
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
  Quartz window (`-l`); the menu bar is never captured. When xa11y omits `AXMenuBar`, a
  prohibited-activation public AX helper supplies it. Its retained references include a helper
  generation: restarting that helper must not bind old refs to recycled native IDs.
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
  the settings status line is a fresh check for that reason. macOS reads a process's grant once,
  so a status that is not granted discards the worker and the next check asks a fresh one; without
  that, granting while the app ran needed a restart. xa11y can report the denial as a
  `PlatformError` saying "Permission denied", which the driver treats as `PermissionDeniedError`.
  A real macOS `list-windows` observation was verified; synthetic input and Windows remain
  separate acceptance work, including whether managed security software tolerates them.
  The first run on such a machine should still be one `list-windows`.

## Command Code

- Native v2 driver `provider/viewcode/commandCodeAdapter.ts` uses the headless CLI (`cmd -p --output-format json`, `--resume <id>`). Its stdin
  closes after the initial prompt, so it cannot accept mid-turn steering. Clients
  queue follow-ups until completion, including after a provider handoff; tool
  completion alone is not a safe send boundary. A rejected follow-up must not
  mark the existing live turn as failed, since agent messaging uses that state
  to decide when to deliver queued work and return results.
- Its CLI loads MCP servers **only** from files (`~/.commandcode/projects/<slug>/mcp.json`,
  project `.mcp.json`, `~/.commandcode/mcp.json`); there is no flag, env var or
  mod API for a per-run config. Command Code does not advertise native MCP. It can work as a delegated
  worker (receive tasks, answers route back) and use authorized CLI service shims;
  never advertise native agent tools, interactive approvals, steering or rollback
  just because the shell can invoke a shim.
- Usage reads Command Code's existing login and `/alpha/billing/*` endpoints
  for enabled, installed instances. `readAccountCredits` defaults on; an explicit
  off setting still prevents credential and billing reads. Successful readings
  are cached for five minutes. Monthly percentages use reported spend plus
  remaining monthly credits, not a plan-price table; five-hour and weekly caps
  come from `windowLimits`. Logs contain key source and request statuses, never keys.

## Pi

- Pi has no ACP mode, so it runs on its own JSONL RPC (`pi --mode rpc`), one process per thread. Pi stores the session; the session file from `get_state` is the resume cursor (`--session <file>`). A turn ends only on `agent_settled`; `agent_end` closes one run, and retries, compaction and queued steers can follow it. A message sent mid-turn is a native steer, so Pi advertises native steering. RPC mode has no `/compact`, so ViewCode's compaction command runs RPC `compact`.
- Upstream's native package (`packages/provider-pi/src/server/`) owns the driver,
  extension and permission bridge. The minimum is 0.80.5, the first published
  Pi with both session entries and settled events. The extension is written into
  the provider cache, loaded with `--extension`, and reads credentials/mode from
  the environment, so credentials never touch disk. It registers exposed MCP
  tools through a scoped HTTP bridge; Pi 0.99's exposure API adds native deferred
  tool visibility when available, but is not the minimum version. Outside Full
  access, a `tool_call` hook asks through `ctx.ui.confirm`, which arrives as an
  `extension_ui_request` and becomes a native runtime approval. Pi has no separate
  permission system, so do not omit this hook when MCP is unavailable.
- Health/model probes remain throwaway RPC sessions with no saved session.
  The native package validates launch flags and versions; do not restore the
  v1 probe's unconditional flags or assume newer MCP options work on 0.80.5.
  Instance environment, admin policy and the scoped device/browser/review CLI
  seams apply through the same native driver boundary.

## ACP and the ViewCode MCP server

- ACP agents with no protocol extensions of their own (Droid, Devin) use ViewCode flavors
  under `provider/viewcode/` with upstream `packages/provider-acp-registry/` and
  `packages/provider-acp/src/server/AcpSessionRuntime.ts`. A flavor supplies spawn,
  sign-in and config-option mapping; native ACP owns approvals, events, resume,
  MCP attachment and runtime instructions. They refuse unsupported steering;
  ACP agents differ on what a second prompt means. Providers with their own
  extensions keep their native upstream adapters.
- Droid keeps its own login, so `authMethodId` is optional in `AcpSessionRuntime`: Droid sends `factory-api-key` only when `FACTORY_API_KEY` is set (as Grok does with its key) and otherwise relies on the login `droid` stored. Device pairing needs a terminal, so ViewCode never starts it. Reacting to an auth-required answer instead does not work: a real agent's JSON-RPC error response reaches the runtime as a defect with only its message (effect-acp decodes plain error responses as dies, and the mock agent, which effect-acp also serves, hides that), so the code -32000 is gone. In ACP mode Droid ignores `-m`/`--auto`; model and autonomy are its `model` and `autonomy_level` config options, set per turn and capped at the org's maximum.
- Devin needs no `authenticate` at all: its ACP server uses the login `devin auth login` stored or `WINDSURF_API_KEY`, and only offers a browser method. Without either, `session/new` still succeeds and prompts fail, so the health check (`devin models list`, which needs a login) is where a missing sign-in shows. `--model` takes fuzzy family names at launch; mid-session changes pick the matching `model` config value (`matchDevinModelValue`). Devin can replay loaded history after `session/load`; the upstream ACP runtime owns
  replay/turn correlation. Do not restore the v1 `loadReplayQuiet` timer as an
  independent completion signal.
- Droid advertises no MCP transport and Devin `http: false`, so both only take stdio servers. On a TCP listener the MCP credential also carries `stdioBridge`, the stdio bridge started with `--url <endpoint>`; the native ACP MCP configuration hands an agent the authenticated stdio bridge
  on either listener. Unix-only sessions use the supported local bridge/proxy;
  never emit a fictitious loopback HTTP port for a socket-only server.
- Command Code, Droid, Devin and Pi participate in the first-run provider picker.
  Native provider-instance configuration and `provider/viewcode/firstRunProviders.ts`
  preserve existing choices. Project toggles remain subordinate to admin policy;
  CLI presence alone must not override an explicit off choice or launch a disabled provider.
- MCP transport capabilities are native protocol capabilities, not a guarantee that tools loaded.
  Droid advertises no HTTP transport and Devin advertises `http: false`; prefer their
  stdio bridge. A session that lacks usable ViewCode tools must report that limitation,
  not silently pretend agent messaging, review submission or browser tools succeeded.
  `session/new` confirms a session, not a tool inventory, and an extra CLI MCP probe
  can itself be risky on managed machines.
- A chat that ends up without ViewCode tools must not start silently (OB8).
  Native runtime instructions explain the available tool path; the agent must say
  plainly when tools are absent and name the likely cause instead of silently
  substituting another provider/model. Managed policy is not bypassed by creating
  a project `.mcp.json`, changing user settings or starting an interactive login.
- Claude Code with an enterprise MCP config (`managed-mcp.json`, detection in
  `provider/viewcode/claudeEnterprisePolicy.ts`) rejects client-supplied MCP servers.
  The managed config is the organization's security control: ViewCode **respects it
  and never routes around it** (no project `.mcp.json`, settings files, env vars or
  edits to the managed file). `ClaudeAdapterV2` omits dynamic MCP when policy or
  `runWithoutViewCodeTools` requires it, preserving chat rather than killing every
  turn. Native notices and available capabilities explain missing tools. The supported
  fix is IT adding ViewCode's server to the managed config, not a hidden fallback.
- A provider CLI that exits on its own must be reported as that process exit with
  useful, bounded and redacted stderr, not as whichever request first touched the dead
  process. Native provider failures and ACP process-exit errors are the v2 boundary;
  do not reintroduce `ProviderService` or a v1 event ingestor to format the error.
- The MCP endpoint is announced on `127.0.0.1` even on a wildcard bind, on purpose (`mcp/McpSessionRegistry.ts`, `getHttpMcpEndpointHost`). Provider subprocesses are local, and MCP never crosses remote connections or tunnels, so "MCP unreachable from remote" is expected, not a bug.

## Reviews and GitHub accounts

ViewCode agent reviews remain the base: PR/local/incremental launches, findings,
ratings, Fix with agent, review ring and `viewcode-review`. Upstream's guided
review tour, review guides, quick actions, in-place confirmation, branch cleanup
and open-on-GitHub preference remain available alongside them. Review activities
are optional payloads on native system notices, not a parallel event protocol.
Fix undo uses native checkpoints and correlates completion or failure to the
specific rollback command.

GitHub transport uses upstream's API providers. The ViewCode routing boundary
pins one credential for a repository operation, including its mutations and
stack-rebase ownership decisions. Repository visibility probes can choose a
second authenticated account; explicit credentials remain authoritative. Never
call `gh auth switch`. SSH aliases such as `github.com-work` must resolve to the
actual API host while preserving repository/account selection. Test both
accounts with a repository inaccessible to the default account.

Posting findings requires the active user-authorized path; scheduled runs,
agent-origin messages and review agents cannot silently post external comments.
CLI and MCP use the same service validation. Review/browser/computer shims get
scoped per-session credentials and must not log them. Cursor's local SDK does
not expose a process-environment hook: use its MCP review tools where a CLI
shim cannot be injected safely.

Native review Undo requires exclusive worktree ownership. A ready checkpoint alone
is insufficient: root checkouts and worktrees shared with idle or archived threads
are refused without file changes. `ReviewFixUndo.native.test.ts` exercises the real
native worker/filesystem restore in an exclusive worktree. The UI explains a known
unsafe scope with Undo disabled and preserves authoritative native refusal detail.
Do not reroute PR Fix to a different branch or fake conversation-only Undo to make
this restriction disappear.

## Goals and debug mode

ViewCode goals/debug guidance are provider-neutral thread metadata, available
through clients and MCP. Hide upstream's native `/goal` UI to avoid competing
goal state. Debug guidance must not alter the provider's own permission policy.

## Desktop local mode and phone access

- By default the desktop backend listens on a Unix socket (named pipe on
  Windows), reached by the window through the main process as
  `t3code-backend://<id>/`; providers reach MCP through a stdio bridge. No TCP
  port. `T3CODE_DESKTOP_BACKEND_TCP=1` forces TCP.
- Network access relaunches the app on TCP for phone pairing; turning it off
  returns to socket-only. Desktop development mode always uses a Vite port.
- The Same Wi-Fi LAN self-test (`checkLanReachability`) runs once per shown
  address each time Connect phone opens, with "Test again" for a re-run, and
  dials loopback before the LAN address so a dead server is not reported as a
  firewall block. Endpoint security on a managed Mac once killed the app for
  this self-connection; ViewCode no longer targets such machines
  ([managed-macos.md](../operations/managed-macos.md)).
- Connect phone (`web/src/components/connectPhone/`) is the user-facing path to
  that toggle, and every mode ends in a pairing QR the matching protocol-2 ViewCode app scans
  (no phone sign-in). Modes come from `resolveConnectModes`: Same Wi-Fi and Quick
  connect always (Quick connect and Tailscale sit under one Anywhere tab, Quick
  connect first); Tailscale only when the desktop finds the `tailscale` CLI on disk
  (PATH, then fixed install paths such as the Mac app's bundled CLI, which never
  joins PATH; never a spawn; `knownTailscaleExecutablePaths` in `packages/tailscale`
  is shared with the spawns, which fall back the same way), whose "Turn on"
  reuses `setTailscaleServeEnabled`. Launch turns Serve on when the CLI is found and
  `tailscale status` shows a tailnet name (`tailscaleAutoServe`, default on, persisted
  only as `false`); turning Serve off also sets it false, so ViewCode never turns Serve
  back on after the user turned it off. Pairing still gates every phone. The dialog
  does not offer upstream's hosted T3 Connect tunnel:
  Quick connect does that job on the user's own account, and a third choice only
  confused people. Native managed relay infrastructure remains upstream code, but ViewCode hides
  its promotions and does not expose the mobile Clerk/T3 Connect sign-in path.
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
  plain HTTPS origin works where tunnels do not. The retained phone app only keeps an origin
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
  frames cannot help because the phone expects one WebSocket message.
- Quick connect is set up from the app by the server (`relay/ViewCodeRelaySetup.ts`), which
  runs `npx --yes wrangler@4` from PATH. A desktop without Node 22+ still works where the server
  is Electron-as-node (not Apple Silicon, whose backend is standalone ViewCode
  and needs Node on PATH like `npx viewcode-app`), so it downloads only npm (pinned version and integrity,
  `relay/bundledNpm.ts`) and runs its `npx-cli.js` under its own executable with
  `ELECTRON_RUN_AS_NODE=1`, a `node` shim first on PATH because wrangler's shebang, npm
  install scripts and esbuild's postinstall start `node` by name. wrangler itself is not
  bundled: its `workerd` dependency is about 100 MB per platform, and npx caches it anyway.
  Under `npx viewcode-app` a missing Node is a message, not a crash. `infra/` does not
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
  and only the wording escalates (`viewCodeRelayHealth.ts`). Each dial has its own
  deadline: undici waits minutes on an upgrade nobody answers, and the QR shows only
  while connected. Nothing in the dialog spins without end: setup steps and the
  connection carry their start time, every wrangler run is bounded, and past a couple
  of minutes the dialog explains instead of spinning.
- ViewCode's desktop identity must never match T3 Code's: production v2 profile folder
  `viewcode-v2` (the v1 profile was `viewcode`), app id `dev.viewcode.app`, WM class `viewcode`. Sharing T3's
  profile shared its IndexedDB lock and cached projects, which stalls first run
  on "Still connecting". A non-default `T3CODE_HOME` also owns its Electron
  profile under `userdata/electron`, resolved before Clerk initializes storage;
  isolating only the server database still lets concurrent desktop runs share
  IndexedDB and authentication state. The default home uses its installed v2 profile; native first-run local-storage
  migration reads the v1 profile without sharing its locked Chromium databases.
- The same holds for the mobile app (`apps/mobile/app.config.ts`): package
  `com.viewcode.app[.dev|.preview]`, schemes `viewcode[-dev|-preview]`, so it
  installs beside the store T3 Code app without Android asking which app opens
  a link. Linking still accepts `t3code://` (the Android widget builds that
  scheme but targets our package explicitly), and QR payloads accept both.
  The EAS project comes only from `VIEWCODE_EAS_PROJECT_ID`/`VIEWCODE_EAS_OWNER`:
  the config is dynamic, so `eas init` cannot write the ID itself, and the cloud
  builder re-evaluates the config, so the ID must also be an EAS environment
  variable (`docs/user/android-app.md`). Without an ID, OTA updates are off.
- The mobile app has no active T3 Connect, Clerk or hosted-relay sign-in path. Phones reach an
  environment only by pairing QR or Add environment with a direct URL (same Wi-Fi,
  Tailscale, or Quick connect, which is just an ordinary `https` address), and
  notifications come from each environment through Expo push. Visible "T3" text
  says ViewCode; internal names (`T3ComposerEditor`, `font-t3-*`, `T3Wordmark.tsx`,
  `t3code://`, env var names) stay for upstream merges. `lib/runtime.ts` still
  provides disabled native managed-relay services and `connection/platform.ts` an empty
  `CloudSession`, because the shared `client-runtime` layers require those
  services. Client-runtime keeps upstream's relay route kind for web and desktop;
  mobile never creates one and drops only an environment's relay route (not the
  environment) when it loads the catalog. **Merge constraint:** preserve the disabled cloud services without reviving
  hosted sign-in/navigation. Keep ViewCode `app.config.ts`, app identities, pinned
  native dependency cohort (no `@clerk/expo`) and Settings screens while adapting
  shared protocol/runtime contracts. Upstream mobile redesign files may be dormant;
  their presence does not authorize mounting them.

## Sidebar

- The shape is fixed by the user: rail, project folders, chats, each chat's agents.
  Do not regroup by time. Grouping, sorting and the attention counts live in
  client-runtime `state/threadArrangement.ts` so web and mobile arrange a folder alike.
- An agent's group comes from `resolveSpawnedAgentRowStatus`, the status its row in
  the lead's chat shows; an agent with no session and no turn is done, not working.
  `sortChatAgents` and `flattenChatRows` must use the same group rule, or a group
  splits into two runs with two labels. Mobile passes one that counts a paused
  agent as Needs you, since it waits for Resume.
- Labels appear only when a chat's agents span more than one group, and Done folds
  only beside other groups: a chat whose agents are all done already folds them
  behind its own disclosure, and a second fold costs a click for nothing. Done opens
  for the open agent, a folder search and a strip filter.
- The attention strip counts each thread once (needs you, then working, then new).
  New is `hasUnseenCompletion`: a thread never opened counts as seen, so a fresh
  install does not light up its history. The counts are one memo in the sidebar;
  rows never subscribe, and a row gets its agent counts as four numbers so memoised
  rows only re-render when their own counts move. A strip filter keeps matches and
  the chats above them, not a matching chat's other agents
  (`selectThreadTreeSearchMatches` with `includeDescendants: false`).
- Folder sort is per logical project key: web keeps it in `uiStateStore`
  (`folderSortOrderById`, the default stored as no entry), mobile for the session
  like its other folder state. Recent and Name are plain orders, so they drop the
  Needs you section on top.
- macOS traffic lights: the desktop window-controls sync marks `<html data-macos-window-controls>` from
  the desktop bridge (`hidden` in fullscreen), and the layout is CSS keyed on it,
  so a browser previews it by setting the attribute. Do not move the offsets back
  into React state. Title row content is measured from the left edge of its own
  column (the sidebar or main column starts after the rail), and with the sidebar
  collapsed or shown as an overlay the main column starts 12pt after the lights,
  because the rail alone is narrower than the three buttons.
- The title bar is a native-style strip: lights, then one fixed group of the
  sidebar toggle and back/forward arrows (`SidebarControl` in
  `AppSidebarLayout.tsx`), so it stays put when the sidebar collapses. The sidebar
  leaves its title row empty for it; "ViewCode" and New sit on the row below
  (user decision, after Synara and Codex). Title content clears
  `--workspace-titlebar-controls-width`, so widening the group means changing that
  one variable. The browser hides its forward stack, so forward availability is
  tracked from router history events (`lib/historyReach.ts`) and starts unavailable
  after a reload.
- The project tint follows only the project picked in the rail: with All, or a
  project without a colour, the sidebar stays neutral and the composer glow keeps
  the theme accent (user decision). It is `--project-accent` on a `display:
contents` wrapper around the shell, since `components/ui` takes no dynamic
  classes; nothing re-renders when it changes. Layer strengths come from
  `shellTint.ts` per theme, written beside the palette by `themePalette.ts`; its
  test holds every built-in theme to readable contrast under the tint, so a new
  theme must pass it. The composer change is limited to the glow's colour and
  alphas; the halo can be turned off, the running light cannot.
- Mobile's thread composer wears the same glow (`features/threads/composerChrome.ts`):
  the thread's project colour, else the theme accent (`--color-focus`), with the
  `shellTint.ts` alphas; mobile has neither setting. Android cannot draw a coloured
  shadow on every version and React Native has no conic gradient, so the halo is
  stacked rings and the running light is SVG wedges drawn once and spun with a
  Reanimated transform under an opaque cover (nothing repaints per frame; off under
  reduced motion and while another screen covers the thread). The Active agents bar
  and the checkout strip are glued to the composer and step aside while the
  keyboard is up.
- Project colour lives on the folder badges and the composer glow. The top bar and the
  tabs carry none (user decision: a coloured header read as a second layer).
  The ViewCode default is pure-black neutrals.
- The shell is one calm surface (user decision, after a tinted panel, a darker
  rail and a glowing Chrome-style tab read as forced, and full-length hairlines
  read as unfinished): title bar, rail and sidebar share the sidebar colour, and
  the work area is one floating panel, Linear-style, inset 8px with 12px corners,
  a faint edge and a soft lift (`--vc-sheet-inset`). Nothing draws a line across
  the window. The selected project and chat are soft neutral fills; a project's
  colour stays on its folder badge and the composer glow.
- Provider usage rings, Settings, Pull Requests and Connect phone stay at the
  bottom of the rail (user decision); the sidebar has no footer of its own.

## Account usage

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
  (`provider/claudeCredentialStore.ts` and `provider/viewcode/claudeResetCredits.ts`). With the opt-in off, the count can still come
  from a recent Claude Desktop usage-cache response for the selected CLI
  organization; cache-only counts cannot authorize redemption. A login that
  cannot be read sets `resetCreditsUnavailableReason` so clients explain the
  gap instead of showing nothing; missing data is unknown, never zero. A banked
  credit can exist before it is usable immediately.

## Phone notifications

- Upstream's push path is T3 Connect: the server publishes agent activity to
  the hosted relay, which sends FCM/APNs after a Clerk sign-in. The ViewCode
  mobile app has none of that, so each environment sends its own notifications
  through Expo's push service (`notifications/PushNotifications.ts`). The phone
  registers its Expo token with `push.register` over its normal connection; the
  environment keeps it per auth session in `<stateDir>/push-devices.json` and
  drops it on auth-session revocation, when the session has expired (checked before
  every send), on `DeviceNotRegistered` from Expo, or when the same token
  registers from a new session. The phone has no Live Activity or relay
  registration path, so Expo push is the only one.
- Decisions read the native thread's current shell, like `AgentAwarenessRelay`, so a
  turn is "finished" only after the service saw it working; the first sighting
  and a recovered/imported idle shell never notify, and a native run notifies once.
  Events come from native `EventSinkV2`, not the removed v1 engine stream. A
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

## Session import

- Four sources share one scan → list → import flow: Claude Code and Codex
  session files, a T3 Code install (`t3code`, `project/T3CodeHistory.ts`) and
  Cursor (`cursor`, `project/CursorHistory.ts`). Nothing is imported by
  default: sessions are picked one by one. Agents reach the same flow through
  the `history` MCP toolkit.
- **Never open T3's source database read-write.** T3 Code may be running.
  The legacy reader attaches the file with `mode=ro` to a private temp database,
  copies the needed rows in one read transaction, detaches the source, and reads
  and deletes the copy. Reads are synchronous `node:sqlite`, so they copy only
  projection rows (never `orchestration_events`). Legacy schema support is kept separate from native v2 reading
  (`project/T3CodeHistoryV2.ts`); unsupported tables/columns surface as the
  scan/list warning instead of fabricating a transcript. V2 reads its native
  projections through a bounded read-only transaction; it never opens the source
  for migration or writes events back.
- T3's home is `~/.t3` (`userdata`, then `dev`), preferring `statev2.sqlite`
  before `state.sqlite` in each location. `T3CODE_HOME` is not honored:
  ViewCode reads that variable for its own home, and a path equal to our own
  `dbPath` is never offered.
- T3 threads import as `import:t3code:<t3 thread id>`, independent of the
  instance they continue on, so a model change in T3 never duplicates them.
  `getImportedAgentSessionSources` knows this naming. Native import binds a provider session only when provider/account
  identity matches the selected continuation; other sources start through a
  portable handoff. Do not revive the v1 binding table or `ProviderCommandReactor`
  to continue an imported thread.
- **Cursor's stores are private and change often** (composerData `_v` 16–18,
  three CLI versions in two weeks), so they get the same read-only treatment
  as T3's: each SQLite file is attached `mode=ro` inside one read transaction,
  only the rows of the chats asked for are read (the editor's `state.vscdb`
  can be 140+ MB), and an unexpected shape is an "unsupported" warning. The
  CLI (`~/.cursor/chats/<md5 of folder>/<chat>/`): `meta.json` places the chat;
  `store.db` `meta['0']` is hex JSON naming a root blob, the root is protobuf
  whose field-1 entries are message blob ids in order, messages are JSON and
  the typed prompt sits in `<user_query>`. It also holds `blobEncryptionKey`,
  which is never read into a result or logged. The editor (`Cursor/User` in
  each platform's app-data folder): `workspaceStorage/*/workspace.json` maps
  storage ids to folders (several ids per folder), `composerHeaders` places
  chats, `cursorDiskKV` has `composerData:<id>` and `bubbleId:<id>:<bubble>`.
  Cursor threads are `import:cursor:<chat>` (editor chats `editor:<id>`) and
  continue with a portable handoff: ACP `session/load` of a CLI chat is untested. Chats
  ViewCode ran itself live in `~/.cursor/acp-sessions`, which is not read.
- `agentSessions.list` reads the recent transcripts without writing and marks
  junk `hidden` with a reason (`classifyAgentSession`): Codex sub-agent and
  internal rollouts, sessions opened by an agent message (Traycer or
  `<viewcode-agent-message>`), sessions whose user messages are only injected
  context, and one-message fragments under 200 characters. Hidden sessions are
  still importable behind "Show hidden".
- `agentSessions.import` takes an optional `sessions` list. Without it (older
  clients) it imports everything recent except Codex internal runs. The recent window remains 60 days.
- Codex writes sub-agent rollouts beside main ones: `session_meta.payload.source`
  `{subagent: {thread_spawn: {parent_thread_id}}}` (rollouts spell it
  `subagent`, the app-server protocol `subAgent`). A child nests under its
  parent when the parent is imported in the same run or already exists
  (second pass for children that arrive first); otherwise it imports flat.
  Titles skip injected blocks and Traycer headers.
- Imported threads have `import:` ids. "Remove imported sessions" archives
  them (restorable from Settings → Archive) and pre-checks only those never continued under native run/provider state.

## Brand assets

- `assets/viewcode-icon.svg` is the approved production icon source;
  `assets/viewcode-mark.svg` is the code-bracket and git-branch emblem alone. Production
  exports come from `icons:export:production`; development and preview retain
  their existing assets and Icon Composer path. Keep exported assets under T3's
  file names so upstream merges preserve the paths. iOS and apple-touch exports
  must be opaque and full bleed because the OS masks them. macOS uses the
  824px-on-1024 grid with a baked shadow; `.icns` is built from the PNG at package
  time. Android production layers are separate from development/preview so a
  production redraw cannot replace those channels' artwork.
- In the UI the mark is `T3Wordmark.tsx` (T3's name kept for the same reason).
  The mark is flat everywhere: white on dark surfaces, near-black on light ones,
  with teal ring centres in both. Brand colors stay fixed rather than following
  each theme's accent; Android silhouettes use the separate monochrome source.
- Generated worktree branches use `vc/` (`WORKTREE_BRANCH_PREFIX` in
  `packages/shared/src/git.ts`). Keep `t3code` in
  `LEGACY_WORKTREE_BRANCH_PREFIXES`: threads created before the rename sit on
  `t3code/<hex>` branches and only get their generated name if that still reads
  as temporary. The `t3code://` scheme, socket paths and env vars keep T3's
  name.

## Mermaid diagrams

- Originally ported from upstream `5e35272fd` with our own look. On an upstream merge,
  preserve the theme/ink behavior in `apps/web/src/components/chat/MermaidDiagram.tsx` and for the
  mermaid branch of `pre` in `ChatMarkdown.tsx`; `chat/MermaidCodeBlock.tsx` owns the ViewCode frame and controls rather than
  replacing it with a second native diagram renderer.
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

## Read aloud

- The speaker button reads one assistant message, the same one Copy copies:
  the final message of a settled response. Progress messages written mid-turn
  are never read, and the palette command picks the same message
  (`latestReadableReply` in `apps/web/src/lib/readAloud.logic.ts`).
- A saved voice names its engine (`ReadAloudVoice` in contracts `settings.ts`):
  the Web Speech system voice, or the natural voice, Kokoro-82M (Apache-2.0)
  through `kokoro-js` on ONNX Runtime's WASM backend in a module worker
  (`readAloudKokoro.worker.ts`). Null is the default, the natural voice's small
  tier. Voice and speed are client settings because voices are per device.
- The model is downloaded, never bundled: the q8/fp16/fp32 tiers are 92, 163
  and 326 MB, which would multiply the installer and every update. Only ONNX
  Runtime's WASM-only build ships (about 11 MB, aliased in `vite.config.ts`; the
  default WebGPU build is twice that), loaded from the app, never a CDN.
- The environment downloads the model, not the client
  (`apps/server/src/voiceModels/VoiceModelStore.ts`): GitHub release downloads
  send no CORS headers, and managed networks often block Hugging Face. It reads
  `manifest.json` from the `voice-models-v1` release (made by
  `.github/workflows/voice-models.yml`), falls back to Hugging Face per file,
  and checks every SHA-256. Clients load the files through a signed
  `voice-model` asset URL, so remote clients use their server's copy. The
  worker rewrites the hub URLs Transformers.js and kokoro-js (whose voice URLs
  are fixed) ask for to that URL, and keeps no browser copy.
- The natural voice never leaves silence: until its tier is downloaded, or if
  it fails, the system voice reads (the rest of) the reply and a notice beside
  the button says why. The first press starts the download; a failed one is
  retried from Settings, not on every press. Chunks are synthesized one ahead
  of playback (`playChunksAhead`), so a long reply starts after one chunk.
- Utterances stay under 250 characters: Chromium's `speechSynthesis` cuts off
  or stalls long ones, and drops events for utterances it garbage-collects, so
  the queue stays referenced until it ends.

## Dictation (web and desktop)

- Mobile keeps its native recognizers. Web and desktop run Moonshine base
  (q8, MIT) in `lib/dictationModel.worker.ts` on the same Transformers.js and
  WASM-only ONNX Runtime as read aloud. Moonshine was chosen over Whisper
  base.en because its cost follows the clip's length; Whisper pads every clip
  to 30 s, which makes re-reading a growing utterance several times a second
  too slow on a laptop CPU.
- Delivery is read aloud's: `VoiceModelStore` downloads the `dictation` model
  key from its own `dictation-models-v1` release (release assets are flat, and
  both models ship a `config.json`), verifies each SHA-256 and serves it through
  the `voice-model` asset. A dictation download never replaces a voice download.
  Its state is the optional `dictation` field of `VoiceModelsState`, so older
  clients ignore it and a missing field means the server can't serve dictation.
- Capture is an AudioWorklet that downsamples to 16 kHz itself (Firefox refuses
  to connect a microphone to a context at another rate) and posts 50 ms frames.
  The worklet is imported with `?worker&url` so it is bundled and served from
  the app's origin: the desktop renderer's script policy does not allow `blob:`.
- `DictationSegmenter` cuts frames into utterances on a noise-floor-relative
  energy threshold. Finished utterances are transcribed once; the open one is
  re-read every 600 ms of new audio, so words appear while speaking. Utterances
  split at 12 s, at their quietest recent frame, and `joinTranscript` rejoins
  the halves. One transcription is in flight at a time
  (`lib/dictationSession.ts`).
- Moonshine's pipeline caps output at 6 tokens per second of audio, rounded
  down, so a clip under a second would get none; the worker passes its own cap
  with a floor.
- One dictation runs app-wide; the composer that started it owns it, and
  changing draft or unmounting cancels it. Levels reach the waveform through
  `subscribeDictationLevels`, never React state.

## Multi-surface and product policy

All clients share protocol 2. Web and desktop use the same native client state;
mobile keeps ViewCode's screens while adapting contracts and commands. The
upstream mobile navigation redesign, iPad columns, tab bar, Enriched Markdown,
native segmented controls and offline PR redesign are intentionally excluded.
The mobile React Compiler remains off through `upstreamMobileCompiler`; the
upstream coverage/lint ratchet is retained behind that policy until the existing
ViewCode screens are validated for compiler adoption. Android foldable/rail and
layout changes stay excluded with the navigation redesign.

Remote use is a first-class path. Do not bake origins into Vite bundles.
Pairing links are credentials: never consume the owner's link while testing or
publish it in logs/reports.

Doctor/triage and their suggestions, Settings command installation, Nightly/Discord/beta
notices, T3 Connect promotions and anonymous-usage onboarding copy stay hidden.
Database cleanup is documented as a deliberate manual task, not an automatic
upgrade side effect.

Anonymous analytics default to disabled with no bundled collection key; explicit
operator configuration is required to enable collection. Native CLI self-update
and background-service installation stay behind `nativeCliManagedRuntime` until
ViewCode has its own release source. Upstream's managed runtime resolver downloads
T3 binaries, so enabling that path would replace the fork. Manual npm guidance
uses the optional installation package identity and preserves `viewcode-app`.

## Traps (things that cost hours)

- **Running as root in a sandbox:** Claude refuses `bypassPermissions` as root;
  start the isolated test server with `IS_SANDBOX=1` when that sandbox requires it.
  Treat root/platform-only failures separately from product defects.
- **No IPv6 in some sandboxes:** port probing treats `EAFNOSUPPORT` as
  available (`packages/shared/src/Net.ts`).
- **Stale Electron processes** from earlier test runs keep the profile's
  IndexedDB `LOCK`; the renderer then never opens its WebSocket and shows
  "Still connecting". Inspect holders without killing by a name/path pattern. Stop only a PID
  captured when starting your own process, or follow AGENTS.md's confirmed-port rule. A killed backend may be respawned by a surviving main process.
- **The desktop renderer uses a hash router** (`t3code://app/#/settings/…`);
  `history.pushState` does nothing there.
- **Turning on network access relaunches Electron**, so Playwright loses its
  handle; refresh the approved native test handle against the same isolated home.
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

Use `vp i`, focused `vp test run <files>`, and targeted checks as described in
`AGENTS.md`. A worktree's gitignored `.t3` is the default isolated development
home; an explicit `--base-dir` must always name disposable copied state. Never
start a development server on live userdata or the recovery backup. Native
receipts and worker drains establish completion; do not replace them with sleeps.
