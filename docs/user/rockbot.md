# RockBot

RockBot is one chat that knows about every project, thread and agent on a computer you
use with ViewCode. Ask it what needs you, how your agents are doing, or where you did
something, and it answers with links that open those threads.

## Open it

- Web and desktop: the robot button at the bottom of the left rail, or **Open RockBot**
  in the command palette. The button shows how many threads wait on you.
- Mobile: the sparkle button in the Home header.

The first time, RockBot starts on the model of the thread you used last. Change its model
in its composer like any thread. Each computer you connect has its own RockBot.

## What to ask

- "What needs me?" lists approvals and questions waiting on you, then failures and
  agents still working.
- "Find the thread where I fixed the login redirect" searches every project.
- "How are my agents doing?" reads each working thread's latest messages.

## Sending to other threads

RockBot can tell another thread something or answer its question, but only after you
agree. When it wants to, a **Send / Don't send** prompt shows above its composer with the
exact message. Nothing reaches the other thread until you press **Send**; the server
enforces this, not RockBot.

RockBot never approves anything. For an approval, it links the thread so you can open it
and decide there. It also cannot archive, rename or otherwise change threads.

RockBot is not listed with your threads and is never settled automatically.
