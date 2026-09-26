# Managed mode: making ViewCode start on an EDR-protected Mac

Implementation plan. Background and evidence: [`managed-macos.md`](managed-macos.md).
We cannot get the EDR rule name or an exception, so this plan works from
stated assumptions and gives the user a way to find the culprit on the machine.

**Principle: do less, never hide.** Every change removes work the app doesn't
need to do on that machine. No renaming, obfuscation, or anything that makes a
behaviour harder for the EDR to see. If ViewCode still dies with everything
below in place, the fallback is the diagnosis ladder, not evasion.

## Facts from the user (2026-09-26)

- `claude` and `cursor-agent` run fine from Terminal. These are the only
  providers they will use on this machine.
- Installing Codex, OpenCode and similar is blocked, so assume those binaries
  are **absent** (or present but blocked).
- `npx t3` (the server from Terminal, no `.app`) was killed too, so the trigger
  is in the **server's startup behaviour**, not the app bundle's signature.
- It must be the **desktop app**.

## What ViewCode does at startup today (no user action)

From a full trace of the source (`file:line` are current at `0a6fb7d46`).

| Spawn                                                               | Where                                                                                            | Notes                                                                                                          |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `$SHELL -ilc …` (desktop)                                           | `apps/desktop/src/shell/DesktopShellEnvironment.ts:310-321`                                      | Interactive login shell; `.zshrc` spawns more (nvm, starship)                                                  |
| `$SHELL -ilc …` (server, again)                                     | `apps/server/src/os-jank.ts:20-37` → `packages/shared/src/shell.ts:291-303`                      | Synchronous; duplicates the desktop's work                                                                     |
| `t3-resource-monitor` native sidecar                                | `apps/server/src/resourceTelemetry/NativeTelemetryClient.ts:568-600`                             | Unconditional; supervisor restarts it                                                                          |
| `scutil --get ComputerName`                                         | `apps/server/src/environment/ServerEnvironmentLabel.ts:158`                                      | System discovery                                                                                               |
| `ioreg -rd1 -n product`, `sysctl -n hw.model`                       | `apps/server/src/environment/ServerEnvironmentMachine.ts:136,143`                                | Hardware discovery                                                                                             |
| `codex app-server`                                                  | `CodexDriver.ts:182` → `CodexProvider.ts:561-613`                                                | **Codex is enabled by default** (`packages/contracts/src/settings.ts:574`)                                     |
| `claude --version`, then SDK `claude --output-format stream-json …` | `ClaudeProvider.ts:461`, `332-402`                                                               | Enabled by default                                                                                             |
| `cursor-agent about`, `cursor-agent acp`                            | `CursorProvider.ts:1131`, `497-518`                                                              | Off by default                                                                                                 |
| `grok --version/models/inspect/agent stdio`                         | `GrokProvider.ts:394-499`                                                                        | Off by default, but `restoreUsedProviders` (`serverSettings.ts:279-331`) re-enables it if history ever used it |
| `opencode --version`, then `opencode serve` (binds a TCP port)      | `OpenCodeProvider.ts:444-523`                                                                    | Same re-enable path                                                                                            |
| `cmd --version/status/--list-models`                                | `CommandCodeProvider.ts:124-176`                                                                 | Auto-enabled when `cmd` is on PATH                                                                             |
| `brew --prefix`, `brew info`                                        | `providerMaintenance.ts:466-489`                                                                 | Only when a provider binary lives in a Homebrew keg; runs **even for disabled providers**                      |
| `git …`, `gh pr list/view`                                          | `ThreadPullRequestReactor.ts:350-365`, `ThreadSettlementReactor.ts`, `PullRequestSyncReactor.ts` | Every minute for threads with branches                                                                         |

How the provider probes start: every driver's `create` forks
`applySnapshot(…, { forceRefresh: true })` immediately
(`apps/server/src/provider/makeManagedServerProvider.ts:281-284`). There is no
global limit, so all enabled probes start together during layer construction.
**No driver checks that the binary exists first**: "not installed" is learned
only from `spawn` failing with ENOENT (`resolveSpawnCommand`,
`packages/shared/src/shell.ts:628-636`, does no lookup on macOS/Linux).

## Result from the laptop (2026-09-26)

The experiment ladder ([`managed-mac-experiments.md`](managed-mac-experiments.md))
ran `npx t3 serve` three times with Codex, OpenCode, Grok and Antigravity
**off**: no providers, Claude only, Claude + Cursor. **All three survived 180s**
with the port listening. The login shell, `scutil`, `ioreg`, the
`t3-resource-monitor` sidecar, both Claude launches, and Cursor's probe
(including its `security find-generic-password` keychain reads and a
`npx typescript-language-server` it starts) all ran without a kill.

**Caveat (found later):** an agent harness can kill background processes it
started when its tool call returns, which looks exactly like an EDR kill (no
shutdown log). The earlier report that `npx t3` "also dies" may have been that
artifact. The desktop-app kills are real (Terminate alerts name the app). So
what is established: with those providers off the server survives; the proof
that a provider launch is the trigger still needs round 2 run fully detached.

So assumptions 2 and 3 below are **ruled out** on this machine, and the
trigger is one of the providers that were off: `codex app-server` and
`opencode` (both installed via npm under nvm there; `opencode` is ad-hoc
signed) or the attempt to run the missing `grok`. Which one is still
unknown (optional round 2 in the experiments doc).

**Working setup today:** `./build.sh --managed` writes these provider settings
into the desktop app's `settings.json` before launching. M1 (allow-list) and M2
(don't exec missing binaries) are now the items that matter; M5–M7 are
nice-to-haves, no longer needed to survive.

## Desktop app result (2026-09-26, later)

The locally built DMG app (ad-hoc signed, publisher blank) was **terminated**
by Behavioral Threat Protection a few seconds after launch; the alert's source
process is the app's main binary. No crash report was written (external kill).
That run used a fresh `~/.viewcode`, i.e. **default settings with Codex on**,
while the surviving `npx t3` runs had Codex/OpenCode/Grok off. Two variables
changed at once (unsigned app bundle, and blocked providers on).
**Round 3 answered it: the same unsigned app with those providers off
survived.** The provider gate is the fix; the items below are optional
hardening, not required to survive. Round 3 in
[`managed-mac-experiments.md`](managed-mac-experiments.md) runs the same DMG
with those providers off to separate them.

Consequences for the plan:

- **Phase 1 (the provider gate) stays first.** It removes the blocked
  providers from startup regardless, and it's what makes Round 3's setup the
  default.
- **Phase 2, the desktop startup diet, is optional** (lower priority after
  Round 3). Each item
  removes work the app doesn't need at startup and is justified on its own
  (latency, least privilege), whether or not it matters to the EDR:
  1. One PATH resolution for the whole app: the desktop resolves it once and
     hands it to the backend (today both run `$SHELL -ilc`), and without an
     interactive shell (`-lc` or in-process candidate dirs; M7).
  2. No hardware/host lookups at boot: `os.hostname()` instead of `scutil`,
     no `ioreg`/`sysctl` until something needs them (M5).
  3. The `t3-resource-monitor` sidecar starts on demand (when diagnostics are
     opened), not at boot (M6).
     Keychain reads during the Cursor probe are `cursor-agent`'s own behaviour
     (it does the same from Terminal); ViewCode can only avoid probing Cursor
     until it's chosen, which Phase 1 does.
- **Signing** (Developer ID + notarization; the repo supports it via
  `scripts/sign-macos.ts`) needs an Apple Developer account, not code. It
  improves provenance but no change guarantees a policy accepts the app.
- Nothing here hides behaviour from the EDR; every item does less, or does it
  later, openly.

## Claude on company Macs with Claude Code enterprise policy

Found on the laptop: Settings → Providers shows Claude "Needs attention ·
Could not verify Claude authentication status" although `claude auth status`
is fine. Cause: the machine has `/Library/Application Support/ClaudeCode/
managed-mcp.json` (and `managed-settings.json` with `allowManagedHooksOnly`),
and Claude Code refuses to start with `--strict-mcp-config` when an
enterprise MCP config is present ("You cannot use --strict-mcp-config when an
enterprise MCP config is present").

- Affected: the capability probe (`buildClaudeCapabilitiesProbeQueryOptions`,
  `ClaudeProvider.ts`, `strictMcpConfig: true`) and thread-title/text
  generation (`ClaudeTextGeneration.ts`, `--strict-mcp-config`). Sessions
  (`ClaudeAdapter.ts`) don't pass it, so threads should still start; confirm
  on the laptop.
- Fix: when the managed MCP file exists (macOS `/Library/Application
Support/ClaudeCode/managed-mcp.json`, Linux `/etc/claude-code/managed-mcp.json`,
  Windows `C:\Program Files\ClaudeCode\managed-mcp.json`), omit the strict
  flag (keep the empty `mcpServers` and `ENABLE_CLAUDEAI_MCP_SERVERS=false`);
  surface the probe's error text instead of `orElseSucceed(() => undefined)`;
  fall back to `claude auth status` for the account display when the probe
  fails. Check whether `--settings {"disableAllHooks":true}` collides with
  `allowManagedHooksOnly` next.
- Open: with an enterprise MCP config, Claude may ignore the MCP server
  ViewCode passes to sessions (the agents toolkit), so child agents / agent
  messaging under Claude may not work on such machines. Test on the laptop.

## Decided design: choose agents before anything is launched

Agreed with the user on 2026-09-26, then corrected after a code review (Astra).
This is the main fix; it supersedes M1.

**What the user sees.** ViewCode opens and lists the providers it supports,
all off, each with "Found at `<path>`" or "Not installed" (a disk check, nothing
run). The user clicks the ones they use and continues ("Enable 2 agents", or
"Continue without agents"). Only then does ViewCode check those providers, and
if one is already signed in (Claude Code, Cursor), it's picked up exactly as
today. Turning on a provider the machine blocks is the user's call.

**Rules**

1. **Nothing runs until a choice is made.** While the selection is pending,
   every provider instance is effectively off: no boot probe, interval,
   refresh, session, recovery, text generation, workspace scan or sign-in.
2. **The pending state is saved explicitly** (`providerSelection:
"pending" | "chosen"`; absent = legacy = chosen) and decided once, before
   providers are built, on first boot of this version, from the raw settings:
   - brand-new home, unreadable settings, or an old home with no projects and
     no explicit provider choices → `pending` (the user chose "show the picker
     again" for that ambiguous case);
   - an old home with projects/threads, explicit `providers.*.enabled`, or any
     `providerInstances` entry → `chosen`, behaving as today.
     Pending survives restarts, even if projects get created meanwhile.
3. **A choice writes every effective instance**: instances of chosen drivers on
   (all accounts of that driver), all others explicitly off, selection
   `chosen`, in one settings write. It is an initial-choice operation: a second
   stale screen can't overwrite it. Flipping a switch in Settings while pending
   counts as the first choice (that one on, the rest off).
4. **Turning a provider off stops it immediately** (user's decision) and nothing
   relaunches it (recovery, queued work).
5. **Never run a provider whose binary can't be found**, checked right before
   every execution with the instance's PATH / custom path (Antigravity uses its
   own install resolver), and run the resolved path.
6. **A copied profile keeps its choices** (user's decision).
7. `./build.sh --managed` writes the Claude + Cursor choice (instance level,
   selection `chosen`) for laptops set up from source.

**Implementation**

| Piece                                                                                                                                 | Where                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Selection state, one-time migration from raw settings                                                                                 | new `apps/server/src/provider/providerSelection.ts`; `packages/contracts/src/settings.ts` (optional field)                                                                                                                                                                                                                                                                                         |
| Gate applied when deriving the effective instance map (so reconciliation reacts to it)                                                | `ProviderInstanceRegistryHydration.ts` (`deriveProviderInstanceConfigMap`)                                                                                                                                                                                                                                                                                                                         |
| Launch guard (effective-enabled + binary resolves) at every execution path                                                            | health checks (each driver's `checkProvider`); `ProviderService.ts` recovery (~1239; new sessions ~1431 already check); `textGeneration/TextGeneration.ts:118`, `CodexTextGeneration.ts:196`; `ProviderRegistry.ts:844` / `CodexDriver.ts:243` (workspace); `ProviderAuthService.ts:18` (Antigravity, via `AntigravityInstallation.ts:404`); maintenance enrichment skipped for disabled instances |
| `detect` (filesystem only) and `choose` (initial-choice) RPCs                                                                         | contracts + `apps/server/src/ws.ts`, reusing the settings mutation (`serverSettings.ts` ~986)                                                                                                                                                                                                                                                                                                      |
| Onboarding picker, per environment, named ("Agents on Work Mac"), with "Check again" (filesystem only, bypasses the 30s lookup cache) | new `onboarding/ProviderChoiceStep.tsx` in `AgentsStep`; must not call `refreshProviders` before the choice                                                                                                                                                                                                                                                                                        |
| Clients that reach a pending server some other way (remote browser, phone)                                                            | banner "Choose which agents ViewCode may run on <computer>" → Settings → Providers                                                                                                                                                                                                                                                                                                                 |
| Status wording after the choice                                                                                                       | "Found · Not started" → "Checking" → "Ready" / "Sign-in needed" / "Couldn't start", with last-checked time; "stopped unexpectedly" + "Turn off", never claiming the cause                                                                                                                                                                                                                          |
| Backend crash loop                                                                                                                    | cap desktop backend restarts after abrupt exits (`DesktopBackendManager.ts:994`); title generation stops retrying after abrupt kills (`ProviderCommandReactor.ts:1128`)                                                                                                                                                                                                                            |
| Built-in spawn trace                                                                                                                  | `<stateDir>/logs/spawn-trace.log`: time, executable, instance/purpose, exit result; no prompt payloads; size-capped                                                                                                                                                                                                                                                                                |

**Tests:** fresh home launches nothing; pending survives a restart with
projects created; malformed settings → pending; explicit `providerInstances`
respected by migration and choice; interval/manual/workspace refresh and text
generation launch nothing while pending or for a disabled provider; a stale
second `choose` is rejected; a Settings toggle while pending closes the
selection with the rest off; a missing binary is never spawned.

Phase 2 (desktop startup diet: M7, M5, M6) follows; see "Desktop app result" above. M4 (cache seeding) stays deferred.

### Installers (DMG, EXE, AppImage) get the same protection

The user's requirement: the packaged app must be safe on its own, not only
when launched through `build.sh`. The gate above lives in server code, so it
ships in every artifact from `pnpm dist:desktop:dmg` / `:win` / `:linux`: a
fresh install shows the picker with everything off and launches no provider
until Continue. Nothing about it may depend on `build.sh`, environment
variables or a source checkout.

- **Spawn trace must be built in (M11).** Whether a packaged app honours
  `NODE_OPTIONS` depends on its Electron fuses (the backend runs Electron with
  `ELECTRON_RUN_AS_NODE=1`, `DesktopBackendConfiguration.ts:574`); inspect the
  artifact, don't change fuses. Rely on the built-in trace, and add a desktop
  "Open logs" action that works while the server is down. Verify installers with M11's
  `<userdata>/logs/spawn-trace.log`.
- **Installing without admin on macOS:** `/Applications` usually needs admin;
  drag the app to `~/Applications` instead (ordinary user-owned location).
  Don't strip security metadata such as the quarantine attribute to get past
  an execution check. A build made on the same machine isn't quarantined; if
  normal opening of a copied build is blocked, report it. Developer ID signing
  - notarization improve provenance but don't guarantee company policy
    accepts the app.
- **Acceptance for an installer build:** on a clean profile
  (`~/.viewcode` absent), install from the DMG, launch, stop at the Agents
  step, and check `spawn-trace.log` shows no provider CLI; choose Claude +
  Cursor, Continue, and see only `claude` and `cursor-agent` spawn.
- A `--managed` equivalent for installers is not needed: the picker is the
  managed path. If one is wanted later, read the same provider set from a
  file dropped next to the settings (not a build-time flag).

## Assumptions, most likely first

1. **Executing blocked or unknown provider binaries** (`codex app-server`,
   `opencode`, a missing `grok`) is what gets scored. This fits the 27ms timing
   and the fact that the user's working CLIs (`claude`, `cursor-agent`) are
   exactly the ones the policy allows.
2. **The combination** of a node process running system discovery (`ioreg`,
   `scutil`, `sysctl`), two interactive shells and several CLIs within ~4s
   matches a generic "discovery burst" behaviour rule, even if no single step
   is flagged.
3. **The `t3-resource-monitor` native sidecar**, an unfamiliar native binary
   launched unconditionally, is flagged on its own.

Managed mode addresses all three at once. The diagnosis ladder (below) tells
which one it was.

## Managed mode

One switch that turns on every item below: environment variable
`VIEWCODE_MANAGED=1`, read by desktop and server, passed from desktop to the
backend child it spawns (check `backend/DesktopBackendManager.ts` forwards the
environment). `build.sh --managed` sets it. Later it can become a setting.

| #   | Change                                                                                                                                                                                                                                                                                                                                                                                                      | Where                                                                                                                                                                      | Done when                                                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| M1  | **Allow-list providers.** In managed mode a provider is enabled only if listed in `VIEWCODE_PROVIDERS` (default `claudeAgent,cursor`). Codex default-on and `restoreUsedProviders` auto-enable don't apply                                                                                                                                                                                                  | `serverSettings.ts:619-680`, `ProviderInstanceRegistryLive.ts:104-110` (`resolveEntryEnabled`)                                                                             | With `VIEWCODE_MANAGED=1`, no `codex`, `grok`, `opencode` or `cmd` process is ever started (assert in a test with a spawn spy) |
| M2  | **Check the binary exists before exec** (all modes, not just managed). Resolve with `resolveCommandPath` (`shell.ts:618`, filesystem only) or the configured `binaryPath`; if absent, return an `installed: false` snapshot without spawning                                                                                                                                                                | each driver's `checkProvider`: `CodexDriver.ts:182`, `ClaudeDriver.ts:199`, `GrokDriver.ts:133`, `OpenCodeDriver.ts:152`, `CursorDriver.ts:138`, `CommandCodeDriver.ts:56` | Test: provider with a missing binary reports not installed and spawn is never called                                           |
| M3  | **No probes until a window is connected, then one at a time.** Replace the forced boot probe with "on first `provider-status` demand"; wrap `applySnapshot` in a process-wide semaphore of 1 (2 outside managed mode) with ~500ms between probes in managed mode                                                                                                                                            | `makeManagedServerProvider.ts:281-284` and `178-179`; also bound `ProviderRegistry.ts:570-573` (`refreshAll`)                                                              | Boot log shows probes start after the window connects and never overlap                                                        |
| M4  | **Seed provider status from cache** so the UI shows models before any probe; stop the pending snapshot overwriting the cache                                                                                                                                                                                                                                                                                | `ProviderRegistry.ts:314-375`, `783`; `makeManagedServerProvider.ts:70-74` initial snapshot                                                                                | Second launch shows Claude's models immediately                                                                                |
| M5  | **No system discovery execs.** Use `os.hostname()` for the label; skip `ioreg`/`sysctl` (model can be "Mac")                                                                                                                                                                                                                                                                                                | `ServerEnvironmentLabel.ts:158`, `ServerEnvironmentMachine.ts:136,143`                                                                                                     | No `scutil`, `ioreg`, `sysctl` spawns in managed mode                                                                          |
| M6  | **No resource-monitor sidecar**                                                                                                                                                                                                                                                                                                                                                                             | `NativeTelemetryClient.ts`, `server.ts:198,226-231` (`ResourceDiagnosticsLayerLive`)                                                                                       | Sidecar never spawned; diagnostics page says "off in managed mode"                                                             |
| M7  | **PATH without interactive shells.** Desktop resolves PATH once, in-process (candidate dirs: `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/.bun/bin`, `~/.cargo/bin`, `~/.volta/bin`, `~/.nvm/versions/node/*/bin` newest first, system dirs), passes it to the server; server skips `hydratePosixPath` when told PATH is already resolved. If a shell is still wanted, use `-lc`, never `-ilc` | `DesktopShellEnvironment.ts`, `os-jank.ts`, `shell.ts`                                                                                                                     | No `zsh` process at startup in managed mode; `claude` and `cursor-agent` (both in `~/.local/bin`) still found                  |
| M8  | **No brew enrichment for disabled providers** (all modes), none at all in managed mode                                                                                                                                                                                                                                                                                                                      | `providerMaintenance.ts:560-615`                                                                                                                                           | No `brew` spawn                                                                                                                |
| M9  | **No background git/gh polling in the first minute**, and none for `gh` if `gh` isn't installed                                                                                                                                                                                                                                                                                                             | `ThreadPullRequestReactor.ts`, `ThreadSettlementReactor.ts`, `PullRequestSyncReactor.ts`                                                                                   | No `git`/`gh` spawns during startup                                                                                            |
| M10 | **Telemetry identity never reads credential files** (all modes)                                                                                                                                                                                                                                                                                                                                             | `apps/server/src/telemetry/Identify.ts`, `AnalyticsService.ts:88`                                                                                                          | With telemetry off, nothing under `~/.codex`/`~/.claude*` is opened for identity                                               |
| M11 | **Spawn trace log** (all modes): before every child process, append one line (time, command, args, parent) to `<userdata>/logs/spawn-trace.log` with a synchronous write, so the last line survives a SIGKILL                                                                                                                                                                                               | central spawn helpers (`processRunner.ts`, `providerSnapshot.ts:85` `spawnAndCollect`, `DesktopShellEnvironment.ts`, `DesktopBackendManager.ts`)                           | Killing the app mid-boot leaves the last spawn in the log                                                                      |

Out of scope: signing/notarization, entitlements (not the trigger: `npx t3`
died too), UI for managed mode.

### Suggested order

M11 first (so every later test is diagnosable), then M1 + M2 + M3 (the most
likely trigger), then M5 + M6 + M7, then the rest. Each is one small PR with a
focused test. Server behaviour changes need tests per `AGENTS.md`.

## Settings for the laptop (works today, before any code change)

`~/.viewcode/userdata/settings.json` (create before first launch; merge if it
exists). Codex is **on by default**, so it must be turned off explicitly:

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

Also start a fresh `~/.viewcode` (don't copy `~/.t3` history in), so
`restoreUsedProviders` has nothing to re-enable. This alone removes the
`codex`, `opencode` and `grok` spawns and may be enough to survive; it's the
first thing to try on the laptop.

## Experiments you can run today

[`managed-mac-experiments.md`](managed-mac-experiments.md) has a paste-ready
prompt for the laptop's own agent: it traces every spawn of the published
`npx t3` server (`scripts/diagnostics/spawn-trace.cjs`, no code change) while
switching providers off and on. Its results decide which M-items matter most.

## Diagnosis ladder (on the laptop, after M11 lands)

Run each step; stop at the first that dies and send back the last lines of
`~/.viewcode/userdata/logs/spawn-trace.log` and `server-child.log`.

1. `VIEWCODE_MANAGED=1 VIEWCODE_PROVIDERS= ./build.sh`: no providers at all.
   If this dies, the cause is not a provider (look at the last spawn: shell,
   sidecar, discovery).
2. `VIEWCODE_PROVIDERS=claudeAgent`: add Claude.
3. `VIEWCODE_PROVIDERS=claudeAgent,cursor`: add Cursor. Target state.
4. Only if 3 survives: turn managed-mode items back on one at a time (e.g.
   allow the sidecar) to learn which one mattered, then keep the rest off.

If step 1 dies with nothing spawned but the backend itself, the trigger is
Electron/node startup, and the only real fix is signing, notarization and an
exception. Stop there.

## Open questions for the user

- Is `cursor-agent` at `~/.local/bin/cursor-agent` and `claude` at
  `~/.local/bin/claude`, as in the field notes? (M7's candidate list relies on
  it.)
- Were `codex` and `opencode` ever installed on the laptop before the blocks
  started? If present-but-blocked, M1 matters more than M2.
