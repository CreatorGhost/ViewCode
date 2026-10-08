# Side chat

Ask a quick question about a thread while its agent keeps working. A side chat
opens in a panel on the right of the chat and starts with what the main agent has
done so far, so you can ask "why did you pick this?" without interrupting it.

## Start one

On web and desktop, any of these opens the panel:

- The side chat button in the chat header.
- `Cmd+Shift+/` on Apple devices or `Ctrl+Shift+/` elsewhere. Change it in
  **Settings → Keybindings** under "Side chat".
- **Ask in side chat** in the command palette.
- Select text in a reply and choose **Ask in side chat**. The selection is quoted
  in the side chat's box, below anything you had already typed there.

Type your question and press Enter. The side chat uses the main thread's model
by default. Pick another model with the picker under the box; the main thread
is not affected.

## What it does and does not do

- The main agent is never interrupted and nothing is written into its thread.
- The side chat sees the main thread as it was when you asked. It does not follow
  later work, so ask a new side chat for a fresh view.
- Close the panel and reopen it to continue the same conversation.
- Use **New side chat** to start another, and **Open as full thread** to turn it
  into an ordinary thread in the sidebar.
- A side chat that has been idle for 24 hours is archived. It is not listed in
  the sidebar while it is a side chat.

Mobile has no side chat panel; side chats are hidden from the mobile thread list.
