# Managed mode: making ViewCode start on an EDR-protected Mac

Implementation plan. Background: [`managed-macos.md`](managed-macos.md).
Experiments and their raw results: [`managed-mac-experiments.md`](managed-mac-experiments.md).
Reviewed twice (Astra, 2026-09-26); this version folds in both reviews.

**Principle: do less, never hide.** Every change removes work the app doesn't
need, or runs it only when a feature needs it. Nothing renames, disguises,
delays for the sake of detection, strips security metadata, or otherwise
changes how security software sees the app.

## Status

| Item                                                                                | Planned  | Committed                                                                   | Verified in a DMG on the laptop                 |
| ----------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------- | ----------------------------------------------- |
| Provider selection gate (Phase 1)                                                   | yes      | in progress                                                                 | no                                              |
| Launch guard on every execution path                                                | yes      | partial: health checks only (`bfbb442b4`), being reworked (see Guard below) | no                                              |
| Onboarding picker                                                                   | yes      | no                                                                          | no                                              |
| Claude enterprise-policy fix                                                        | yes      | no                                                                          | no                                              |
| `./build.sh --managed` (writes the provider choice)                                 | yes      | yes                                                                         | equivalent settings verified (Round 3)          |
| Offline desktop build (vendored SPDX), `vp` resolution, `ViewCode-*` artifact names | yes      | yes (`b04d42085`)                                                           | build verified on the laptop before this change |
| Phase 2 startup diet                                                                | optional | no                                                                          | no                                              |

## What the evidence shows

| Run (laptop, 2026-09-26)                                    | Binary signing      | Codex / OpenCode / Grok  | Result                                                         |
| ----------------------------------------------------------- | ------------------- | ------------------------ | -------------------------------------------------------------- |
| `npx t3 serve`, no providers / + Claude / + Claude + Cursor | Developer ID (`t3`) | off                      | alive 180s each                                                |
| DMG app, fresh profile (defaults: Codex on)                 | ad-hoc, no team     | on                       | terminated (Behavioral Threat Protection, source = app binary) |
| Same DMG app, Round 3                                       | ad-hoc, no team     | off (Claude + Cursor on) | alive 8+ min, clean quit                                       |

What this supports: with Codex, OpenCode and Grok off, the same unsigned app
survives, so **restricting which providers run is the fix**. What it doesn't
show: which of the three is the trigger, or that any other configuration is
safe everywhere. Also: an earlier "`npx t3` dies" report may have been an agent
harness tearing down its own process group, which looks identical to an EDR
kill; treat a dead process without a Terminate alert as unexplained.

## Phase 1: choose agents before anything is launched

Agreed with the user; this is the fix.

**What the user sees.** ViewCode opens and lists the providers it supports,
all off, each with "Found at `<path>` (custom path | inherited PATH)" or "Not
installed" from a disk check (nothing run). The user picks the ones they use
("Enable 2 agents", or "Continue without agents"). Only then are those checked;
an already signed-in provider (Claude Code, Cursor) is picked up as today.
Turning on a provider the machine blocks is the user's call.

**Rules**

1. **Nothing runs until a choice is made.** While selection is pending, every
   provider instance is effectively off: no boot probe, interval, refresh,
   session, recovery, queued delivery, text generation, workspace scan or
   sign-in.
2. **Selection state is explicit and decided once.** Field
   `providerSelection: "pending" | "chosen"`; **absent means "needs
   migration"**. The decision is made from the raw persisted settings before
   providers are constructed, and persisted:
   - brand-new home, unreadable settings, or an old home with no projects and
     no explicit provider choices → `pending` (user's decision for the
     ambiguous case);
   - an old home with projects/threads, explicit `providers.*.enabled`, or any
     `providerInstances` entry → `chosen`, behaving as today.
     Malformed settings files are preserved, not overwritten. If persisting the
     decision fails, provider execution stays disabled for that run. Pending
     survives restarts even if projects are created meanwhile.
3. **A choice writes every effective instance** in one settings write:
   instances of chosen drivers on (all accounts of that driver), everything
   else explicitly off, selection `chosen`. It is an initial-choice operation:
   a stale second screen is rejected. Flipping a switch in Settings while
   pending counts as the first choice (that one on, the rest off).
4. **Turning a provider off stops it immediately** (user's decision), including
   an in-flight probe, and nothing relaunches it (recovery, queued work).
5. **Never run a provider whose executable can't be resolved** (see Guard).
6. **A copied profile keeps its choices** (user's decision).

**Guard (every execution path).** One helper resolves the provider executable
from the instance's effective environment (custom `binaryPath`, else the
instance's PATH; relative paths against the real working directory) **before**
any Windows `.cmd`/`.bat` shell wrapping, re-validates that the resolved file
exists and is executable immediately before launch (no stale lookup cache),
and launches **that resolved path**. Anything it can't resolve fails closed
("Not installed" / "Couldn't resolve"), never "execute anyway". It must sit at
the real launch boundaries, including dependencies built before the health
check: OpenCode's server owner (`OpenCodeDriver.ts:141`,
`OpenCodeServerOwner.ts:101`) and the Claude SDK (`ClaudeProvider.ts:345`,
`ClaudeAdapter.ts`, passed as `pathToClaudeCodeExecutable`). Antigravity uses
its own install resolver (`AntigravityInstallation.ts:404`).

**Implementation**

| Piece                                                                                                                               | Where                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Selection state + one-time migration                                                                                                | new `apps/server/src/provider/providerSelection.ts`; optional field in `packages/contracts/src/settings.ts`                                                                                                                                                                                                                                                                                                             |
| Gate applied when deriving the effective instance map (so reconciliation reacts)                                                    | `ProviderInstanceRegistryHydration.ts` (`deriveProviderInstanceConfigMap`)                                                                                                                                                                                                                                                                                                                                              |
| Guard call sites                                                                                                                    | health checks (each driver's `checkProvider`); `ProviderService.ts` recovery (~1239; new sessions ~1431 check `enabled` already); `textGeneration/TextGeneration.ts:118`, `CodexTextGeneration.ts:196`; `ProviderRegistry.ts:844` / `CodexDriver.ts:243` (workspace); `ProviderAuthService.ts:18`; OpenCode server owner; Claude SDK; maintenance enrichment skipped for disabled instances (`CodexDriver.ts:208` etc.) |
| `detect` (filesystem only) and `choose` (initial-choice) RPCs                                                                       | contracts + `apps/server/src/ws.ts`, reusing the settings mutation (`serverSettings.ts` ~986)                                                                                                                                                                                                                                                                                                                           |
| Onboarding picker, per environment and named ("Agents on Work Mac"), "Check again" (filesystem only, bypasses the 30s lookup cache) | new `onboarding/ProviderChoiceStep.tsx` in `AgentsStep`; must not call `refreshProviders` before the choice (`WelcomeWizard.tsx:675`)                                                                                                                                                                                                                                                                                   |
| Clients reaching a pending server another way (remote browser, phone)                                                               | banner "Choose which agents ViewCode may run on <computer>" → Settings → Providers                                                                                                                                                                                                                                                                                                                                      |
| Status wording                                                                                                                      | "Found · Not started" → "Checking" → "Ready" / "Sign-in needed" / "Couldn't start", with last-checked time; "Stopped unexpectedly" + "Turn off", never claiming a cause                                                                                                                                                                                                                                                 |
| Crash loops                                                                                                                         | cap desktop backend restarts after abrupt exits (`DesktopBackendManager.ts:994`); title generation stops retrying after abrupt kills (`ProviderCommandReactor.ts:1128`)                                                                                                                                                                                                                                                 |
| Built-in spawn trace                                                                                                                | `<stateDir>/logs/spawn-trace.log`: time, executable, instance/purpose, exit result; no argument payloads; size-capped. Patching `child_process` covers SDK launches; document any gaps                                                                                                                                                                                                                                  |
| `./build.sh --managed`                                                                                                              | writes instance-level choice (Claude + Cursor) and `providerSelection: "chosen"`                                                                                                                                                                                                                                                                                                                                        |

**Tests:** fresh home launches nothing; pending survives a restart with
projects created; malformed settings → pending, file preserved; failed
persistence → execution disabled; explicit `providerInstances` respected by
migration and choice; interval/manual/workspace refresh, text generation,
queued delivery and recovery launch nothing while pending or for a disabled
provider; disabling during an in-flight probe stops it; a stale second
`choose` is rejected; a Settings toggle while pending closes selection with
the rest off; unresolvable executables (missing, relative, Windows `.cmd`) are
never launched; the resolved path is what gets launched.

## Claude on Macs with Claude Code enterprise policy

On the laptop, Settings → Providers shows Claude "Needs attention · Could not
verify Claude authentication status" although `claude auth status` is healthy.
The machine has `/Library/Application Support/ClaudeCode/managed-mcp.json`
(and `managed-settings.json` with `allowManagedHooksOnly`); Claude Code refuses
`--strict-mcp-config` when an enterprise MCP config is present.

- Affected: the capability probe (`buildClaudeCapabilitiesProbeQueryOptions`,
  `ClaudeProvider.ts`, `strictMcpConfig: true`) and title/text generation
  (`ClaudeTextGeneration.ts`, `--strict-mcp-config`). Sessions
  (`ClaudeAdapter.ts`) don't pass it; confirm threads start on the laptop.
- Fix: when the managed MCP file exists (macOS path above; Linux
  `/etc/claude-code/managed-mcp.json`; Windows
  `C:\Program Files\ClaudeCode\managed-mcp.json`), omit the strict flag and
  keep the empty `mcpServers` and `ENABLE_CLAUDEAI_MCP_SERVERS=false`; surface
  the probe's error text instead of `orElseSucceed(() => undefined)`; fall back
  to `claude auth status` for the account display. Then check whether
  `--settings {"disableAllHooks":true}` collides with `allowManagedHooksOnly`.
- Open: under an enterprise MCP config, Claude may ignore the MCP server
  ViewCode passes to sessions (the agents toolkit), so child agents / agent
  messaging with Claude may not work there. Test on the laptop.

## Installers (DMG, EXE, AppImage)

The gate is server code, so every artifact from `pnpm dist:desktop:*` carries
it; nothing may depend on `build.sh`, environment variables or a checkout.

- Whether a packaged app honours `NODE_OPTIONS` depends on its Electron fuses
  (the backend runs Electron with `ELECTRON_RUN_AS_NODE=1`,
  `DesktopBackendConfiguration.ts:574`); inspect, don't change them. Verify
  with the built-in spawn trace, and add a desktop "Open logs" action that
  works while the server is down (state dir from `DesktopEnvironment.ts:219`).
- macOS without admin: install to `~/Applications` (ordinary user location).
  Never strip security metadata (e.g. the quarantine attribute). A build made
  on the same machine isn't quarantined; if a copied build won't open
  normally, report it. Signing + notarization improve provenance but don't
  guarantee a policy accepts the app. The DMG layout currently points only to
  `/Applications` (`build-desktop-artifact.ts:2726`); the Windows NSIS
  installer supports per-user installs (`:2787`).
- Verify from Finder / Start menu, not a shell with exports, and a standard
  (non-admin) Windows user.
- Acceptance: clean profile, install, launch, stop at the Agents step → the
  spawn trace shows no provider CLI; choose Claude + Cursor → only `claude` and
  `cursor-agent` launch.

## Phase 2: optional startup diet

Not needed to survive (Round 3). Each item is justified on its own (startup
latency, least privilege) and lands separately, in this order:

1. **PATH, step A: resolve once per environment.** The desktop and the backend
   both run a login shell today (`DesktopShellEnvironment.ts`, `os-jank.ts`);
   remove the duplicate. "Once" means per environment: a Windows desktop must
   not hand its PATH to WSL or a remote machine
   (`DesktopBackendConfiguration.ts:795`).
2. **PATH, step B: resolve in-process** (no shell at startup; `-lc` still runs
   login files, so it isn't the goal). Preserve what the current code imports
   besides PATH: `SSH_AUTH_SOCK`, locale with the UTF-8 fallback, Homebrew and
   Linux desktop-session variables (`DesktopShellEnvironment.ts:428,459`).
   Respect custom paths, the selected runtime and version-manager shims; don't
   silently prefer the newest nvm install. Shell-based discovery, if kept,
   is an explicit, bounded user action, not an automatic fallback.
3. **Host lookups.** Use `hostname()` (already the fallback,
   `ServerEnvironmentLabel.ts:190`) and the existing "no machine
   classification" state (`ServerEnvironment.ts:206`) instead of running
   `scutil`/`ioreg`/`sysctl`; if no feature needs the model, don't discover it
   at all. Expect plainer names and generic icons; keep environment identity
   and user labels.
4. **Resource-monitor sidecar, last.** Start it when a feature needs it:
   terminals' process inspection (`terminal/Manager.ts:1433,1481`, which
   otherwise falls back to spawning `ps`), diagnostics subscriptions and
   explicit sampling, using the existing subscriber accounting
   (`ResourceTelemetry.ts:362,415`); stop when demand ends. UI copy:
   "Monitoring starts when needed; earlier history is unavailable."

Independently justified, not tied to the EDR: telemetry identity should never
read credential files (`telemetry/Identify.ts`, `AnalyticsService.ts:88`).
Deferred: seeding provider status from cache (`ProviderRegistry.ts:314-375`).

## Settings for the laptop today

`./build.sh --managed` writes this into `~/.viewcode/userdata/settings.json`
(merging with what's there), which is what Round 3 ran:

```json
{
  "providers": {
    "codex": { "enabled": false },
    "claudeAgent": { "enabled": true },
    "cursor": { "enabled": true },
    "grok": { "enabled": false },
    "opencode": { "enabled": false },
    "antigravity": { "enabled": false },
    "commandCode": { "enabled": false }
  },
  "defaultAutoPull": false
}
```

## Reference: what ViewCode launches at startup (before Phase 1)

Traced from source at `0a6fb7d46`.

| Launch                                                         | Where                                                                                    | Notes                                                                                                   |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `$SHELL -ilc …` (desktop)                                      | `apps/desktop/src/shell/DesktopShellEnvironment.ts:310-321`                              | `.zshrc` spawns more (nvm, starship)                                                                    |
| `$SHELL -ilc …` (backend, again)                               | `apps/server/src/os-jank.ts:20-37` → `packages/shared/src/shell.ts:291-303`              | duplicates the desktop's work                                                                           |
| `t3-resource-monitor` sidecar                                  | `apps/server/src/resourceTelemetry/NativeTelemetryClient.ts:568-600`                     | unconditional                                                                                           |
| `scutil`, `ioreg`, `sysctl`                                    | `environment/ServerEnvironmentLabel.ts:158`, `ServerEnvironmentMachine.ts:136,143`       | host/model discovery                                                                                    |
| `codex app-server`                                             | `CodexDriver.ts:182` → `CodexProvider.ts:561-613`                                        | Codex enabled by default                                                                                |
| `claude --version`, SDK `claude --output-format stream-json …` | `ClaudeProvider.ts:461`, `332-402`                                                       | enabled by default                                                                                      |
| `cursor-agent about`, `cursor-agent acp`                       | `CursorProvider.ts:1131`, `497-518`                                                      | off by default                                                                                          |
| `grok …`, `opencode --version` / `opencode serve`              | `GrokProvider.ts:394-499`, `OpenCodeProvider.ts:444-523`                                 | off by default, re-enabled by `restoreUsedProviders` (`serverSettings.ts:279-331`) if history used them |
| `cmd …`                                                        | `CommandCodeProvider.ts:124-176`                                                         | auto-enabled when `cmd` is on PATH                                                                      |
| `brew --prefix`, `brew info`                                   | `providerMaintenance.ts:466-489`                                                         | Homebrew-installed providers, even disabled ones                                                        |
| `git`, `gh pr …`                                               | `ThreadPullRequestReactor.ts`, `ThreadSettlementReactor.ts`, `PullRequestSyncReactor.ts` | every minute for threads with branches                                                                  |

Every driver's `create` forks a forced probe immediately
(`makeManagedServerProvider.ts:281-284`), and before the guard no driver
checked that its executable exists: "not installed" came only from `spawn`
failing (`resolveSpawnCommand` does no lookup on macOS/Linux).
