# Running ViewCode on a managed (EDR-protected) Mac

> **First-run provider gate.** A brand-new data folder (no `settings.json` and no
> provider ever used) writes every provider off, and the welcome screen asks
> which to turn on; finding CLIs there is a `PATH` lookup, never a run. Existing
> installs keep their providers. The Same Wi-Fi test runs when Connect phone
> opens; Tailscale runs only when a Tailscale feature is used (see below). The
> report further down is kept as a record; the current findings are next.

## October 2026 (v2): `tailscale` on every page load

The v2 server was killed on the first page load. Its `spawn-trace.log` showed
`tailscale status` spawned in the same second, and the same build with
`tailscale` short-circuited survived several minutes of chats and Settings. v1
never ran `tailscale`. The cause was upstream's "open in editor over Tailscale
SSH" (`b037b9a53`): every server config read (each page load) resolved SSH
routes with `tailscale status` and `tailscale debug prefs`, and the desktop app
ran `tailscale status` at every launch to turn Tailscale Serve on.

Now nothing runs `tailscale` at startup, on a config read or on page load:

- The server reaches the CLI only through `TailscaleAccess`
  (`apps/server/src/environment/TailscaleAccess.ts`), which caches each answer
  for 60 seconds. The config carries the last resolved SSH routes from memory;
  the web asks for fresh ones (`server.resolveRemoteOpenTargets`) only when the
  **Open in** menu opens on a remote environment. Tailscale Serve (`--tailscale-serve`,
  `pair --tailscale`) still runs it because the user asked for Serve.
- The desktop turns Serve on at launch only after the user turns on **Turn on
  Tailscale phone access at launch**, and lists Same Wi-Fi tailnet addresses
  from the network interfaces without the CLI.
- Off switch: **Settings → Connections → Tailscale** (`tailscaleEnabled` in
  `settings.json`, default on) or `VIEWCODE_DISABLE_TAILSCALE=1` in the
  environment, which outranks the setting. Either turns every Tailscale command
  into a no-op that reports "Tailscale is turned off". The one answer is
  `resolveTailscaleBlock` in `packages/tailscale` (the server's
  `TailscaleAccess.blockReason`, the desktop's `DesktopTailscaleGate`); an admin
  policy adds its reason there. The environment switch is also enforced where
  `packages/tailscale` spawns, so no caller can bypass it.

On a managed Mac where EDR kills `tailscaled`, set `"tailscaleEnabled": false`
in `userdata/settings.json` or export `VIEWCODE_DISABLE_TAILSCALE=1` before the
first launch.

## How to check on a managed Mac

1. Run the new build on a **copy** of real data, on a spare port.
2. Remove a copied `userdata/server-runtime.json`; v2 refuses to start if it
   names a live server.
3. Load the page, open Settings, and send one message.
4. Read `userdata/logs/spawn-trace.log`. It must show no `tailscale`. Only a
   Tailscale feature runs it: opening the **Open in** menu from a remote browser
   runs at most one `tailscale status` (plus `tailscale debug prefs` when no
   local sshd answers) a minute. With Tailscale turned off, nothing.

## October 2026: what Cortex XDR actually flags

Measured again on the same laptop with the server and a browser: it runs clean
once Codex is turned off. Two launches were flagged:

- **A provider's binary run while that provider is off.** `CodexInstallation`
  probed a local `codex` at boot whatever the setting; it now does so only while
  Codex is enabled.
- **The app's own Electron binary started with `ELECTRON_RUN_AS_NODE=1`**
  (MITRE T1218.015). That is how the desktop app ran its backend. On Apple
  Silicon the backend is now the standalone `t3` server instead: a packaged
  app ships it under `Resources/t3-server` (the release's macOS CLI archive,
  `--mac-server-runtime`), and `./build.sh` builds `apps/server/dist-exe/t3`
  and passes it as `T3CODE_DESKTOP_SERVER_EXECUTABLE`. Intel Macs keep the old
  backend because Node single-executables do not run there. Under `t3` the
  server's helpers (MCP bridge, computer use, Claude history) are subcommands
  of `t3`, not more Electron-as-Node launches. The snapshot accessibility
  reader (`SnapShotAccessibilityProcess`) still uses `ELECTRON_RUN_AS_NODE`,
  only when a snapshot is taken.

To check a build, read `userdata/logs/spawn-trace.log` (server) and
`userdata/logs/desktop.trace.ndjson` (desktop) right after startup: the backend
should be `.../t3 --bootstrap-fd 3`, and nothing should start a disabled
provider's binary.

A local DMG with the bundled server needs the macOS CLI archive first
(Node 25.7+ on PATH for `build-exe`, and `cargo` for the resource monitor):

```bash
node apps/server/scripts/cli.ts build-exe
cargo build --release --manifest-path native/resource-monitor/Cargo.toml --target aarch64-apple-darwin
mkdir -p /tmp/rm/darwin-arm64 && cp native/resource-monitor/target/aarch64-apple-darwin/release/t3-resource-monitor /tmp/rm/darwin-arm64/
node scripts/build-cli-archive.ts --platform mac --arch arm64 --version "$(node -p 'require("./apps/server/package.json").version')" --resource-monitor-dir /tmp/rm --output-dir release-cli
pnpm dist:desktop:dmg:arm64 --mac-server-runtime release-cli/t3-*-darwin-arm64.tar.gz
```

## Cursor runs as `cursor-agent` again (October 2026)

Measured on 19 October 2026 with the v2 server on a copy of real data: Cursor
sign-in through the SDK worked, and on the first message the **server process
itself** spawned the SDK's bundled `@cursor/sdk-darwin-arm64/bin/rg` twice in
parallel; the server was killed right after. That `rg` is properly signed
(Developer ID: Anysphere) and identical to the one inside `cursor-agent`, so
this is not a signature problem. The difference is the parent: v1 ran
Cursor's own signed `cursor-agent`, which runs `rg` and `cursorsandbox`
itself, and that runs clean daily; v2 ran Cursor in-process through
`@cursor/sdk`, so the generic `node` server ran them. Not proven at the rule
level (only IT's console names the rule), but timing and the v1/v2 difference
match.

Cursor now has a **Runtime** setting (Settings → Providers → Cursor):

- **Cursor CLI (`cursor-agent`)**: the server spawns `cursor-agent … acp` and
  nothing else for Cursor. It uses the CLI's own login (`cursor-agent login`).
- **Cursor SDK**: the in-process SDK, as before.
- **Automatic** (default): on macOS the CLI when `cursor-agent` is found on
  `PATH` (a lookup, never a run), otherwise the SDK.

So a managed Mac with `cursor-agent` installed needs no change; set the runtime
to the CLI explicitly to be sure, and set **Binary path** if `cursor-agent`
is not on the server's `PATH`. In `settings.json` that is
`"runtime": "cursor-agent"` in the Cursor instance's `config`.

**Check:** load the page, send one Cursor message, then read
`userdata/logs/spawn-trace.log`. Every Cursor line must name `cursor-agent`
with `provider=cursor` (an `about` health check, then the ACP sessions), and
there must be no `rg` and no `cursorsandbox` line: those now run under
`cursor-agent`, and the trace only records the server's own children. An `rg` or `cursorsandbox`
line means the instance is still on the SDK runtime.

Field report from a locked-down company laptop, checked against ViewCode's
source. Specifics that identify the machine, user or tenant (names, prevention
IDs) are deliberately left out; keep it that way, this repository is public.

Environment it was measured on: macOS 26, Cortex XDR (Behavioral Threat
Protection), CyberArk EPM, standard (non-admin) account, TLS interception on
the corporate network. The measurements were made on upstream T3 Code at
`ed809f7ad`, which is exactly ViewCode's fork point, so file references match.

## Findings and current guidance

- The packaged T3 Code app was **killed by Cortex XDR ~4.5s into launch**. The
  kill lands **27ms after the app spawns every provider CLI at once** (codex,
  opencode, claude). Best-fit explanation: one spawned CLI is flagged and
  Cortex kills the causal parent (every alert names the app binary). **Not
  proven** for an individual CLI. A later controlled run kept the same ad-hoc
  signed DMG alive for over eight minutes with the blocked providers off; see
  [round 3](managed-mac-experiments.md#round-3-result-2026-09-26-alive).
- Disproved as triggers (don't retry): the login-shell probe, the telemetry
  read-and-POST, the entitlements, GUI/launchd parentage.
- A ViewCode build from `./build.sh` is **ad-hoc signed** (the launcher copies
  Electron and re-signs it with `codesign --sign -`) under a never-seen name.
  The surviving round-3 run shows that ad-hoc signing alone did not trigger
  termination in that experiment. Signing and notarization still matter for
  distributing downloaded copies through Gatekeeper.
- **Never try to evade the EDR** (obfuscation, renaming binaries to dodge
  rules, poking at the agent's helpers or policy DB). If a legitimate behaviour
  trips a rule, get the rule name and an exception from IT.

## What ViewCode does at startup (verified in this repo)

| Behaviour                                                                                            | Where                                                                                                                                                                                  | ViewCode status                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interactive login shell (`$SHELL -ilc`) to read `PATH`, run twice per launch (desktop main + server) | `packages/shared/src/shell.ts` (`-ilc`), `apps/server/src/os-jank.ts` (`hydratePosixPath`), desktop `app/DesktopApp.ts`                                                                | Same as upstream. ~1s each on the critical path. Not the EDR trigger                                                                                                                                                                           |
| Every provider probed concurrently                                                                   | `apps/server/src/provider/Layers/ProviderRegistry.ts` (`loadProviders`, `concurrency: "unbounded"`); more in `providerSnapshot.ts`, `providerMaintenanceRunner.ts`, `CodexProvider.ts` | Only enabled instances; installed default-on providers are probed at boot, as upstream                                                                                                                                                         |
| Providers that aren't installed are still exec'd                                                     | per-driver health checks                                                                                                                                                               | The launch guard resolves the executable first and refuses to spawn a missing binary                                                                                                                                                           |
| Turning a provider off                                                                               | Settings → Providers → switch on each card (`ProviderInstanceCard.tsx`, writes `instance.enabled`; server `resolveEntryEnabled` makes an explicit `false` win)                         | The card switch controls each instance; `./build.sh --managed` writes the switches before first launch                                                                                                                                         |
| TCP listener on `127.0.0.1:3773`                                                                     | server                                                                                                                                                                                 | **Not in ViewCode desktop by default**: it listens on a Unix socket (`socketListener.ts`). Only with Settings → Connections → Network access on, or `./build.sh --web`                                                                         |
| Telemetry                                                                                            | `apps/server/src/telemetry/AnalyticsService.ts`                                                                                                                                        | **Off by default in ViewCode.** But `getTelemetryIdentifier` still runs at service construction regardless, reading `~/.codex/auth.json` and `~/.claude.json` to hash an id (`Identify.ts`). Credential files are read even with telemetry off |
| Entitlements                                                                                         | `apps/desktop` packaging, `apps/server/resources/cli-entitlements.plist`                                                                                                               | Not re-checked here. Upstream grants `allow-unsigned-executable-memory`, `disable-library-validation` (app) and more for the CLI; only `allow-jit` is known to be required                                                                     |
| Signing                                                                                              | `apps/desktop/scripts/electron-launcher.mjs` (`codesign --force --deep --sign -`)                                                                                                      | Source-tree launches are ad-hoc signed; `dist:desktop:*` builds are unsigned                                                                                                                                                                   |

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
   `~/.viewcode/userdata/logs/server.trace.ndjson`, `desktop.trace.ndjson`, and
   `spawn-trace.log`, note the time, and check the Cortex XDR app for an alert.
   Trace rows are OpenTelemetry spans (`name`, `attributes`, `events`, `exit`,
   and nanosecond timestamps), not messages with `message`/`level` fields.
   A missing shutdown log or crash report does not prove an EDR kill: an agent
   harness can also tear down the process group. Correlate an actual alert.
   Report to the user; don't work around the policy.
5. **Positive control (the missing experiment),** only with the user's go-ahead:
   run each CLI alone with a timeout and note which raises an alert:
   `perl -e 'alarm shift @ARGV; exec @ARGV' 15 codex --version` (a foreground
   alarm, not a detach; replace the
   executable and arguments for each allowed CLI). Stock macOS has neither
   `timeout` nor `gtimeout`.
   **Never** run `opencode --version` without a timeout: it opens a TUI and
   hung for minutes, taking the terminal session with it.
6. `./build.sh --install --managed` builds ViewCode for the browser and
   installs a `viewcode` command (`~/.local/bin`) that runs the server with
   plain Node and opens the UI in a browser: the mode that runs clean on this
   laptop. Afterwards just run `viewcode`; run the install again after pulling.
   It still spawns provider CLIs; if Cortex flags it, stop and go back to step 1.
   To skip building on the laptop, pack the same server on another machine
   (`node scripts/pack-viewcode-npm.ts`, see the README) and
   `npm install -g` the tarball here.

## Cursor Enterprise MCP policy

If Cursor reports that MCP servers are blocked by team policy, ask the team's
administrator to allow `viewcode` (called `t3-code` before October 2026). Verify with `cursor-agent mcp list` under the
same account; a blocked server cannot be restored by changing ViewCode's MCP
transport. An HTTP 401 for a bogus credential proves that the endpoint is
reachable and auth-gated, not that Cursor registered its tools.

ACP session setup confirms a session ID, not an inventory of loaded MCP tools.
Empty MCP resources are not evidence of empty tools. Stdio is mandatory in
ACP; only HTTP and SSE have capability flags. See the
[ACP session setup specification](https://agentclientprotocol.com/protocol/v1/session-setup).

The UI's New child agent action creates a thread directly and does not require
MCP. Cursor's native Task agents are a separate path; the agent explains the
fallback and can proceed without another confirmation, unless a required
provider/model or separate chat cannot be supplied. Cursor's team-policy result does
not establish whether Claude's separate SDK/MCP path is blocked.

## Known environment blockers

Each is an IT request. Never circumvent the control.

| Blocker                                                                    | Symptom                                                            | Fix                                                                                                                             |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Cursor Enterprise MCP policy                                               | Cursor loads zero ViewCode tools; `viewcode_*` missing in the chat | Ask the Cursor team admin to allow `viewcode` (see above)                                                                       |
| MCP blocked for a reviewer (Cursor policy, Claude `managed-mcp.json`)      | A review finishes but its findings never reach the Review panel    | No IT request: reviewers fall back to `viewcode-review submit`; if it reports `unreachable`, give the review thread full access |
| macOS application firewall row for the packaged app                        | Incoming-connection prompt or blocked listener for the app         | Ask IT to allow the app, or use the already-allowed `t3`/`node` path                                                            |
| Cloudflare tunnels blocked by a TLS-inspecting firewall plus always-on VPN | Tunnel never connects                                              | Ask IT for an exception for the tunnel host                                                                                     |
| EDR terminating `tailscaled`                                               | Tailscale sharing stops with the daemon                            | Ask IT for an exception for the Tailscale daemon; until then turn Tailscale off in ViewCode (see above)                         |

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
  `NODE_OPTIONS=--use-system-ca` (Node 24) is the fix for TLS inspection, or an
  approved `NODE_EXTRA_CA_CERTS` bundle. Never set
  `NODE_TLS_REJECT_UNAUTHORIZED=0`.
- A source launch from `./build.sh` runs as Electron with argv ending
  `dist-electron/main.cjs`, so `pgrep -x ViewCode` does not match it. Use
  `pgrep -f 'dist-electron/main.cjs'` for observation only, and inspect the
  result's command and cwd to distinguish other checkouts. Never use a pattern
  match as a list of processes to kill.
- `.electron-runtime/ViewCode (Alpha).app` is the bare Electron shell; launching
  it directly starts Electron's `default_app.asar`, not ViewCode. Start the app
  with `node apps/desktop/scripts/start-electron.mjs` or `./build.sh`.
- Logs are OpenTelemetry spans in `server.trace.ndjson` and
  `desktop.trace.ndjson` under `~/.viewcode/userdata/logs/`, not
  `server-child.log`.
- Don't detach processes with `setsid`, `perl` `POSIX::setsid` or other fork
  tricks. On EDR-managed machines that pattern triggers Behavioral Threat
  Protection alerts under the user's name and contaminates the experiment.
  Run in the foreground, or keep the harness's own process and retain its PID
  before attributing an unexplained exit to EDR.
- `ps` output inflates shell counts: one `zsh -ilc` whose `.zshrc` runs command
  substitutions (nvm, starship) shows as up to 4 processes with the same argv.
- **Line not to cross:** don't inspect or call the EDR's own helper binaries to
  read its policy, even if one runs unprivileged. That is privilege escalation
  on an account that is non-admin by design.

## Method lessons from the investigation

- Demand a positive control; ten surviving probes are not a diagnosis.
- Match cardinality and context (a burst of several CLIs, not one), not just
  the command.
- Read the app's trace files and spawn trace first; correlate their timestamps
  with the provider and security-tool evidence.
- A failed experiment (`fetch failed`) is inconclusive, not negative.
- Log unbuffered when the process may be killed.
