# Goals and debug mode

Two settings a thread keeps across messages, whichever provider or model runs it.

## Goals

A goal is what "done" means for the thread, such as "all tests in packages/api
pass". While it is set, the agent is given the goal with every message, so it keeps
the whole objective in view instead of only the latest request.

- Send `/goal` followed by the goal to set or replace it.
- Send `/goal` on its own to edit it. On web and desktop, click the goal in the chat
  header or use **Set thread goal** in the command palette. On mobile, tap **Goal** in
  the composer's toolbar.
- Send `/goal pause`, `/goal resume` or `/goal clear`. A paused goal stays on the thread
  but is not sent until you resume it; the header shows it as paused. To set a goal
  that is literally one of those words, send `/goal -- pause`.
- Saving a goal does not start the agent. To start it, click **Save & run** in the goal
  editor or the play button beside the goal in the chat header, use **Run thread goal**
  in the command palette, or send `/goal run`; on mobile, tap **Goal**, then **Run**. This
  sends a visible "Start working on the goal." message ("Continue working on the goal."
  once the thread has messages). Run is offered while the goal is active and the thread
  is idle.

On web and desktop, a goal or debug mode set on a new chat before its first message
applies from that message; on mobile, set them once the thread has started. Agents
can read the goal, and record one you state in the conversation ("keep going until the
build is green"), but they are told never to make one up. The agent says when it thinks
the goal is met; clearing it is up to you.

ViewCode's `/goal` replaces the provider's own `/goal` command (Codex and Claude Code
have one): the goal belongs to the thread, so it survives switching provider or model.
Running a goal starts one turn; the agent still does not keep working on its own
between turns.

## Debug mode

Debug mode asks the agent to find the cause of a problem from evidence before fixing it:
reproduce it, gather logs and errors, test one hypothesis at a time, change no code
until the cause is shown, and report what it found.

- Send `/debug` to turn it on, and `/default` to turn it off (`/default` also leaves
  plan mode).
- On web and desktop, it is also **Debug mode** in the composer's **+** menu and in the
  command palette. While it is on, a **Debug** control sits beside the mode controls;
  click it to leave.
- On mobile, a **Debug** control shows in the composer's toolbar while it is on; tap it
  to leave.

Debug mode does not change the agent's permissions. Agents you start from a thread do
not inherit its goal or debug mode.
