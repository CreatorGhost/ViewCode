# RockBot

RockBot is a chat that knows about every project, thread and agent on a computer you
use with ViewCode. Ask it what needs you, how your agents are doing, or where you did
something, and it answers with links that open those threads.

## Open it

- Web and desktop: the robot button at the bottom of the left rail, or **Open RockBot**
  in the command palette. The button shows how many threads wait on you, and opens your
  latest RockBot chat.
- Mobile: the sparkle button in the Home header.

The first time, RockBot starts on the model of the thread you used last. Change its model
in its composer like any thread. Each computer you connect has its own RockBot.

## Past chats

While a RockBot chat is open, the sidebar lists your RockBot chats in place of your
projects, newest first. Start another with the pencil next to **RockBot**, or **New
RockBot chat** in the command palette. Rename or archive them like any thread; archived
chats are under **Settings → Archived**. Click a project on the rail to go back to your
work.

On mobile (iOS and Android), the sparkle button on Home opens a menu with **New chat**
and your recent RockBot chats, and the new-chat button in a RockBot chat's header starts
another. On web and desktop, the command palette also finds RockBot chats by title.

## What to ask

- "What needs me?" lists approvals and questions waiting on you, then failures and
  agents still working.
- "Find the thread where I fixed the login redirect" searches every project.
- "How are my agents doing?" reads each working thread's latest messages.

## Sending to other threads

RockBot can tell another thread something or answer its question, but only after you
agree. When it wants to, a **Send / Don't send** prompt shows above its composer with the
exact message (on mobile, a card headed "RockBot asks before sending"). Nothing reaches the other thread until you press **Send**; the server
enforces this, not RockBot.

RockBot never approves anything. For an approval, it links the thread so you can open it
and decide there. It also cannot archive, rename or otherwise change threads.

RockBot chats are not listed with your projects' threads and are never settled
automatically.
