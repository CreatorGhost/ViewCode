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

To add projects, T3 Code lists directories that Claude Code or Codex has used.
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
pick Claude Code and Codex conversations from the last 30 days. Nothing is
checked for you. Sub-agent runs, sessions another agent started, and short
fragments are hidden; select **Show hidden** to see them with the reason.
Sessions you already imported are marked **Imported**. You can continue
imported conversations in T3 Code.

To clean up, select **Remove imported sessions…** in the same menu. Imported
threads you have not continued are checked; confirming archives them. Restore
archived threads from **Settings → Archive**.

Import is best effort. T3 Code keeps the first user prompt and the newest
remaining visible user and assistant messages, with 200 messages total. It
omits tool activity and attachments. For Codex, it omits generated setup
context only when a canonical user event and a valid shared turn ID identify the
same user turn. Ambiguous legacy or response-only context stays in the imported
conversation so T3 Code does not remove user text. It reads one conversation at
a time and skips files larger than 16 MiB. It ignores malformed records and
skips unreadable or unparseable conversations. Each listing reads up to 100
conversation files per project.

You can continue without configuring agents or adding projects, or return to an earlier step
using the setup progress bar. Navigation pauses while projects are being added.
