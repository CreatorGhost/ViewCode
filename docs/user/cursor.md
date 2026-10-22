# Cursor

Cursor runs in one of two ways, chosen per Cursor instance under **Settings > Providers > Cursor >
Runtime**:

- **Cursor CLI (`cursor-agent`)**: ViewCode starts Cursor's own command-line agent and talks to it
  over ACP. The CLI keeps its own sign-in, and Cursor's tools run under the CLI, not under ViewCode.
  Install it from [cursor.com/docs/cli/installation](https://cursor.com/docs/cli/installation).
- **Cursor SDK**: Cursor runs inside the ViewCode server through the official
  [`@cursor/sdk`](https://cursor.com/docs/api/sdk/typescript) package, with its own sign-in.
  Nothing else needs installing.

**Automatic**, the default, uses the CLI on macOS when `cursor-agent` is installed and the SDK
otherwise. On Linux and Windows it uses the SDK, and the CLI only where the SDK is not available
(for example Windows on Arm). Choose the CLI on a company-managed Mac whose security software stops
ViewCode when it runs Cursor's tools itself; see
[managed Macs](../operations/managed-macos.md#cursor-runs-as-cursor-agent-again-october-2026).
**Binary path** points ViewCode at a `cursor-agent` that is not on `PATH`.

Switching the runtime of an instance starts a fresh Cursor conversation for existing threads; their
history carries over as context.

## Prerequisites

- Node.js 22.13 or newer. The repository's supported Node version satisfies this requirement.
- For the CLI runtime, `cursor-agent` signed in on the machine that runs ViewCode.
- For the SDK runtime, a Cursor sign-in in **Settings > Providers > Cursor**, or a Cursor API key in
  `CURSOR_API_KEY`.
- A model the runtime accepts. `auto` is Cursor's `default` model.

The SDK runtime uses the SDK's local-agent runtime so runs operate in the selected ViewCode
workspace. Cursor cloud agents need repository and cloud-environment configuration that ViewCode does
not expose yet.

## Sign in

With the **CLI runtime**, ViewCode uses the login `cursor-agent` already has. If it is signed out,
choose **Sign in** to run `cursor-agent login` in a terminal inside Settings, or run
`cursor-agent login` yourself in a terminal on the machine that runs ViewCode. **Sign out** runs
`cursor-agent logout`, which signs the CLI out everywhere on that machine. The settings card shows
the account the CLI is signed in with.

After the computer sleeps or changes network, a Cursor message can fail because the CLI could not
read its saved sign-in (for example while the Mac's Keychain is locked) or reach Cursor, or it can
end with "Cursor stopped responding; send it again" when the CLI went quiet for ten minutes. Send
the message again: ViewCode starts a fresh `cursor-agent` for it. Sign in again only if
`cursor-agent status` in a terminal says you are signed out. "Couldn't reach Cursor to list models"
in the settings card clears by itself; ViewCode checks again when the computer wakes, the network
comes back or you return to the window, and keeps the models it last listed meanwhile.

With the **SDK runtime**, choose **Sign in**, then open the sign-in page and complete it in your
browser. ViewCode updates automatically when sign-in finishes. This works when connected to a remote
environment too. On mobile, use **Settings > Provider accounts** for an already configured Cursor
instance.

Each SDK instance keeps its own login on the environment that runs it, separate from your Cursor
editor and CLI login. A configured `CURSOR_API_KEY` overrides browser sign-in; remove that override
to use the browser flow.

Use **Change account** or **Sign out** in the same settings section. Both stop that
instance's running threads and keep their history. Sign-out forgets the saved credential; to revoke
the generated key before it expires, remove it from your Cursor dashboard's API keys.

## CLI runtime capabilities

The CLI runtime supports models and their options from `cursor-agent`'s model list, resuming
conversations, approvals (Full access starts the CLI with `--force`), interruption, plan mode with
Cursor's proposed plans and questions, ViewCode's MCP tools where your Cursor team policy allows
them, and Cursor account usage. Cursor's todo-list updates and `task` subagents are not shown as
they are on the SDK runtime.

## SDK runtime capabilities

The adapter supports:

- creating and resuming local Cursor agent threads;
- changing the model and model parameters between turns;
- assistant text, reasoning, tool activity, plans, and todo streaming;
- thread-scoped ViewCode MCP tools;
- image attachments;
- interruption, queued app messages, and orchestrator-owned interrupt/restart steering;
- provider conversation snapshots through `Agent.messages.list()`;
- Cursor `task` subagents, projected as read-only child app threads with their tool activity and
  final result.

The public SDK does not currently expose native agent fork, conversation rollback, active steering,
or interactive approval callbacks. Direct active steering is advertised as unsupported, while V2
steering uses the orchestrator's interrupt-and-restart path and preserves the app run identity across
provider turns. Same-provider Cursor forks use the orchestrator's portable full-thread context
handoff into a fresh Cursor agent. The SDK has in-process custom callback tools, but the V2 adapter
intentionally uses the authenticated, thread-scoped MCP server instead.

Portable handoffs summarize eligible timeline items and can omit the end of long messages. Read
[Context in portable handoffs](./portable-handoffs.md) before using a fork for work whose exact
instructions must carry forward.

Cursor task events include an `agentId`, but the local SDK does not register that identifier as a
resumable agent: `Agent.resume()` returns `AgentNotFoundError`. The adapter therefore does not attach
a provider thread to native task projections or advertise subagent thread IDs. A projected child is
read-only: send messages from the parent thread.

Runtime modes map to the controls the local SDK exposes: full access disables its sandbox, while
restricted modes and explicit non-full-access sandbox policies enable it. Explicit approval policy
overrides also control Cursor Auto-review. Auto-review is not represented as an interactive ViewCode
approval flow.

The binary path setting applies only to the CLI runtime; the SDK runtime never launches
`cursor-agent`.

## Replay And Live Testing

Cursor replay fixtures preserve the SDK boundary: agent open/resume, sends, ordered `onDelta`
updates, terminal results, cancellation, message snapshots, and close. The real V2 adapter,
orchestrator, event store, projections, and checkpoint logic still run in tests.

Record a fixture against the real SDK with:

```bash
pnpm --filter t3 record:cursor-replay --scenario simple
```

Use `--out <path>` to record a temporary probe without replacing a checked-in fixture. Supported
scenarios are listed by the recorder when an invalid scenario is supplied.
