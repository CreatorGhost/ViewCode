# ViewCode: End Goals (Definition of Done)

Work continues until every goal below is met. Each goal needs an
**evidence artifact** committed under `docs/evidence/`. Screenshots come from
the real running app, captured by Playwright/Chromium; the desktop app runs
under Xvfb. Command output is attached where a screenshot can't prove the
point, for example "no port is open".

## Verification environment (honest limits)

- **Claude Code CLI is installed and working in the build environment.**
  Everything involving Claude is verified against real Claude.
- **Codex, Grok, OpenCode, Cursor and Command Code are not installed or
  logged in here.** They are verified by:
  - their adapters' automated tests with recorded protocol traffic, which T3
    already has for its providers and which we add for Command Code;
  - a built-in **scripted test provider**, which acts as "the other provider"
    in cross-provider screenshots.

  A live check on your machine is listed as a follow-up.
- A phone is simulated with a mobile-sized browser (iPhone viewport) that
  pairs through the real QR/token flow.

## Goals

| # | Goal | Done when | Evidence |
|---|------|-----------|----------|
| G1 | **ViewCode builds** from the T3 fork, renamed | Install, typecheck and the existing test suites pass, with new tests added for every feature below | test/typecheck output |
| G2 | **Local mode needs no listener** | The desktop app runs chats with **no listening TCP port** (checked with `ss -ltnp`), and the window talks to the engine over an in-app channel | screenshot + `ss` output |
| G3 | **Sidebar grouped by project** | Left sidebar always visible, organized project → threads → child-agent tree with dotted connectors; pin and archive only; settle/snooze removed | screenshot |
| G4 | **Droppy/MonoCode look** | Dark glass window, pill top bar, user bubbles, folded turns ("Worked for 58s ›"), grouped tool rows, to-do card, pill composer (`Model Effort ⌄`, context ring, round send/stop) | screenshots next to the reference images |
| G5 | **Same-provider model switch mid-chat** | Switch Opus → another Claude model in an existing chat; the next answer still knows earlier context | screenshot of picker + answer |
| G6 | **Cross-provider handoff mid-chat** | Switch an existing chat to another provider; a handoff card appears; the new model answers a question that needs earlier context (e.g. a codeword given before the switch) | screenshots before/after + handoff file |
| G7 | **Child agents** | Asking the parent to "spin up sub-agents" creates child agents that show nested under the parent in the sidebar; opening a child shows its own chat, transcript and composer; you can prompt it and switch its model | screenshots of tree, child chat, child model switch |
| G8 | **Agent-to-agent messaging** | "→ to X ↩ Reply expected" and "← from X" cards appear; an idle child auto-wakes; its reply is routed back to the parent and wakes it; a runaway loop is stopped by the hop limit | screenshots + test |
| G9 | **Active agents bar** | "Active agents · N running · Stop all" above the composer; Stop all stops the children | screenshot |
| G10 | **In-chat sub-agents are read-only** | Claude `Task` sub-agents render as a collapsible group inside the parent's timeline, not as agent boxes; the right-hand agents panel is gone | screenshot |
| G11 | **Model picker + usage** | Model popover lists all providers (cross-provider entries marked "handoff"), effort Low…Max, Fast toggle, and plan-limit bars where the provider reports them | screenshot |
| G12 | **Phone access (opt-in)** | Toggle phone access → QR + one-time token shown → a phone-sized browser pairs and sees the same projects, threads and agent tree, and can send a prompt; turning the toggle off closes the port | screenshots at mobile size + `ss` output |
| G13 | **Command Code provider** | Adapter maps `cmd -p --output-format json` NDJSON to ViewCode events, with resume; tests pass on recorded output; appears in Settings → Providers | test output + screenshot |
| G14 | **Docs** | README covers install, run, local vs phone mode, and providers; `docs/PLAN.md` matches what was built | files |

## Out of scope for this round

- Native mobile app store builds. T3's Expo app remains; the new features
  reach it through the shared client runtime and are verified in the
  mobile-sized browser.
- Relay (phone access without incoming ports).
- Team collaboration.
