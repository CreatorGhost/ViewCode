# Computer use

Computer use lets an agent see the apps open on the machine that runs the environment server and,
if you allow it, operate them: press buttons, fill in fields, type, click, drag, scroll and send
keyboard shortcuts. Agents reach it through the `viewcode-computer` command, which ViewCode puts on
their path, so it works with providers whose organization blocks MCP servers.

Agents work in two ways and pick per step. Where an app describes its controls to the system, they
act on a control by reference, which is exact. Where it does not, such as a 3D slicer's canvas, a
game or a web page, they take a screenshot, look at it and click, drag or scroll at a point in it.
Each action returns a fresh screenshot, so the agent sees the result before its next step. A point
from an older screenshot, or from a window that has since moved, is refused rather than clicked.

## Turn it on

Open **Settings → Integrations → Computer use** and choose:

- **Observe only**: agents can list windows, read a window's controls and take screenshots.
- **Observe and control**: agents can also act on what they observed.

The setting belongs to the environment, so it applies to the machine that runs that server, even
when you are connected from another device. It takes effect for new agent sessions; to apply it to
a running thread, choose **Restart agent session** from the command palette.

On macOS, grant ViewCode **Accessibility** in **System Settings → Privacy & Security** for
reading and controlling windows, and **Screen Recording** for screenshots. The settings section
checks the permission fresh each time it opens; use **Check again** after changing it. Development
builds are not signed, so macOS can forget the grant after every rebuild even though the switch in
System Settings still looks on. Remove ViewCode from the list and add it again.

## Approvals

Observing never asks. Every input action asks for your approval in the conversation, showing the
app, the window and the control it will act on. Text the agent wants to type is counted, not shown.
**Allow for the rest of this turn** covers routine actions until the current turn ends.

In **Full access** threads, routine actions run without asking. Actions on controls that look
destructive, such as delete, send, submit, purchase or sign out, and shortcuts that quit or close
windows always ask, in every mode. This check reads the control's label, so treat it as a safety
net rather than a guarantee.

Password managers, Keychain Access, System Settings and ViewCode itself can never be read or
controlled by an agent. While any approval in the environment is waiting for you, agents cannot
send input at all, so an agent can never answer an approval for itself, whether in ViewCode, in a
browser tab showing ViewCode or on a mirrored screen.

These rules apply to `viewcode-computer`. macOS grants Accessibility and Screen Recording to
ViewCode as a whole, and programs an agent starts from its shell run as part of ViewCode, so an
agent with **Full access** to the shell could reach those permissions another way. Turn the
permissions off in System Settings when you are not using computer use.

## Limits

- Clicking at a point brings that window to the front, because the system delivers pointer input
  to whatever is on top.
- Screenshot-based actions need Screen Recording; without it agents can only act on controls by
  reference.
- Codex in a sandboxed permission mode may be unable to reach ViewCode from its shell. Use
  **Full access** for those threads.
- Command Code does not support computer use.
