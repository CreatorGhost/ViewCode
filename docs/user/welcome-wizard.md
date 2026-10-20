# Welcome wizard

ViewCode shows a setup flow when you open a new installation or connect to the
hosted app for the first time. Existing workspaces skip this flow.

## Connect your computers

Select one or more computers to set up. If you opened ViewCode directly from a
server or the desktop app, that computer is already connected and selected.
It is identified by its name, which may differ from the device running your
browser.

To add another computer, start ViewCode there with `viewcode serve`, then use
**Add a computer** to pair with an address on your network or tailnet. For example,
run `viewcode serve --host <address>` on that computer, then `viewcode pair` to
create a pairing link. See [remote access](./remote-access.md).

Saved computers are selected by default. Uncheck any you do not want to set up;
this does not disconnect them. Continue when your selected computers are connected.
Setup offers projects to add, grouped by computer.

If ViewCode cannot confirm the workspace during startup, the setup flow shows
**Still connecting** instead of opening the app. Select **Reload** to try again.

If ViewCode cannot read your saved settings, it shows **Could not read settings**.
Select **Retry** after storage becomes available. Setup does not replace
unreadable settings with defaults.

## Connect your agents

Every provider starts off, Codex and Claude included, and stays off until you turn
it on; an off provider is never launched or checked. A new installation asks which
providers you use. Its initial discovery only checks for installed executables; it
does not launch them. Enable the providers you want there or later in
**Settings → Providers**. An IT administrator's provider policy
also applies here and takes precedence over your selection and project settings.

The same question comes back in a chat whenever the computer it runs on has no
provider turned on, even if this browser finished setup before. If you close it,
the chat shows **No AI tool is turned on** with a **Turn one on** link to reopen it.
A connection that cannot change settings only sees the notice. The mobile app shows the
same notice above the composer, and **Turn one on** lists the providers there.

Select an enabled provider's setup action to install it or sign in on the selected
computer. Other providers remain off until you enable them. Existing installations
keep their saved provider choices.

The setup terminal uses the home directory and environment configured for the
selected provider instance. Sensitive values remain redacted in Settings and
terminal metadata while the terminal process can use them.

## Start fresh, or add projects

ViewCode starts with a clean sidebar. Select **Start fresh** to skip this step.

To add projects, ViewCode lists the folders you have worked in with Claude Code,
Codex, Cursor (the editor and the CLI) or a T3 Code install on the same computer.
A Claude Code or Codex provider you turned off is not searched. Git repositories
are listed first, newest activity on top. When the remote is on GitHub, the group
shows the repository as `owner/name`. Clones with the same remote share one
group. Directories that are not git repositories sit under "Other folders".
Nothing is selected until you pick it. Linked git worktrees, Codex scratch
directories under `Documents/Codex`, and anything under `Downloads` are not
offered.

A large or malformed history can reach the scan limit. ViewCode keeps the
projects it found and warns when projects or conversations may be missing.

## Bring in past conversations

Added projects start empty. Select **Choose sessions…** beside a project to pick
the conversations to continue there, or **Done** to skip. You can do this later
from the sidebar.

## Import past sessions

Open a project's menu in the sidebar and select **Import past sessions…**. This
is the same list **Choose sessions…** opens:

- **Claude Code, Codex and Cursor**: sessions from the last 60 days in that
  folder, from both the Cursor editor and the Cursor CLI.
- **T3 Code**: every thread of the matching T3 Code project, whatever its age.
  A thread that ran Claude or Codex continues that same session; any other
  thread continues with a recap of the conversation. If your T3 Code version is
  not supported, ViewCode says so and lists nothing from it.

Listing and importing only read this history, so the other apps can stay open.

Nothing is checked for you. Sub-agent runs, sessions another agent started,
short fragments, and Claude or Codex sessions a T3 Code thread already carries
are hidden; select **Show hidden** to see them with the reason. Sessions you
already imported are marked **Imported**, and importing one again changes
nothing.

Import is best effort. ViewCode keeps the first user prompt and the newest
remaining user and assistant messages, with 200 messages total. It omits tool
activity, terminal output, checkpoints and attachments; a message that had
attachments says so.

To clean up, select **Remove imported sessions…** in the same menu. Imported
threads you have not continued are checked; confirming archives them. Restore
archived threads from **Settings → Archive**.

You can continue without configuring agents or adding projects, or return to an earlier step
using the setup progress bar. Navigation pauses while projects are being added.
