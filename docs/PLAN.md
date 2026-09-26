# ViewCode: Product and Technical Plan

ViewCode is a GUI control surface for the coding agents you already pay for:
Claude Code, Codex, Grok, OpenCode, Cursor, and Command Code (lower priority).
It combines four things:

- **T3 Code's architecture.** A local server drives the agent CLIs. The web,
  desktop and mobile apps are all clients of that server over one WebSocket
  protocol. Phones connect by QR pairing. **T3 Code is the base.**
- **Traycer's orchestration:**
  - switch model _and provider_ mid-conversation with shared context;
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

|                            | T3 Code (`pingdotgg/t3code`)                                                                                 | MonoCode (`hardbeat920/monocode`)                                                                                                                                                                                  | Droppy Code (`kalki-kgp/droppy-code`)                                       | Traycer (`traycerai/traycer`)                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Stack                      | Node server (Effect-TS) + React 19 web + Electron + Expo mobile                                              | Tauri 2 (Rust) + React 19 + Tailwind v4                                                                                                                                                                            | Swift/SwiftUI, macOS 26 only                                                | Electron/React/Capacitor clients; **Host is closed source**                                              |
| Where agents run           | Local **server** process                                                                                     | Inside the window: Rust pipes CLI stdout to the webview, which parses and holds state                                                                                                                              | Inside the app                                                              | Closed "Host" binary downloaded from GitHub Releases                                                     |
| Remote / phone             | ✅ QR pairing (one-time token in the URL fragment), LAN, Tailscale, SSH, T3 Connect relay, native mobile app | ❌                                                                                                                                                                                                                 | ❌ (left out on purpose)                                                    | ✅ via cloud relay (Noise-encrypted)                                                                     |
| Providers                  | Claude (Agent SDK), Codex (app-server JSON-RPC), Cursor/Grok/Antigravity (ACP), OpenCode (SDK)               | Claude, Codex, Cursor, Grok, OpenCode, Antigravity, Pi, omp, fx, Hermes                                                                                                                                            | Claude, Codex, Cursor, OpenCode, Grok, Antigravity, Copilot, DeepSeek, Meta | Claude, Codex, Cursor, OpenCode, ACP family…                                                             |
| Switch provider mid-thread | ❌ Blocked in `ProviderCommandReactor.ts` ("bound to driver X and cannot switch to Y")                       | ✅ Handoff (`features/sessions/model/handoff.ts`): the outgoing agent writes a recap if it is still alive and made edits, otherwise a deterministic recap; the new provider's first turn is wrapped in `<handoff>` | ❌ ("New chats only")                                                       | ✅ Seeds a "fake-context" prelude from its own transcript                                                |
| Agent-to-agent             | MCP server injected into every session (device, preview and PR toolkits), with no agents toolkit             | `/operator` → local `app` CLI: `sessions.start/list/read/send`                                                                                                                                                     | Hydra: lead + "heads"                                                       | Host-owned MCP `traycer_a2a`: `send_message(expectReply, responseId)`, `create_agent`, `get_transcript`… |
| Sub-agents                 | Read-only activity fold                                                                                      | Orchestration workers                                                                                                                                                                                              | Heads in a floating panel                                                   | Children are real agents (`parentId`), openable, re-modelable                                            |
| Size                       | ~1.1M lines TS                                                                                               | ~225k TS + 37k Rust                                                                                                                                                                                                | ~36k Swift                                                                  | clients only                                                                                             |
| License                    | MIT                                                                                                          | MIT                                                                                                                                                                                                                | MIT                                                                         | MIT (clients)                                                                                            |

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

| From        | We take                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T3 Code     | Everything structural: server, protocol, providers, persistence, auth/pairing, web, desktop, mobile                                                                                                                                                                                                                                                                                                                                |
| Traycer     | Handoff via a seeded context prelude; A2A tool semantics (`reply_expected` + `response_id`, inactivity notices); parent/child agents that are fully controllable                                                                                                                                                                                                                                                                   |
| Droppy Code | Visual spec: glass tokens, radii, spacing, timeline folding ("Worked for 58s ›"), tool groups, todo card, pill composer, effort slider, usage-limit popover, working indicators                                                                                                                                                                                                                                                    |
| MonoCode    | React/Tailwind implementations of the same look (tokens in `styles/index.css`, glass surfaces, composer, model flyout, transcript folding); its **handoff flow** (outgoing-agent recap or deterministic recap, `<handoff>` wrapper, divider); its **plan-limit fetchers** (Claude `GET api.anthropic.com/api/oauth/usage` with the CLI's OAuth token, Codex `account/rateLimits/read`, OpenCode Go usage); `/operator`-style ideas |

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
   - Spawned either by the agent (`spawn_agent`, or `send_message` with a
     reply expected) or by the user ("New child agent").
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

| #   | Decision                                                                                                                                                                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | App shape is the same as T3: a `viewcode` CLI starts the server and opens the browser, plus an Electron desktop app, plus mobile over LAN/Tailscale.                                                                                                                                                                                           |
| D2  | Base is a T3 Code fork. It is renamed to ViewCode (package scope, CLI name, app name, home dir `~/.viewcode`).                                                                                                                                                                                                                                 |
| D3  | The source of truth for context is ViewCode's own projection of the transcript. Provider sessions are only a resume cache.                                                                                                                                                                                                                     |
| D4  | Model switch within one provider keeps the native session. Cross-provider switch triggers a **handoff**: a deterministic summary plus the last _N_ turns verbatim, with the full transcript written to a file the new agent can read.                                                                                                          |
| D5  | A2A goes through a new `agents` MCP toolkit on T3's existing MCP server.                                                                                                                                                                                                                                                                       |
| D6  | An A2A message to an idle agent **auto-wakes** it; a busy agent gets it when its turn ends. With `reply_expected`, the receiver's final answer is routed back to the sender. A hop limit per chain (24) prevents loops.                                                                                                                        |
| D7  | Each **child agent** is a T3 **thread** with `parentThreadId`, so children inherit the composer, model picker, handoff, approvals and the phone UI for free, and are nested in the left sidebar. **In-chat sub-agents** (Claude Task, Codex spawn) are read-only groups inside the parent's timeline. T3's right-hand agents panel is removed. |
| D8  | The sidebar is always on the left and grouped by project → threads → agent tree. Pin + archive only; the settle/snooze UI is removed. On phones it becomes a drawer.                                                                                                                                                                           |
| D9  | Reskin to Droppy/MonoCode: dark glass, pill chrome, purple accent, collapsible turns, pill composer, usage popover.                                                                                                                                                                                                                            |
| D10 | Command Code is a new provider: a headless CLI adapter (`cmd -p --output-format json`). The OpenAI-compatible API fallback was not built.                                                                                                                                                                                                      |
| D11 | **Local mode needs no listener.** The desktop app's backend listens on a Unix socket (a named pipe on Windows), which the window reaches through the main process. A TCP port opens only when the user turns on network access.                                                                                                                |

## 4. What was built, on T3's seams

### 4.1 Mid-chat switch and handoff

- `ProviderCommandReactor.ts` no longer refuses a switch. If the new model
  runs on the same provider instance (same continuation identity), the native
  session continues. Otherwise the old session stops and the new one starts
  with `freshSession: true`, so the stored resume cursor is ignored.
- `orchestration/Handoff.ts` builds the handoff **deterministically** from
  the projected transcript: original request, latest asks, recent answers,
  files changed, commands run, plan/todos, then the last 3 exchanges
  verbatim. We do not ask the outgoing model for a recap: the usual reason to
  switch is that it is out of quota.
- The full transcript is written to `<stateDir>/transcripts/<thread>/`, and
  the prelude points the new model at it. The first turn after the switch
  carries the prelude; the timeline shows a `viewcode.handoff` activity as
  a "Context handed off" divider.
- The web model picker no longer locks the provider. Models that would
  trigger a handoff carry a **Handoff** badge.

### 4.2 Agent-to-agent (A2A)

- A new `agents` toolkit on T3's MCP server (`apps/server/src/mcp/toolkits/agents/`),
  granted to every provider session that has MCP (Claude, Codex, Cursor, Grok,
  OpenCode, Antigravity; not Command Code, whose CLI takes no MCP config):

  | Tool              | Params                                                |
  | ----------------- | ----------------------------------------------------- |
  | `list_agents`     | —                                                     |
  | `list_models`     | —                                                     |
  | `spawn_agent`     | `name, prompt, provider_id?, model?, reply_expected?` |
  | `send_message`    | `to, message, reply_expected?, response_id?`          |
  | `read_transcript` | `agent, last_messages?`                               |
  | `configure_agent` | `agent, provider_id?, model`                          |

- `agents/AgentMessaging.ts` delivers a message as a normal
  `thread.turn.start` whose text begins with a
  `<viewcode-agent-message …>` envelope. It starts the target at once if it
  is idle, or queues until its turn ends. It routes the final answer back
  when a reply is expected and enforces the hop limit. Agents can only reach
  agents in their own tree (the root thread and all its descendants).
- The sender's timeline gets a `viewcode.agent-message.sent` activity. The
  web app renders both sides as "→ to X ↩" and "← from X" cards.

### 4.3 Child agents

- `parentThreadId` on the thread shell and detail, persisted by migration
  `055_ProjectionThreadsParentThreadId`.
- Created by `spawn_agent` or by the user ("New child agent" in the chat
  menu). A child is a normal thread: its own chat, composer, model picker and
  handoff.
- An "Active agents · N running · Stop all" bar above the parent's composer.

### 4.4 Sidebar and look

- The sidebar is grouped project → threads → child-agent tree with dotted
  connectors. Pin and archive only; settle/snooze is gone. On phones it is a
  drawer.
- The neutral `viewcode` theme (logo-amber accent, follows the system
  appearance) is the default on web and desktop; Droppy's named themes are
  offered beside it. The chat top bar uses pill buttons and capsule groups. Finished turns fold
  to "Worked for Xs ›".
- The model picker has effort levels and a Fast toggle. Plan limits use T3's
  usage page, which shows data only where the provider's login reports it.
- In-chat sub-agents (Claude `Task`) stay a read-only group in the parent's
  timeline. T3's right-hand Agents panel is no longer linked.

### 4.5 Command Code provider

- `provider/commandCodeCli.ts` plus the Command Code adapter, provider and
  driver. One `cmd -p --output-format json` process per turn, with NDJSON
  mapped to runtime events and `--resume <id>` for continuity.

### 4.6 Local mode

- `--listen-path` / `T3CODE_LISTEN_PATH` makes the server listen on a
  socket. The desktop serves it to the window as `t3code-backend://<id>/`.
  Providers reach MCP through a stdio bridge (`McpStdioBridge.ts`), so no
  port is needed. `T3CODE_DESKTOP_BACKEND_TCP=1` forces the old TCP mode.
- Turning on **Settings → Connections → Network access** restarts the backend
  on TCP for phone pairing. Turning it off returns to socket-only.

## 5. Not done / known limits

- Codex, Grok, OpenCode, Cursor and Command Code were not run live in the
  build sandbox (their hosts are blocked there). Cross-provider handoff was
  verified live between two Claude accounts, which takes the same code path.
- Windows named pipes compile but are untested.
- The Command Code API fallback was not built.
- Native mobile app parity for the new cards and the agent tree beyond what
  the shared client runtime gives for free.
