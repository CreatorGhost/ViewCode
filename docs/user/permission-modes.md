# Permission modes

Permission modes control when an agent needs your approval to act. Choose a mode in the message
composer; it applies to that thread.

Set the default for new threads in **Settings → General → New threads → Permissions**.
Projects can override the environment default. New threads use this setting rather than the
mode of the thread you were viewing. New installations start with **Auto**; installations from
before Auto became the default keep **Full access**. Existing threads and modes you choose in a
draft keep their permissions.

| Mode                  | Behavior                                                                              |
| --------------------- | ------------------------------------------------------------------------------------- |
| **Supervised**        | Requests approval for commands and file changes.                                      |
| **Auto-accept edits** | Approves file edits automatically; other actions can still require approval.          |
| **Auto**              | Uses the provider's automatic review to approve routine actions and ask about others. |
| **Full access**       | Allows commands and edits without approval prompts.                                   |

Approve or reject requests in the conversation to let the agent continue. Permission modes do
not prevent the agent from asking questions about the task.

## Provider differences

Providers enforce permissions differently. Some read-only actions can proceed in **Supervised**.
**Auto** uses automatic review on Codex, Claude, Cursor, and Grok; providers without an equivalent,
including OpenCode and Antigravity, fall back to asking. On Grok, commands its review blocks come
to you for approval.

Muse Code offers only **Supervised** and **Full access**. A Muse thread already set to another mode
runs in **Supervised**.

Grok offers no **Auto-accept edits**. A Grok thread already set to it runs in **Supervised**. Grok
file-change approvals offer **Allow all edits this session**. Its command approvals have no
session-wide choice, because Grok would remember that command for the whole project.

ACP Registry agents run their own tools in their own mode; T3 Code answers their approval requests
by the permission mode. See [ACP Registry permissions](./providers-acp.md#permissions-and-terminals).

Antigravity can still send native approval requests in **Full access**. It only offers remembered
approvals for actions that support them.

Droid uses its autonomy levels: **Supervised** auto-approves reads, **Auto-accept edits** uses
low autonomy, **Auto** medium and **Full access** high, capped at what your organization allows.

Devin approves file edits itself outside **Full access** and asks before other actions, so
**Supervised**, **Auto-accept edits** and **Auto** behave the same there; **Full access** uses its
Bypass Permissions mode.

Pi has no permissions of its own; ViewCode asks before any tool that is not a read, and **Auto**
behaves like **Supervised**.

Command Code cannot ask for approval. Outside **Full access** it reads and answers, but its file
edits and shell commands are blocked and show as declined; the access menu says so. Choose **Full
access** for Command Code threads that should change files.

See the [provider guides](./install.md#providers) for setup and provider-specific limits.
