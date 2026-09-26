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

So assumptions 2 and 3 below are **ruled out** on this machine, and the
trigger is one of the providers that were off: `codex app-server` and
`opencode` (both installed via npm under nvm there; `opencode` is ad-hoc
signed) or the attempt to run the missing `grok`. Which one is still
unknown (optional round 2 in the experiments doc).

**Working setup today:** `./build.sh --managed` writes these provider settings
into the desktop app's `settings.json` before launching. M1 (allow-list) and M2
(don't exec missing binaries) are now the items that matter; M5–M7 are
nice-to-haves, no longer needed to survive.

## Decided design: choose agents before anything is launched

Agreed with the user on 2026-09-26. This is the main fix; it supersedes M1.

**Behaviour**

1. **Fresh install: nothing is launched.** The server starts with every
   provider in a "not chosen yet" state and probes none of them.
2. **Onboarding's Agents step asks.** It lists every provider (Claude Code,
   Codex, Cursor, OpenCode, Grok, Antigravity, Command Code), **all switched
   off**, each showing "Found at `<path>`" or "Not installed" from a
   filesystem check only (no exec).
3. **Continue saves the choice**: chosen providers `enabled: true`, all others
   `enabled: false`, then only the chosen ones are probed. The existing
   login/install cards appear after that, for chosen providers only.
4. **Existing installs keep their choices**: if the environment already has
   threads/projects or `settings.json` has explicit `providers.*.enabled`
   values, it is marked chosen on first boot of the new version and behaves
   as today.
5. **Later changes** go through Settings → Providers (switch on = probe now).
   Turning on a blocked provider is the user's choice.
6. **Always (all installs):** never exec a provider whose binary can't be
   found (M2).
7. `./build.sh --managed` stays: it writes the Claude + Cursor choice and marks
   the selection made, so a laptop can skip clicking through.

**Implementation**

| Piece                                                                                                                                                             | Where                                                                                                                                                                               | Notes                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `providersChosenAt: string \| null` server setting (optional, default null)                                                                                       | `packages/contracts/src/settings.ts` (ServerSettings + patch)                                                                                                                       | Server-side, **not** the client `onboardingCompletedAt` (that's per browser; a phone or second browser must not bypass the gate)                                                                                                                                                           |
| Gate: while `providersChosenAt` is null, treat every provider as not enabled for probing (no boot probe, no interval, no `refreshAll`)                            | new `apps/server/src/provider/providerSelection.ts`, used by `resolveEntryEnabled` (`ProviderInstanceRegistryLive.ts:104-110`) and `restoreUsedProviders` (`serverSettings.ts:279`) | Keep upstream defaults (Codex default-on) untouched in the schema; the gate sits in front, so upstream merges stay clean                                                                                                                                                                   |
| Migration for existing installs                                                                                                                                   | same file, at settings load (`serverSettings.ts:619-680`)                                                                                                                           | Existing = any project/thread in the state DB, or explicit `providers.*.enabled` in `settings.json` → set `providersChosenAt = now`                                                                                                                                                        |
| `providers.detect` RPC: `[{ driver, installed, path }]` via `resolveCommandPath` (`packages/shared/src/shell.ts:618`) or configured `binaryPath`; filesystem only | `packages/contracts` (RPC schema), `apps/server/src/ws.ts`                                                                                                                          | Never spawns                                                                                                                                                                                                                                                                               |
| `providers.choose({ enabled: DriverKind[] })` RPC: writes `providers.*.enabled` for **all** drivers and `providersChosenAt`, then probes the chosen ones          | same                                                                                                                                                                                | One atomic settings write                                                                                                                                                                                                                                                                  |
| Onboarding picker                                                                                                                                                 | new `apps/web/src/components/onboarding/ProviderChoiceStep.tsx`, rendered by `AgentsStep` (`WelcomeWizard.tsx:626`) while `providersChosenAt` is null                               | Must **not** call `refreshProviders` before the choice (today `ConnectedAgentsStep` does on mount, `WelcomeWizard.tsx:675-678`, which would probe everything). After the choice, show the existing cards for chosen drivers (today only `PRIMARY_AGENT_DRIVERS = ["claudeAgent","codex"]`) |
| Skipped onboarding / other clients                                                                                                                                | web: a banner "Choose your agents" linking to Settings → Providers when `providersChosenAt` is null; Settings → Providers switches also set `providersChosenAt`                     | Mobile: shows no providers until chosen; add the banner later                                                                                                                                                                                                                              |
| `--managed` also sets `providersChosenAt`                                                                                                                         | `build.sh`                                                                                                                                                                          | Only once the field exists (unknown keys may be dropped)                                                                                                                                                                                                                                   |
| M2: resolve binary before exec                                                                                                                                    | each driver's `checkProvider` (listed in M2 below)                                                                                                                                  | Independent; do first                                                                                                                                                                                                                                                                      |

**Tests (server behaviour changes need them):** fresh environment boots with
zero provider spawns (spawn spy); `providers.choose(["claudeAgent"])` probes
only Claude; an existing environment keeps its enabled set and gets
`providersChosenAt`; `providers.detect` never spawns; a missing binary is
reported not installed without a spawn.

**Order:** M2 → server gate + migration + RPCs (with tests) → onboarding picker
→ banner → `--managed` update. Verify on the laptop with the spawn tracer:
first launch shows no provider spawns until Continue.

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
