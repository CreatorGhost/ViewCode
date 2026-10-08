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
- In a sandboxed permission mode, Codex's sandbox blocks `viewcode-computer` from reaching
  ViewCode, so the agent reruns it outside the sandbox and ViewCode approves that for you. If it
  still cannot connect, use **Full access** for that thread.
- On macOS, menu bars and open context menus can appear as their own entries. Choose items by
  reference when they are listed. Some apps do not expose them, so use another control or show
  the app on screen when the task allows it. Clicks and keys on a listed menu are refused,
  because bringing the app forward could close it.
- Screenshots work for windows that sit entirely on the main display.
- A window on another desktop (Space) or in full screen can be read by reference where it is,
  but an agent has to switch to it before taking a screenshot or clicking. Switching takes the
  screen like any other action in front, and asks first when your settings ask for input. Some
  apps only list windows on the current desktop; bring those onto the desktop you are using.
- Computer use runs on macOS and Linux. Windows is not supported yet.
- Command Code does not support computer use.

## Beta status

Computer use is in beta. Tested on a real Mac: listing windows, reading controls, pressing and
typing by reference, controls in Chrome pages, long typing, drags, approvals and the pause while an
approval waits, and the handling of apps on other desktops.

An experimental macOS background mode is available when the environment starts with
`VIEWCODE_COMPUTER_BACKGROUND=1`. For inactive windows it tries clicks, scrolling and supported
shortcuts without activating the app or moving your pointer. It refuses a post when a fresh
control read shows no change. Check the intended result before retrying: an uncertain refusal
may have sent input. Shortcuts require one document window. Drags, pointer moves and typing
without a ref still need an explicit focus action, allowed by **Show on screen**. This mode is
opt-in and uses undocumented window-routing fields that may change with macOS updates.
Background synthetic input is not yet confirmed across apps; today's default stays the same.
On desktop hosts this experiment also shows a separate agent pointer with the thread's name.
It does not accept clicks or keyboard focus, and hides when idle. Its full integration with
computer actions still needs confirmation in a ViewCode desktop build.
The separate pointer's idle cleanup has been confirmed on a Mac.

Known gaps:

- An open menu may be missing from a window's screenshot; the agent reads and captures the menu
  itself instead.
- Switching to a window on another desktop or in full screen: still unconfirmed on a real Mac.
- Menu bars now list and read on a real Mac through public accessibility APIs. The menu bar
  itself cannot be captured. A large or incomplete menu tree can still refuse a background
  press; opening and capturing separate menus remains unconfirmed.
- Opening screenshots without a prompt in Cursor, Grok and OpenCode: still unconfirmed.
- Foreground typing stopping when you switch apps mid-way: covered by tests, still unconfirmed
  on a real Mac. Typing by reference can continue in its target without taking the screen.
- Waiting while you use the mouse or keyboard: covered by tests, still unconfirmed on a real Mac.
- **Show on screen**: covered by tests, including refusal of a foreground fallback after choosing
  to keep a task in the background. The real desktop prompt still needs confirmation.
- The extra Dock icon: JXA helpers request background-only activation. The driver's opt-in Helper
  host and its permissions still need a desktop check before the host default can change.
