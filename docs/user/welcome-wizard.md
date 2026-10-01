# Welcome wizard

T3 Code shows a setup flow when you open a new installation or connect to the
hosted app for the first time. Existing workspaces skip this flow.

## Connect your computers

Select one or more computers to set up. If you opened T3 Code directly from a
server or the desktop app, that computer is already connected and selected.
It is identified by its name, which may differ from the device running your
browser.

You can add more computers before continuing:

- **T3 Connect** connects computers that are signed in to your account.
  [Install the CLI](./install.md#command-line) and run `t3 connect` on each
  computer you want to add, then start T3 Code or run `t3 serve` so the
  computer stays available.
- **Add a computer** connects directly to a server on your network or tailnet.
  Start the server with `t3 serve`, then run `t3 pair --tailscale` and paste
  the pairing link. You can also run `t3 serve --host <address>` and use
  `t3 pair` when the server is already reachable on your network.

Saved computers and computers discovered through T3 Connect are selected by
default. Uncheck any you do not want to set up; this does not disconnect them.
Continue when your selected computers are connected. Setup checks
agents across the selected computers, then offers projects to add, grouped by computer.

If T3 Code cannot confirm the workspace during startup, the setup flow shows
**Still connecting** instead of opening the app. Select **Reload** to try again.

If T3 Code cannot read your saved settings, it shows **Could not read settings**.
Select **Retry** after storage becomes available. Setup does not replace
unreadable settings with defaults.

## Check your agents

T3 Code checks each selected computer for Claude Code and Codex. If an agent is
not installed or signed in, select its action to open a terminal with the
correct command ready to run. Install uses the vendor's own installer, which
keeps **Update now** working in Settings. Other providers can be enabled in
Settings.

The setup terminal uses the home directory and environment configured for the
selected provider instance. Sensitive values remain redacted in Settings and
terminal metadata while the terminal process can use them.

## Start fresh or add projects

T3 Code starts with a clean sidebar. Select **Start fresh** to skip this step.

To add projects, ViewCode lists the projects of a T3 Code install on the same
computer and directories that Claude Code or Codex has used.
Git repositories are listed first, newest activity on top. When the remote is on
GitHub, the group shows the repository as `owner/name`. Clones with the same
remote share one group. Directories that are not git repositories sit under
"Other folders". Nothing is selected until you pick it. Linked git worktrees,
Codex scratch directories under `Documents/Codex`, and anything under
`Downloads` are not offered.

A large or malformed history can reach the scan limit. T3 Code keeps the
projects it found and warns when projects or conversations may be missing.

Adding a project does not bring in its past conversations. After adding, select
**Choose sessions…** beside a project to pick the ones you want, or **Done** to
skip.

## Import past sessions

Open a project's menu in the sidebar and select **Import past sessions…** to
pick conversations to continue in ViewCode:

- **T3 Code**: every thread of the matching T3 Code project, whatever its age.
  ViewCode reads T3 Code's data in `~/.t3` without changing it, so T3 Code can
  stay open. A thread that ran Claude or Codex continues that same session;
  any other thread continues with a recap of the conversation. If your T3 Code
  version is not supported, ViewCode says so and lists nothing from it.
- **Claude Code and Codex**: sessions from the last 30 days.

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
