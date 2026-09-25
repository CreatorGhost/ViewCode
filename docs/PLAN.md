# ViewCode: Product and Technical Plan

ViewCode is a GUI control surface for the coding agents you already pay for:
Claude Code, Codex, Grok, OpenCode, Cursor, and Command Code (lower priority).
It combines four things:

- **T3 Code's architecture.** A local server drives the agent CLIs. The web,
  desktop and mobile apps are all clients of that server over one WebSocket
  protocol. Phones connect by QR pairing. **T3 Code is the base.**
- **Traycer's orchestration:**
  - switch model *and provider* mid-conversation with shared context;
  - agents message each other;
  - sub-agents are first-class agents you can open, prompt and re-model.
- **Droppy Code / MonoCode's look.** Dark frosted glass, pill chrome, a quiet
  collapsible timeline, and a pill composer with a model/effort picker and
  usage limits.
- **Your choices.**
  - Sidebar always visible on the left, grouped by project, with no
    settle/unsettle.
  - Handoff = summary plus the last few turns.
  - Agent-to-agent messages auto-wake the target.

---

## 1. Reference repos: how each is built

| | T3 Code (`pingdotgg/t3code`) | MonoCode (`hardbeat920/monocode`) | Droppy Code (`kalki-kgp/droppy-code`) | Traycer (`traycerai/traycer`) |
|---|---|---|---|---|
| Stack | Node server (Effect-TS) + React 19 web + Electron + Expo mobile | Tauri 2 (Rust) + React 19 + Tailwind v4 | Swift/SwiftUI, macOS 26 only | Electron/React/Capacitor clients; **Host is closed source** |
| Where agents run | Local **server** process | Inside the window: Rust pipes CLI stdout to the webview, which parses and holds state | Inside the app | Closed "Host" binary downloaded from GitHub Releases |
| Remote / phone | ✅ QR pairing (one-time token in the URL fragment), LAN, Tailscale, SSH, T3 Connect relay, native mobile app | ❌ | ❌ (left out on purpose) | ✅ via cloud relay (Noise-encrypted) |
| Providers | Claude (Agent SDK), Codex (app-server JSON-RPC), Cursor/Grok/Antigravity (ACP), OpenCode (SDK) | Claude, Codex, Cursor, Grok, OpenCode, Antigravity, Pi, omp, fx, Hermes | Claude, Codex, Cursor, OpenCode, Grok, Antigravity, Copilot, DeepSeek, Meta | Claude, Codex, Cursor, OpenCode, ACP family… |
| Switch provider mid-thread | ❌ Blocked in `ProviderCommandReactor.ts` ("bound to driver X and cannot switch to Y") | ❌ | ❌ ("New chats only") | ✅ Seeds a "fake-context" prelude from its own transcript |
| Agent-to-agent | MCP server injected into every session (device, preview and PR toolkits), with no agents toolkit | `/operator` → local `app` CLI: `sessions.start/list/read/send` | Hydra: lead + "heads" | Host-owned MCP `traycer_a2a`: `send_message(expectReply, responseId)`, `create_agent`, `get_transcript`… |
| Sub-agents | Read-only activity fold | Orchestration workers | Heads in a floating panel | Children are real agents (`parentId`), openable, re-modelable |
| Size | ~1.1M lines TS | ~225k TS + 37k Rust | ~36k Swift | clients only |
| License | MIT | MIT | MIT | MIT (clients) |

## 2. The base decision

**Fork T3 Code** and add the features plus the cosmetic reskin on top.

Why T3 Code:

1. **It is the only one whose architecture supports phones.** Agents run in a
   server, so every UI (desktop, browser, phone) is just a client. MonoCode and
   Droppy run agents inside the window. Traycer's core is closed.
2. **Mature provider adapters**, checkpoints (hidden git refs), a terminal,
   worktrees, diffs, PR integrations, auth scopes and pairing are already done.
3. **The new features map onto existing seams** (see §4). None needs a rewrite.
4. **MonoCode is also React 19 + Tailwind v4.** Its look can be ported into
   T3's web app component by component. Droppy supplies the design tokens.
5. **The fork keeps T3's git history**, so future T3 releases can be merged in
   (`git merge upstream/main`).

What we take from each:

| From | We take |
|---|---|
| T3 Code | Everything structural: server, protocol, providers, persistence, auth/pairing, web, desktop, mobile |
| Traycer | Handoff via a seeded context prelude; A2A tool semantics (`reply_expected` + `response_id`, inactivity notices); parent/child agents that are fully controllable |
| Droppy Code | Visual spec: glass tokens, radii, spacing, timeline folding ("Worked for 58s ›"), tool groups, todo card, pill composer, effort slider, usage-limit popover, working indicators |
| MonoCode | React/Tailwind implementations of the same look, the plan-limit fetchers, and `/operator`-style ideas |

## 2a. Core features and where each piece comes from

1. **Mid-chat model/provider switch (handoff).** T3 has no handoff: it
   forces a new thread to change provider. We build it ourselves inside T3's
   server, applying Traycer's idea of seeding the new model from our own
   transcript.
   - Same provider: the native session continues.
   - Cross-provider: the new model gets a summary plus the last turns
     verbatim, and the full transcript is saved to a file.
   - Works on parents and children alike.
   - The timeline shows a "context handed off" card.
2. **Child agents (full agents, Traycer-style).**
   - Each child has its own chat box, transcript, model, workspace and composer.
   - Children are nested under their parent in the **left sidebar**. You can
     open one, prompt it, and re-model it.
   - Spawned either by the agent (`viewcode_spawn_agent` / `send_message`
     with reply expected) or by the user ("New child agent").
   - Messages show as "→ to X ↩" / "← from X" cards.
   - An "Active agents · N running · Stop all" bar sits above the composer.
   - Behavior comes from Traycer. The plumbing comes from T3's MCP server and
     threads (child = thread with a parent link).
3. **In-chat sub-agents (provider-native, read-only).**
   - These are Claude `Task` / Codex `spawn_agent` running inside the parent's
     tool session.
   - They render as a collapsible group in the parent's timeline. They are
     not separate agent boxes and cannot be prompted or re-modeled.
   - T3's right-hand agents panel is removed. T3 already parses these events;
     we only change where they are displayed.
4. **Remote / phone:** T3 as-is (server, QR pairing, web, mobile app).
5. **UI:**
   - Droppy Code supplies the visual spec, and MonoCode's React/Tailwind
     components are ported.
   - The sidebar is always left and grouped by project → threads → child-agent
     tree. Pin and archive only.
6. **Providers:** Claude, Codex, Grok, OpenCode and Cursor come from T3.
   Command Code is new and lower priority.

## 3. Locked decisions

| # | Decision |
|---|---|
| D1 | App shape is the same as T3: a `viewcode` CLI starts the server and opens the browser, plus an Electron desktop app, plus mobile over LAN/Tailscale. |
| D2 | Base is a T3 Code fork. It is renamed to ViewCode (package scope, CLI name, app name, home dir `~/.viewcode`). |
| D3 | The source of truth for context is ViewCode's own projection of the transcript. Provider sessions are only a resume cache. |
| D4 | Model switch within one provider keeps the native session. Cross-provider switch triggers a **handoff**: a deterministic summary plus the last *N* turns verbatim, with the full transcript written to a file the new agent can read. |
| D5 | A2A goes through a new `viewcode` MCP toolkit on T3's existing MCP server. |
| D6 | An A2A message to an idle agent **auto-wakes** it. `reply_expected` opens a thread keyed by `response_id`. If the receiver ends its turn without replying, its final answer is routed back automatically. A hop limit per chain prevents loops. |
| D7 | Each **child agent** is a T3 **thread** with `parentThreadId`, so children inherit the composer, model picker, handoff, approvals and the phone UI for free, and are nested in the left sidebar. **In-chat sub-agents** (Claude Task, Codex spawn) are read-only groups inside the parent's timeline. T3's right-hand agents panel is removed. |
| D8 | The sidebar is always on the left and grouped by project → threads → agent tree. Pin + archive only; the settle/snooze UI is removed. On phones it becomes a drawer. |
| D9 | Reskin to Droppy/MonoCode: dark glass, pill chrome, purple accent, collapsible turns, pill composer, usage popover. |
| D10 | Command Code is a new provider: a headless CLI adapter (`cmd -p --output-format json`) first, with an OpenAI-compatible API agent as fallback. It is lower priority. |

## 4. Feature implementation on T3's seams

### 4.1 Cross-provider handoff

- **Seam:** `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`,
  in `ensureSessionForThread`. Today it throws when the driver kind or
  continuation key differs.
- **Change:**
  1. Stop the old provider session.
  2. Start the new one **without** a resume cursor.
  3. Record a `thread.handoff-recorded` event with `{from, to, summary, transcriptPath}`.
  4. On the next `sendTurn`, prepend the handoff prelude.
- **Summary builder:** a new `orchestration/Handoff.ts`. It reads
  `projection_thread_messages` and `projection_thread_activities` and produces:
  - the goal;
  - latest asks;
  - decisions (final answers);
  - files touched;
  - commands run;
  - open todos;
  - pending A2A threads;
  - the last *N* turns verbatim.

  The full transcript goes to `~/.viewcode/transcripts/<thread>/<n>.md`.
- **UI:**
  - Remove the provider lock in `apps/web/src/components/ChatView.logic.ts`
    (`deriveLockedProvider`) and `ModelPickerContent.tsx`. Cross-provider
    models show a "handoff" badge.
  - The timeline shows a handoff card.

### 4.2 Agent-to-agent (A2A)

- **Seam:** `apps/server/src/mcp/` (`McpHttpServer.ts`, `toolkits/*`). It is
  already injected into the Claude, Codex, Cursor, Grok and Antigravity sessions.
- **New `toolkits/agents`:**

  | Tool | Params |
  |---|---|
  | `viewcode_list_agents` | — |
  | `viewcode_list_models` | — |
  | `viewcode_spawn_agent` | `name, prompt, provider?, model?, effort?` |
  | `viewcode_send_message` | `to, message, reply_expected?, response_id?` |
  | `viewcode_read_transcript` | `agent, last_turns?` |
  | `viewcode_configure_agent` | `agent, provider?, model?, effort?` |

- **Delivery** is a new orchestration command, `thread.agent-message.deliver`.
  It appends a user message with an `agent` sender and starts a turn if the
  target is idle, or queues it if the target is busy. Reply routing and the
  inactivity notice run in a reactor.
- **UI:** "→ to X · Reply expected" and "← from X" cards, as in Traycer.

### 4.3 Sub-agents as real agents

- Contracts get `parentThreadId` on the thread shell, with a migration adding
  `projection_threads.parent_thread_id`.
- Spawn comes either from the user ("New sub-agent" on a thread) or from
  `viewcode_spawn_agent`.
- The sidebar nests child threads under their parent with a dotted connector.
- Opening a child gives the full ChatView: prompt it, switch its model, approve.

### 4.4 Sidebar and reskin

- The sidebar is grouped by project. Settle/snooze filters are removed; pin
  and archive stay.
- Tokens (from Droppy `Chrome.swift` / MonoCode `styles/index.css`):
  - window radius 26, sheet inset 10 / radius 16;
  - rows 28px / radius 7;
  - pills 32px;
  - composer radius 22;
  - user bubble radius 18 with accent 14% tint;
  - hover 6%, selected 12%, hairline 14%.
- Timeline:
  - a finished turn folds to "Worked for Xs ›" plus the final answer plus a
    file card;
  - running turns show grouped tool rows and a rotating working word with a
    3×3 pulse spinner.
- Composer pill: attach, provider glyph, `Model Effort ⌄`, context ring, round
  send/stop button.
- Model popover: all providers, an effort slider (Low…Max) with a Fast toggle,
  and plan-limit bars.

### 4.5 Command Code provider

- A new driver in `apps/server/src/provider/Drivers/CommandCodeDriver.ts`.
- One `cmd -p --output-format json` process per turn, mapped from NDJSON to
  runtime events, with `--resume` for continuity.
- MCP is used for A2A if `cmd` accepts an MCP config; otherwise A2A falls back
  to a text protocol.

## 5. Milestones

1. **Import:** T3 Code with its history, renamed to ViewCode; the build and
   tests pass.
2. **Handoff:** cross-provider switch, handoff card, tests with a fake adapter.
3. **A2A:** the `viewcode` MCP toolkit, delivery/wake, reply routing, hop limit, cards.
4. **Sub-agents:** `parentThreadId`, spawn, the sidebar tree.
5. **Reskin:** sidebar by project, tokens, timeline, composer, model/usage popover.
6. **Command Code** provider.
7. **Later:** mobile-app parity for the new features (it shares
   `client-runtime`, so most of it comes for free) and themes.
