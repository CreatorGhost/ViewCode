# Computer use (beta)

Computer use lets an agent see the apps open on the machine that runs the environment server and,
if you allow it, operate them: press buttons, fill in fields, type, click, drag, scroll and send
keyboard shortcuts. Agents reach it through the `viewcode-computer` command, which ViewCode puts on
their path, so it works with providers whose organization blocks MCP servers.

Agents work in two ways and pick per step. Where an app describes its controls to the system, they
act on a control by reference, which is exact and happens in the background: pressing a button,
setting a field or typing into it this way does not take your focus or bring the app to the front.
Where it does not, such as a 3D slicer's canvas, a game or a web page, they take a screenshot,
look at it and click, drag or scroll at a point in it.
Each action returns a fresh screenshot when Screen Recording allows it, so the agent sees the
result before its next step. A point from an older screenshot, or from a window that has since
moved, is refused rather than clicked.

## Turn it on

Open **Settings → Integrations → Computer use** and choose:

- **Observe only**: agents can list windows, read a window's controls and take screenshots.
- **Observe and control**: agents can also act on what they observed.

The setting belongs to the environment, so it applies to the machine that runs that server, even
when you are connected from another device. Turning it off stops computer actions at once. Any
change reaches a thread at its next message: ViewCode restarts that thread's agent session first,
keeping the conversation, and notes the restart in the thread.

On macOS, grant ViewCode **Accessibility** in **System Settings → Privacy & Security** for
reading and controlling windows, and **Screen Recording** for screenshots. The settings section
checks the permission fresh each time it opens; use **Check again** after changing it. Development
builds are ad-hoc signed, so macOS can forget the grant after every rebuild even though the switch in
System Settings still looks on. Remove ViewCode from the list and add it again.

To see what agents have done, open **Recent actions** in the same settings section. It lists the
last 100 computer actions on that machine, newest first, with the command, how it ended and
whether it took your focus. It never includes typed text, labels or window contents, and a server
restart clears it. **Getting started** in the same section repeats these steps.

## Approvals

Observing never asks. With **Observe and control**, **Ask before computer input** in the same
settings section decides when an input action asks for your approval in the conversation. The
prompt shows the app, the window and the control it will act on. Text the agent wants to type is
counted, not shown.

- **Follow thread permissions** (default): in **Full access** threads, routine actions run without
  asking; in every other mode, each input action asks. **Allow for the rest of this turn** covers
  routine actions until the current turn ends.
- **Only for risky actions**: only input that looks destructive asks, in any permission mode. That
  means controls labeled delete, send, submit, purchase or sign out, and shortcuts that quit or
  close windows. The check reads the control's label, so treat it as a safety net rather than a
  guarantee.
- **Never**: agents act without asking. Use it only when you trust what the agent is doing.

Whichever you choose, the safety floor stays. Password managers such as 1Password, NordPass and
Bitwarden, Keychain Access, System Settings, ViewCode itself and the app or terminal that started
ViewCode can never be read or controlled by an agent. Screenshots are refused while a password
manager or System Settings window overlaps the window being captured. While any approval in the
environment is waiting for you, agents cannot send input at all, so an agent can never answer an
approval for itself, whether in ViewCode, in a browser tab showing ViewCode or on a mirrored
screen.

**Show on screen** in the same section decides whether agents may bring windows to the front.
With **Whenever needed** (default) they do so for clicks, keyboard shortcuts and typing. With **Ask
once per task**, the first such action in a response asks whether to show the task on screen or
keep it in the background; in the background the agent can only act on controls by reference and
take screenshots until the response ends.

When an action needs the window in front, such as a click, a keyboard shortcut or typing into
whatever has focus, it waits while you are using the mouse or keyboard. The agent tries again a
moment later, so it does not fight you for the screen. Actions by reference in the background
go ahead.

When computer use is on, a provider's own prompt to run a plain `viewcode-computer` command, such as
listing windows or taking a screenshot, is approved for you, so it does not stack a second prompt
on top of the ones above. Agents are told to run it by the full path ViewCode installed it at, and
only that path is approved this way, so a same-named program in your project cannot borrow the
approval. Other commands still ask as usual.

These rules apply to `viewcode-computer`. macOS grants Accessibility and Screen Recording to
ViewCode as a whole, and programs an agent starts from its shell run as part of ViewCode, so an
agent with **Full access** to the shell could reach those permissions another way. Turn the
permissions off in System Settings when you are not using computer use.

## Limits

- Clicking at a point, keyboard shortcuts, typing into whatever has focus and scrolling bring that
  window to the front, because the system delivers that input to whatever is on top. So does an
  action by reference on a control that cannot be pressed or typed into directly, or on a field
  that ignores the change, as some web page fields do.
- Screenshot-based actions need Screen Recording; without it agents can only act on controls by
  reference.
- Codex in a sandboxed permission mode may be unable to reach ViewCode from its shell. Use
  **Full access** for those threads.
- Screenshots work for windows that sit entirely on the main display.
- Agents only see windows on the current desktop. To let an agent work in an app on another
  desktop (Space) or in full screen, bring its window onto the desktop you are using.
- Computer use runs on macOS and Linux. Windows is not supported yet.
- Command Code does not support computer use.

## Beta status

Computer use is in beta. Tested on a real Mac: listing windows, reading controls, pressing and
typing by reference, controls in Chrome pages, long typing, drags, approvals and the pause while an
approval waits, and the handling of apps on other desktops.

Known gaps:

- An open menu may be missing from a screenshot. Bring the app to the front, open the menu again
  and take a new screenshot.
- Windows on other desktops (Spaces) and full-screen apps cannot be reached; there is no "switch
  to" yet.
- Claude and Antigravity open their own screenshots without asking. Codex, Cursor, Grok and
  OpenCode may ask for approval first.
- Not yet confirmed on a real Mac: typing stopping when you switch apps mid-way, the wait while you
  use the mouse or keyboard, **Show on screen**, and the second Dock icon some setups show while
  computer use runs.
