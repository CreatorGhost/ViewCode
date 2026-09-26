# Managed Mac: experiments to find what gets killed

Paste the prompt below into the agent on the managed laptop (e.g. Cursor's
agent). It needs no admin rights and no code changes: it runs the published
`npx t3` server with a spawn tracer and switches providers off and on one at a
time, which is the positive control the investigation never had. Bring the
filled-in results back to whoever implements
[`managed-mode-plan.md`](managed-mode-plan.md).

Why this works: `npx t3` dies the same way as the desktop app (reaches
`Listening`, then vanishes with no shutdown log), so the trigger is in the
server. `scripts/diagnostics/spawn-trace.cjs` appends one line per child
process with a synchronous write, so the last line before a kill survives.

---

## Prompt

> You are helping diagnose why the T3 Code server gets killed by the endpoint
> security agent on this Mac. Hard limits: this account has **no admin
> rights**; never use `sudo`, never try to elevate, never inspect, call or
> modify the security agent's own binaries, files or processes, and don't try
> to hide or disguise anything from it. Put a timeout on every command. Never
> run `opencode` without `timeout` (it opens a TUI and hangs). Only kill
> processes by the PID you captured when you started them.
>
> **Setup**
>
> 1. `cd ~/dev/ViewCode && git pull` (the repo is already cloned there; if not,
>    `git clone https://github.com/CreatorGhost/ViewCode.git ~/dev/ViewCode`).
>    The tracer is `~/dev/ViewCode/scripts/diagnostics/spawn-trace.cjs`.
> 2. Answer Q1 before running anything else.
>
> **Q1. Inventory (read-only).** For each of `claude`, `cursor-agent`,
> `codex`, `opencode`, `grok`, `cmd`, `gh`, `brew`: print `command -v <name>`,
> the resolved real path, and `codesign -dv <realpath> 2>&1 | grep -E
'Authority|Signature|TeamIdentifier'` (skip ones not found). Also print
> `node -v`, `echo $SHELL`, and whether `~/.zshrc` runs nvm or starship.
>
> **Q2. Experiment ladder.** Run the three runs below, one at a time. For
> each run make a fresh folder, write its settings, start the server in the
> background with the tracer, wait 180 seconds, then record the results.
>
> ```bash
> run() {  # usage: run <name> '<providers json>'
>   B=$(mktemp -d /tmp/t3exp-$1.XXXX); mkdir -p "$B/userdata"
>   printf '{"providers":%s,"defaultAutoPull":false}\n' "$2" > "$B/userdata/settings.json"
>   PORT=$((14000 + RANDOM % 1000))
>   NODE_OPTIONS="--require $HOME/dev/ViewCode/scripts/diagnostics/spawn-trace.cjs" \
>   SPAWN_TRACE_LOG="$B/spawn-trace.log" \
>     nohup npx -y t3 serve --base-dir "$B" --port "$PORT" > "$B/server.out" 2>&1 &
>   PID=$!; echo "run=$1 pid=$PID port=$PORT dir=$B"
>   sleep 180
>   if kill -0 "$PID" 2>/dev/null; then echo "ALIVE after 180s"; else echo "DEAD"; fi
>   lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null && echo "port listening" || echo "port NOT listening"
>   echo "--- last 25 spawn-trace lines"; tail -25 "$B/spawn-trace.log"
>   echo "--- last 15 server lines"; tail -15 "$B/server.out"
>   kill "$PID" 2>/dev/null   # only our own PID
> }
> OFF='{"enabled":false}'
> run A "{\"codex\":$OFF,\"claudeAgent\":$OFF,\"cursor\":$OFF,\"grok\":$OFF,\"opencode\":$OFF,\"antigravity\":$OFF}"
> run B "{\"codex\":$OFF,\"claudeAgent\":{\"enabled\":true},\"cursor\":$OFF,\"grok\":$OFF,\"opencode\":$OFF,\"antigravity\":$OFF}"
> run C "{\"codex\":$OFF,\"claudeAgent\":{\"enabled\":true},\"cursor\":{\"enabled\":true},\"grok\":$OFF,\"opencode\":$OFF,\"antigravity\":$OFF}"
> ```
>
> Stop the ladder at the first run that dies; don't run later ones.
>
> **Q3. Only if run A died:** a provider isn't the cause. From its
> spawn-trace, name the last command before death. Then, as a single control,
> run a plain script that performs just that command (for example
> `node -e "require('child_process').execFileSync('/usr/sbin/ioreg',['-rd1','-n','product'])"`
> or the `-ilc` shell line exactly as logged), with a timeout, and say
> whether it survives.
>
> **Q4. Only if run A survived and a later run died:** from the dying run's
> spawn-trace, name the last provider command. Then run that exact command
> alone from Terminal with `timeout 20` and report whether it is killed.
>
> **Q5. Alerts (no admin).** Open the Cortex XDR app and, for each run that
> died, report any alert at that time: mode (Terminate/Notify), module, source
> process command line, and target process if shown. Ignore `/usr/bin/login`
> Notify alerts caused by the terminal.
>
> **Report back in exactly this format:**
>
> ```
> Q1 inventory: <name: path | signature/authority | found? ...>
> Run A (no providers): ALIVE|DEAD, port <listening|not>, last spawn: <line>
> Run B (+claude):      ALIVE|DEAD|not run, last spawn: <line>
> Run C (+cursor):      ALIVE|DEAD|not run, last spawn: <line>
> Q3/Q4 control: <command> -> survived|killed
> Q5 alerts: <time, mode, source cmdline, target> or none
> Full spawn-trace of the first dead run: <paste>
> ```

---

## Reading the results

| Outcome         | Meaning                                                                                                                                   | Next step                                                                |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| A dies          | Not providers. Culprit is the shell probe, discovery (`scutil`/`ioreg`/`sysctl`), the resource-monitor sidecar, or git                    | Implement M5–M7 and M11 from the plan first                              |
| A lives, B dies | Something in the Claude probe (e.g. the SDK `claude --output-format stream-json` launch or MCP config)                                    | Q4 tells whether `claude` alone is killed; if not, it's how we launch it |
| B lives, C dies | The Cursor probe (`cursor-agent about` / `cursor-agent acp`)                                                                              | Same, for Cursor                                                         |
| All live        | The kill needs Codex/OpenCode/Grok probes, i.e. the defaults. The settings above are a working setup today, and M1–M3 make it the default | Use the settings from the plan on the desktop app                        |

---

## Round 1 result and optional round 2

Round 1 (2026-09-26): runs A, B and C all survived, so the kill needs a
provider that was off. Notes from running it: macOS has no `timeout` binary
(use a `perl -e 'alarm shift; exec @ARGV'` shim), and `kill "$PID"` only stops
the `npx` wrapper; stop the server's own PID from the spawn-trace too.

Round 2 is optional: it tells which provider is the trigger, but each run
that dies **will raise a real Terminate alert** that the security team sees.
Only run it if that's acceptable. Same `run` function, one provider at a time:

```bash
run D "{\"codex\":{\"enabled\":true},\"claudeAgent\":$OFF,\"cursor\":$OFF,\"grok\":$OFF,\"opencode\":$OFF,\"antigravity\":$OFF}"
run E "{\"codex\":$OFF,\"claudeAgent\":$OFF,\"cursor\":$OFF,\"grok\":$OFF,\"opencode\":{\"enabled\":true},\"antigravity\":$OFF}"
run F "{\"codex\":$OFF,\"claudeAgent\":$OFF,\"cursor\":$OFF,\"grok\":{\"enabled\":true},\"opencode\":$OFF,\"antigravity\":$OFF}"
```

D = Codex, E = OpenCode, F = Grok (not installed). Report ALIVE/DEAD and the
last spawn for each.

## Running experiments correctly on macOS

- **No `timeout` on a stock Mac.** Use `perl -e 'alarm shift; exec @ARGV' 20 <cmd>`.
- **Detach fully.** Agent harnesses can tear down the process group when a
  tool call returns, which leaves a dead server with no shutdown log, the same
  signature as an EDR kill. macOS has no `setsid` command; start servers with
  `perl -MPOSIX -e 'POSIX::setsid() or die; exec @ARGV' npx -y t3 serve ...`
  and confirm PPID 1. A process that died without a log is not by itself
  evidence of the EDR; check for a Terminate alert at that time.
- **Stop what you started:** the `npx` wrapper PID is not the server; stop the
  server PID from the spawn-trace as well.

---

## Round 3: the desktop app with the blocked providers off

Background: the locally built, ad-hoc signed DMG app was terminated by
Behavioral Threat Protection (source process = the app's main binary, publisher
blank, killed live after it had created `~/.viewcode`). That run used a fresh
`~/.viewcode`, so default settings: Codex on. The `npx t3` runs that survived had
Codex/OpenCode/Grok off. Two variables changed at once; this round separates
them. Paste to the laptop agent:

> Same hard limits as before (no sudo, never touch the security software,
> timeouts via `perl -e 'alarm shift; exec @ARGV' <secs> <cmd>`, stop only
> PIDs you started or observed for this app).
>
> 1. Move the old state aside, don't delete it:
>    `mv ~/.viewcode ~/.viewcode.bak-$(date +%s)` (skip if absent).
> 2. Write `~/.viewcode/userdata/settings.json` **before** launching:
>    ```json
>    {
>      "providers": {
>        "codex": { "enabled": false },
>        "claudeAgent": { "enabled": true },
>        "cursor": { "enabled": true },
>        "grok": { "enabled": false },
>        "opencode": { "enabled": false },
>        "antigravity": { "enabled": false },
>        "commandCode": { "enabled": false }
>      },
>      "defaultAutoPull": false
>    }
>    ```
> 3. `codesign -dv ~/Applications/ViewCode.app 2>&1 | grep -E 'Identifier|Signature|TeamIdentifier'`
>    and the same for the `npx t3` binary
>    (`~/.npm/_npx/*/node_modules/@t3code/t3-darwin-arm64/t3`).
> 4. Launch: `open ~/Applications/ViewCode.app`, note the time, then every 5s
>    for 180s record whether the packaged app remains alive (observe only).
>    `pgrep -x ViewCode` applies to that packaged executable, not a source
>    launch from `./build.sh`. For the latter, inspect
>    `pgrep -f 'electron-runtime.*dist-electron/main.cjs'` and its cwd to
>    distinguish other checkouts. Never kill processes selected by a pattern.
> 5. Record: ALIVE/DEAD and time of death; last 30 lines of
>    `~/.viewcode/userdata/logs/server.trace.ndjson` and `desktop.trace.ndjson`
>    (OpenTelemetry spans, one JSON object per line; grep `"name":"check` to see
>    which provider checks ran); any new file in
>    `~/Library/Logs/DiagnosticReports` (crash vs external kill); the Cortex XDR
>    alert at that time (mode, module, source command line).
> 6. Quit the app normally if alive.
>
> Report: `Round 3: ALIVE|DEAD at +Ns · last trace spans · alert · codesign lines`.

Reading it: **alive** → the blocked providers were the trigger for the app too;
the provider gate is the fix. **Dead** → the app's own startup or its missing
signature is scored; go to the desktop startup diet in `managed-mode-plan.md`
and signing.

### Round 3 result (2026-09-26): ALIVE

The same ad-hoc signed DMG app, not rebuilt, with Codex/OpenCode/Grok/
Antigravity/Command Code off and Claude + Cursor on: alive for the whole
window (8+ minutes), clean exit on quit, no crash report.

| Run                   | Signature                  | Codex/OpenCode/Grok | Result     |
| --------------------- | -------------------------- | ------------------- | ---------- |
| `npx t3` A/B/C        | Developer ID (`t3` binary) | off                 | alive      |
| DMG app, first launch | ad-hoc, no team            | on (fresh defaults) | terminated |
| DMG app, round 3      | ad-hoc, no team            | off                 | alive      |

Conclusion: launching the blocked providers is what gets the app killed;
the missing signature is not sufficient on its own (it may still add to the
score). The provider gate is the fix; signing matters for sharing builds.

Logs in this build are OpenTelemetry span files
(`~/.viewcode/userdata/logs/server.trace.ndjson`, `desktop.trace.ndjson`), not
`server-child.log`; earlier references to that file are wrong.
