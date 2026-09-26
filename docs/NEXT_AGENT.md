# ViewCode: notes for the next agent working on this codebase

Not to be confused with the in-app **handoff** feature (switching model or
provider mid-chat), which is described in `internals/viewcode.md`.
Read this first, then [`internals/viewcode.md`](internals/viewcode.md) (decisions
and traps) and [`design/droppy-look.md`](design/droppy-look.md) (the visual
spec). `AGENTS.md` rules still apply: never kill processes by pattern, never
write to `~/.t3/userdata`, never set `VITE_HTTP_URL`/`VITE_WS_URL`, no PR
unless asked, no repo-wide checks.

Branch: `claude/modest-meitner-9cuywa`. Status of the original goals (G1–G14)
is in [`END_GOALS.md`](END_GOALS.md); product intent in [`PLAN.md`](PLAN.md).

**Setting ViewCode up on the user's managed company Mac (EDR, no admin)?**
Start with [`operations/managed-mode-plan.md`](operations/managed-mode-plan.md)
(the plan and settings), [`operations/managed-mac-experiments.md`](operations/managed-mac-experiments.md)
(what to run on the laptop) and [`operations/managed-macos.md`](operations/managed-macos.md) (background). Its "Work items" are also open engineering work (items 1–4 below
reference them).

## What the user wants, in their words

- A daily driver with a **professional, restrained look in the spirit of
  Droppy Code** (github.com/kalki-kgp/droppy-code), not "a normal
  AI-generated UI with the famous blue/violet". Not an exact Droppy copy:
  ViewCode keeps its own identity. Visual quality is the current blocker to
  them using it.
- Switch model or provider mid-chat without losing context ("preserve it, don't
  limit it"). The user's own messages are never summarized.
- Agents that spawn, message and wait on each other; an agent that hits its
  usage limit tells its parent instead of retrying.
- Clean start. No junk imported from provider session files. Import only from
  T3 Code (or ViewCode itself) when the user asks.
- Use each vendor's own subscription (GPT via Codex, not via Command Code).
- Command Code credits may be read from `~/.commandcode/auth.json`, local only,
  opt-in, every read logged, the key never logged.

## Run it

The user runs `./build.sh` (pull, install, build desktop, open). Keep it
working when build steps change.

```bash
corepack enable && pnpm install
pnpm dev                                   # server + web; read ports from [dev-runner]
pnpm build:desktop && pnpm --filter @t3tools/desktop start   # desktop, no TCP port
```

State: `~/.viewcode` (desktop) or the worktree's `.t3` (dev). In a root
sandbox start the dev server with `IS_SANDBOX=1` (Claude refuses
`bypassPermissions` as root). Seed test data with the `VACUUM INTO` recipe in
`AGENTS.md`, never by pointing at live state.

## Staying mergeable with upstream T3 Code

The user wants to keep pulling T3 Code updates. Every ViewCode change must
keep that cheap.

- Fork point: upstream commit `ed809f7ad` (2026-09-25). Since then ~220
  upstream files are modified and ~106 added. Add upstream as a remote and
  merge (never rebase this shared branch):
  `git remote add upstream https://github.com/pingdotgg/t3code && git fetch upstream && git merge upstream/main`.
- New behaviour goes in **new files** (`apps/server/src/agents/`,
  `orchestration/Handoff.ts`, `components/agents/`, …) and is wired into
  upstream files with a few lines. Prefer a hook, layer, variant or config flag
  over editing an upstream function body.
- Theme through **tokens**: palette entries in `themePalettes.ts`, CSS
  variables in `index.css` or one ViewCode theme CSS file, and `components/ui`
  variants. Swap a hard-coded colour class for a semantic token class rather
  than restyling a component.
- Keep upstream names, file layout and contracts. Extend contracts with
  optional fields; never rename or remove upstream ones (older clients, the
  store mobile app and upstream merges all depend on them).
- Hide instead of delete (see `SHOW_SESSION_IMPORT_STEP`): an upstream file you
  deleted conflicts on every upstream change to it.
- Merge hot spots today, by lines changed: `components/Sidebar.tsx` (~4k,
  largely rewritten; `LegacySidebar.tsx` holds the old one),
  `onboarding/WelcomeWizard.tsx`, `chat/ChatComposer.tsx`,
  `orchestration/Layers/ProviderCommandReactor.ts`, `chat/ModelListRow.tsx`,
  `chat/ProviderModelPicker.tsx`, `chat/TraitsPicker.tsx`, `ChatView.tsx`.
  When touching these, move ViewCode logic out into new modules where it's
  cheap. A worthwhile follow-up: shrink the Sidebar diff by moving the
  ViewCode tree/rows into `components/sidebar/` files.
- After a merge: typecheck server/web/desktop, run the ViewCode test files
  (handoff, AgentMessaging, sidebarThreadTree, commandCode*, composer logic),
  and look at the app once.

## Open work, in priority order

### 1. Professional re-theme, Droppy-inspired — **blocking daily use**

Spec with Droppy's tokens, palettes and region layouts as the reference, and
the recommended ViewCode default where it deviates:
[`design/droppy-look.md`](design/droppy-look.md). Borrow Droppy's structure
(glass surfaces, hairlines, neutral text hierarchy, sparse accent, theme
list); don't pixel-match it.

Where to change it: `packages/shared/src/themePalettes.ts` (`VIEWCODE_THEME` is
the web default), `apps/web/src/index.css` (CSS variables), hard-coded colour
classes listed in the spec's mapping table, `components/ui` variants (never
restyle with `className`; `shadcn/no-restyle` lint enforces it), desktop window
options in `apps/desktop` for macOS vibrancy / Windows Mica.

Acceptance:

- Side-by-side screenshots (dark and light, default theme and the Claude theme)
  of sidebar, chat with tool rows, composer with the effort popover open, and
  Settings. Save them in `docs/evidence/`. The bar is "looks like a
  carefully designed pro tool", judged against Droppy, Linear, Zed and
  macOS system apps, not a pixel match.
- No violet/indigo anywhere by default. Accent appears only where the spec says
  Droppy uses it. Text hierarchy uses the neutral label colours.
- Surfaces are translucent tints over a backdrop, separated by hairlines, not
  opaque slabs with shadows. Web falls back to a solid surface of the same
  tone when `backdrop-filter` is unavailable.
- Theme picker in Settings → Appearance offers Droppy's palette list; switching
  is instant and persists.
- Changes follow "Staying mergeable with upstream" above: tokens and
  variants first, few edits to upstream component files.
- The effort slider looks (plain / Max / fast / fusion, Grok silver) keep
  working; they already follow Droppy and are the one allowed animation.
- Performance: no new continuous animation, no layout thrash; scroll a long
  thread and compare frame time before/after.

Status: palettes, `viewcode-theme.css` and the one-line class swaps are in;
the picker lists ViewCode, upstream's themes and 18 ported Droppy themes
(`viewcode-*` ids). Screenshots and `docs/evidence/` are still to do. Open:

- macOS vibrancy / Windows Mica (§3.2) is wired (`window/WindowGlass.ts`,
  `html[data-window-glass]`, Settings → Appearance → Window transparency) but
  has only been built on Linux, where it is inert. Check on a real Mac and a
  Windows 11 machine: the see-through sidebar/window, the sheet's legibility,
  toggling live, Reduce transparency, and the window after a theme switch.
- Per-theme success colour for ported themes (success is not a palette role;
  they use the ViewCode green).
- The boot splash (`apps/web/index.html`) doesn't know `viewcode*` ids, so it
  paints stock `#0a0a0a`/`#ffffff` until React mounts.
- Not done from the §6.2 table: row 23 (T3 Connect banner), 26 (monochrome
  project icons), 30 (tool-row spacing check), 34 (gradient swatches), the
  floating chrome row, top veil and stepped working spinner (§5).

### 2. Import from T3 Code instead of provider session files

Provider-file import (Claude/Codex JSONL) is hidden: sidebar menu items
removed, onboarding step off via `SHOW_SESSION_IMPORT_STEP` in
`apps/web/src/components/onboarding/WelcomeWizard.tsx`. "Remove imported
sessions…" stays. Server RPCs (`agentSessions.list/import`) and the dialog are
kept.

Wanted instead: "Import from T3 Code" in onboarding and Settings.

- Read `~/.t3/userdata/state.sqlite` **read-only** (open with `readonly: true`,
  or snapshot with `VACUUM INTO` to a temp file first). Never write to it.
- List projects and threads with title, provider, message count, last activity;
  nothing checked by default; user picks.
- Copy threads with their messages (and `parentThreadId` if present) into
  ViewCode, with ids that can't collide (prefix like `t3:`), re-importing the
  same thread is a no-op.
- Works on desktop and `pnpm dev`; hide the entry when no T3 install is found.
- Tests: importer against a fixture database; idempotency; read-only open.

### 3. One-step phone connection

Today: Settings → Connections → Network access (relaunches on TCP) → pairing
QR. The user asked for something easier. Goal: a single "Connect phone" action
that turns network access on, shows the QR, and explains Tailscale for
off-LAN use. The store T3 mobile app connects (protocol version 1) but shows
child agents flat and agent-message envelopes as raw text; fixing that means
building `apps/mobile` ourselves. Ask the user before starting mobile work.

### 4. Things built but never verified end to end

| Item                                                  | Why unverified                       | How to verify                                                           |
| ----------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------- |
| Handoff Claude → Codex and back                       | Sandbox network blocked OpenAI hosts | Real machine: switch provider mid-thread, ask about an earlier PR link  |
| Compact-mode handoff (conversation > 25% window)      | Needs a long real thread             | Seed a long thread, switch, check prelude mode = compact in activity    |
| Command Code turns and credits (`readAccountCredits`) | api.commandcode.ai blocked           | Log in `cmd`, enable the switch, check the usage popover and server log |
| Effort slider fast and fusion looks                   | Test model had no fast mode          | Opus with fast mode, drag to Max, toggle fast                           |
| Windows named-pipe local mode                         | Linux sandbox                        | Windows build, confirm no TCP listener (`netstat -ano`)                 |
| macOS desktop first run                               | Linux sandbox                        | Fresh install, no "Still connecting"                                    |

### 4b. Managed-machine startup (from the company-laptop report)

From [`operations/managed-macos.md`](operations/managed-macos.md#work-items-in-priority-order):
don't exec providers that aren't installed; bound probe concurrency; first
launch probes only chosen providers; don't read credential files for a
telemetry id when telemetry is off. Each has its own "done when" there.

### 5. Smaller known gaps

- Models on/off per provider in Settings (asked once; check what exists under
  Settings → Providers before building).
- Command Code agents get no agents toolkit (its CLI only loads MCP from
  files); they work as workers only. Writing a project `.mcp.json` would fix it
  but touches the user's repo; ask first.
- Four server tests fail only when run as root (sandbox artefact).

## Reference repositories

Local clones in the old session's scratchpad are gone; clone again if needed.

- Droppy Code (visual reference, MIT): https://github.com/kalki-kgp/droppy-code —
  `DroppyCode/Views/Chrome/Chrome.swift`, `Models/AppTheme.swift`,
  `Views/Composer/EffortSlider.swift`, `Views/Sidebar/SidebarView.swift`.
- T3 Code upstream: https://github.com/pingdotgg/t3code
- MonoCode and Traycer were used for handoff/agent ideas only.
