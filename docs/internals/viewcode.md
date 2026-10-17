# ViewCode decisions

ViewCode is a fork of T3 Code with its own visual identity, provider choices,
agent collaboration and remote-access features. This page records constraints
that span components. Upstream's [orchestration v2 docs](../orchestration-v2/README.md)
remain the authority for the native runtime.

## Staying mergeable with upstream T3 Code

ViewCode follows upstream by ordinary `git merge` again. The v2 port merges
`13aa882c22d584de5388dfce3b3ca413387ba059` (0.1.0), replacing the cherry-pick-only
policy used after common base `024d49520`. Future updates start with
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

## Handoffs and provider identity

The projected transcript is durable history; a provider session is a resume
cache. Model/provider switches use upstream's context selection and portable
handoff delivery. ViewCode account changes enter the same path. Native resume
handles belong to the provider instance and account that created them and must
never cross that boundary. User input for the new turn is never shortened to
make a handoff fit. History outside the selected budget remains retrievable.
Do not restore the v1 handoff clipper or per-provider recap implementations.

Capabilities drive UI and MCP availability. Command Code does not steer an
active turn; queued messages wait until it ends. ACP support does not imply every
provider supports every optional control. Admin restrictions win over project
settings, onboarding and explicit agent requests; disabled providers must not
be launched or probed by setup helpers.

## Agent collaboration and side chats

Delegated tasks own child creation, isolated worktrees, completion wake-up and
cancellation. ViewCode adds agent-to-agent messaging, discovery/history tools,
control queues and the sidebar tree. Messages retain sender provenance and
correlation; tree permissions and the hop limit prevent cross-tree delivery
and reply loops. Completion replies are emitted once, including a useful
failure notice when a child cannot produce a final answer. Stopped/interrupted
work does not generate a spurious completion reply.

Side chats use native fork history with `kind: sidechat`. While a parent has no
stable provider run, a bounded transcript bootstrap supplies context without
changing ordinary fork stability rules. They remain outside delegated-child
usage-resume walks. Idle side chats archive after 24 hours; the 10-minute sweep
rechecks timestamps, active runs and pending requests under the native command
lock before archiving. A stale sweep must not archive a newly active chat.
Unarchive stays available through the normal native path.

Usage limits and transient throttles are different states. Automatic resume is
thread-local, never a retry loop for delegated children: the lead receives the
child's outcome and decides what to do. Paused mail and queued messages retain
their distinct stop/resume/discard controls.

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

## Goals, tools and imports

ViewCode goals/debug guidance are provider-neutral thread metadata, available
through clients and MCP. Hide upstream's native `/goal` UI to avoid competing
goal state. Debug guidance must not alter the provider's own permission policy.

Computer use is authorized by the environment service even when the provider
runs with full access. Native runtime requests carry its approval state;
approval-waiting threads cannot issue input behind the prompt. Live policy
changes take effect on the service path. Browser, computer and review CLIs are
thin transports to services, with the same per-thread authorization as MCP.

Session import is explicit and read-only at the source. The recent-session
window is 60 days, and parsing remains bounded/streamed; preserve the original
user text and report unsupported data rather than fabricating history. Same
provider/account matches may bind to an imported native session; other sources
start through portable handoff. The metadata-only second pass nests imported
provider children even when parents arrive last. Missing parents, cycles and
cross-project links stay flat. Never open the live database read-write to scan
or test an import.

## Multi-surface behavior and branding

All clients share protocol 2. Web and desktop use the same native client state;
mobile keeps ViewCode's screens while adapting contracts and commands. The
upstream mobile navigation redesign, iPad columns, tab bar, Enriched Markdown,
native segmented controls and offline PR redesign are intentionally excluded.

Remote use is a first-class path. Do not bake origins into Vite bundles. Desktop
local mode can use a Unix socket without a TCP listener; scoped MCP, Quick
connect and network opt-in must work through the correct transport. Pairing
links are credentials: never consume the owner's link while testing or publish
it in logs/reports.

ViewCode keeps its name, approved icon sources, theme, bundle ids and npm package
name. Keep upstream internal filenames, environment keys, legacy URL schemes
and socket names when renaming them would break compatibility. Generated
branches use `vc/`; legacy generated prefixes remain recognized. Preserve
upstream licenses, notices and attribution.

Doctor and its suggestions, Settings command installation, Nightly/Discord/beta
notices, T3 Connect promotions and anonymous-usage onboarding copy stay hidden.
Database cleanup is documented as a deliberate manual task, not an automatic
upgrade side effect.

Anonymous analytics default to disabled with no bundled collection key; explicit
operator configuration is required to enable collection. Native CLI self-update
and background-service installation stay behind `nativeCliManagedRuntime` until
ViewCode has its own release source. Upstream's managed runtime resolver downloads
T3 binaries, so enabling that path would replace the fork. Manual npm guidance
uses the optional installation package identity and preserves `viewcode-app`.

### Visual and media constraints

Droppy Code's MIT-licensed composer and chrome are visual references, not a
replacement identity. MonoCode and Traycer supplied handoff/agent ideas only.
Keep the approved `assets/viewcode-icon.svg` and mark sources, with production
exports in upstream-compatible asset paths. iOS icons are opaque/full bleed;
macOS exports use their platform grid and shadow. The UI mark uses fixed brand
colors rather than inheriting each theme's accent.

Themes belong in shared tokens and UI variants. Avoid continuously repainting
animation; composer effects run only while open and respect reduced motion.
Sidebar folder/agent arrangement must use native lineage and shared selectors.
Account usage is opt-in: missing data means unknown, never zero; credentials
and keychain output never enter logs.

Mermaid uses live theme tokens and a theme-aware render cache. Diagram-provided
style colors may win, but cannot overwrite secure theme configuration; preserve
readable label colors. Read aloud selects the settled assistant reply rather
than progress messages. Kokoro-82M is Apache-2.0: models are downloaded by the
environment, checked against SHA-256 manifests and served through signed asset
URLs, never bundled into every installer or fetched independently by each
remote client. Keep the system-voice fallback.

## Traps worth preserving

- Never kill processes by pattern or launch against live userdata. Snapshot with
  `VACUUM INTO` and stop only PIDs captured when starting your own processes.
- The desktop renderer uses a hash router; `history.pushState` does not navigate
  it. Enabling network access may relaunch Electron and invalidate a test handle.
- Production CSS can collapse an unnamed animation shorthand to `none`; use
  animation longhands. `tailwind-merge` can drop one of two background images in
  `cn(...)`; keep independent theme layers explicit.
- Root-run Claude requires `IS_SANDBOX=1` for bypass-permissions testing. Treat
  sandbox platform limitations separately from product failures.
- `cli/triagePrompt.ts` and `.github/triage/PLAYBOOK.md` are a matched upstream
  artifact; do not rebrand only one.

Use `vp i`, focused `vp test run <files>`, and targeted checks as described in
`AGENTS.md`. A worktree's gitignored `.t3` is the default isolated development
home; an explicit `--home-dir` must always name disposable copied state.
