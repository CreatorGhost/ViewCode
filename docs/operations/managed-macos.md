# Running ViewCode on a managed (EDR-protected) Mac

Field report from a locked-down company laptop, checked against ViewCode's
source. Specifics that identify the machine, user or tenant (names, prevention
IDs) are deliberately left out; keep it that way, this repository is public.

Environment it was measured on: macOS 26, Cortex XDR (Behavioral Threat
Protection), CyberArk EPM, standard (non-admin) account, TLS interception on
the corporate network. The measurements were made on upstream T3 Code at
`ed809f7ad`, which is exactly ViewCode's fork point, so file references match.

## TL;DR

- The packaged T3 Code app was **killed by Cortex XDR ~4.5s into launch**. The
  kill lands **27ms after the app spawns every provider CLI at once** (codex,
  opencode, claude). Best-fit explanation: one spawned CLI is flagged and
  Cortex kills the causal parent (every alert names the app binary). **Not
  proven**: no positive control was ever reproduced.
- Disproved as triggers (don't retry): the login-shell probe, the telemetry
  read-and-POST, the entitlements, GUI/launchd parentage.
- A ViewCode build from `./build.sh` is **ad-hoc signed** (the launcher copies
  Electron and re-signs it with `codesign --sign -`) under a never-seen name.
  Expect it to be treated at least as harshly as the notarized T3 Code release.
- **Never try to evade the EDR** (obfuscation, renaming binaries to dodge
  rules, poking at the agent's helpers or policy DB). If a legitimate behaviour
  trips a rule, get the rule name and an exception from IT.

## What ViewCode does at startup (verified in this repo)

| Behaviour                                                                                            | Where                                                                                                                                                                                  | ViewCode status                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interactive login shell (`$SHELL -ilc`) to read `PATH`, run twice per launch (desktop main + server) | `packages/shared/src/shell.ts` (`-ilc`), `apps/server/src/os-jank.ts` (`hydratePosixPath`), desktop `app/DesktopApp.ts`                                                                | Same as upstream. ~1s each on the critical path. Not the EDR trigger                                                                                                                                                                                          |
| Every provider probed concurrently                                                                   | `apps/server/src/provider/Layers/ProviderRegistry.ts` (`loadProviders`, `concurrency: "unbounded"`); more in `providerSnapshot.ts`, `providerMaintenanceRunner.ts`, `CodexProvider.ts` | Same, **plus one more CLI**: Command Code (`cmd`)                                                                                                                                                                                                             |
| Providers that aren't installed are still exec'd                                                     | per-driver health checks                                                                                                                                                               | Same (e.g. `grok` probed when absent)                                                                                                                                                                                                                         |
| Turning a provider off                                                                               | Settings → Providers → switch on each card (`ProviderInstanceCard.tsx`, writes `instance.enabled`; server `resolveEntryEnabled` makes an explicit `false` win)                         | **Correction to the field notes:** a UI switch exists. The per-driver `enabled` field is hidden only because the card switch replaces it. Gap: all providers default to on, so the **first** launch probes everything before the user can switch anything off |
| TCP listener on `127.0.0.1:3773`                                                                     | server                                                                                                                                                                                 | **Not in ViewCode desktop by default**: it listens on a Unix socket (`socketListener.ts`). Only with Settings → Connections → Network access on, or `./build.sh --web`                                                                                        |
| Telemetry                                                                                            | `apps/server/src/telemetry/AnalyticsService.ts`                                                                                                                                        | **Off by default in ViewCode.** But `getTelemetryIdentifier` still runs at service construction regardless, reading `~/.codex/auth.json` and `~/.claude.json` to hash an id (`Identify.ts`). Credential files are read even with telemetry off                |
| Entitlements                                                                                         | `apps/desktop` packaging, `apps/server/resources/cli-entitlements.plist`                                                                                                               | Not re-checked here. Upstream grants `allow-unsigned-executable-memory`, `disable-library-validation` (app) and more for the CLI; only `allow-jit` is known to be required                                                                                    |
| Signing                                                                                              | `apps/desktop/scripts/electron-launcher.mjs` (`codesign --force --deep --sign -`)                                                                                                      | Source-tree launches are ad-hoc signed; `dist:desktop:*` builds are unsigned                                                                                                                                                                                  |

## Work items (in priority order)

Each is independently justified, whether or not the EDR hypothesis holds.

1. **Don't exec CLIs that aren't installed.** Resolve the binary on `PATH` (or
   the configured `binaryPath`) with a filesystem check before any health-check
   exec; report "not installed" without spawning.
   _Done when:_ a provider whose binary is absent is reported not installed and
   no process is spawned (test with a fake `PATH`).
2. **Bound provider probe concurrency** (e.g. 2) in `loadProviders` and the
   other `concurrency: "unbounded"` probe sites.
   _Done when:_ no more than 2 provider CLIs run at once during boot.
3. **First launch probes nothing the user didn't choose.** Options, smallest
   first: (a) document the `settings.json` below for managed machines;
   (b) default only installed providers to enabled; (c) let onboarding's
   Agents step pick providers before the first probe.
   _Done when:_ a fresh install with providers switched off in `settings.json`
   spawns none of them (check with `ps` during launch).
4. **Telemetry identity:** skip `getTelemetryIdentifier` when telemetry is
   disabled, and replace credential-file sources with a random id stored in
   state. _Done when:_ with telemetry off, no file under `~/.codex` or
   `~/.claude*` is opened at startup.
5. **PATH without an interactive shell:** use `-lc` instead of `-ilc` (no
   `.zshrc` fan-out), or resolve in-process from candidate dirs:
   `/opt/homebrew/bin`, `/opt/homebrew/sbin`, `/usr/local/bin`, `~/.local/bin`,
   `~/.bun/bin`, `~/.cargo/bin`, `~/.volta/bin`, every
   `~/.nvm/versions/node/*/bin` newest first, then the system dirs. Let the
   desktop pass its result to the server instead of probing twice.
   (`launchctl getenv PATH` is empty on typical machines; don't rely on it.)
6. **Corporate TLS:** start the server child with `--use-system-ca` (Node 24)
   or honour `NODE_EXTRA_CA_CERTS`. `build.sh` already exports
   `NODE_OPTIONS=--use-system-ca` for installs.
7. **Trim entitlements** to what's required (`allow-jit`).
8. **Developer ID signing + notarization** before distributing builds to
   managed machines; ad-hoc builds carry no reputation.

Items 1 to 3 go upstream as one issue ("managed machines need a way to stop
provider probes"), item 4 as a separate one. Keep machine specifics out.

## Getting ViewCode running on the managed Mac (runbook for the local agent)

Stop and hand back to the user at any step that needs admin rights, a policy
exception, or touches the EDR.

1. **Ask IT first** for the Behavioral Threat Protection rule that terminated
   T3 Code and an exception for the ViewCode app/bundle. This is the one fact
   that ends the guessing. The Cortex XDR app's alert "Details" disclosure shows
   the source PID and command line without admin.
2. **Pre-disable providers you won't use** before the first launch. The
   desktop app reads `~/.viewcode/userdata/settings.json`; create it if absent
   (merge if present) with, for example:

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
     }
   }
   ```

   Keys: `codex`, `claudeAgent`, `cursor`, `grok`, `opencode`, `antigravity`,
   `commandCode` (`providers` in `packages/contracts/src/settings.ts`). Leave
   on only what is installed and allowed; `opencode` is ad-hoc signed and the
   prime suspect.

3. **Build and run:** `git clone https://github.com/CreatorGhost/ViewCode.git && cd ViewCode && ./build.sh`.
   It fetches a private Node 24 (curl uses the system keychain, so TLS
   inspection is fine) and exports `--use-system-ca` for the install. No
   `sudo` is needed.
4. **If the app dies within seconds:** read
   `~/.viewcode/userdata/logs/server-child.log` (the last lines show which
   provider was being probed), note the time, and check the Cortex XDR app for
   an alert. An EDR `SIGKILL` leaves no crash report; that absence is itself
   the signal. Report to the user; don't work around it.
5. **Positive control (the missing experiment),** only with the user's go-ahead:
   run each CLI alone with a timeout and note which raises an alert:
   `timeout 15 codex --version`, `timeout 15 claude --version`,
   `timeout 15 cursor-agent --version`, `timeout 15 cmd --version`.
   **Never** run `opencode --version` without a timeout: it opens a TUI and
   hung for minutes, taking the terminal session with it.
6. `./build.sh --web` runs the server from the terminal and the UI in a
   browser, a legitimate mode that is useful as a data point. It still spawns
   provider CLIs; if Cortex flags it too, stop and go back to step 1.

## Building the installer on the managed Mac

Verified on the laptop (arm64, no admin): an unsigned DMG builds in ~80s with

```bash
export NODE_OPTIONS="--use-system-ca"      # Electron/dmg tool downloads go through TLS inspection
export CSC_IDENTITY_AUTO_DISCOVERY=false   # no signing identity on this machine
pnpm dist:desktop:dmg:arm64                # output in release/
```

- SPDX license texts are now vendored in `.generated/third-party-licenses/`, so
  the web bundle no longer needs `raw.githubusercontent.com`. A new dependency
  with a new license id still downloads once; commit the new cache file.
- electron-builder downloads Electron, 7zip and dmgbuild on the first build
  (`~/Library/Caches/electron-builder`), so the first build needs HTTPS with
  the system CA.
- Only the host arch works without rustup (Homebrew cargo has no cross
  targets); build `arm64` on Apple Silicon.
- The result is ad-hoc signed. It runs where it was built (no quarantine). A
  copy that is downloaded or sent gets quarantined; see "Installers" in
  `managed-mode-plan.md`. Sharing builds with colleagues needs Developer ID +
  notarization (`scripts/sign-macos.ts`, `T3CODE_DESKTOP_SIGNED`).
- In a **main checkout** (not a worktree) `pnpm dev` uses the shared
  `~/.viewcode` home; the worktree `.t3` protection doesn't apply. Pass
  `--home-dir` when experimenting.

## Machine gotchas

- No `sudo`; the EPM tool blocks elevation. `eslogger`, `log show` and
  `cytool` need privileges you don't have. Don't plan around them.
- Node fails TLS with `SELF_SIGNED_CERT_IN_CHAIN`; `curl` works (keychain).
- `ps` output inflates shell counts: one `zsh -ilc` whose `.zshrc` runs command
  substitutions (nvm, starship) shows as up to 4 processes with the same argv.
- **Line not to cross:** don't inspect or call the EDR's own helper binaries to
  read its policy, even if one runs unprivileged. That is privilege escalation
  on an account that is non-admin by design.

## Method lessons from the investigation

- Demand a positive control; ten surviving probes are not a diagnosis.
- Match cardinality and context (a burst of several CLIs, not one), not just
  the command.
- Read the app's own `server-child.log` first; it held the timeline.
- A failed experiment (`fetch failed`) is inconclusive, not negative.
- Log unbuffered when the process may be killed.
