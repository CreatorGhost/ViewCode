# Working with threads

Use a new thread for a separate task. Choose **New worktree** when its code changes
need a separate branch and working directory.

## Start a thread

On web and desktop, a new thread keeps the current project and carries your model
and mode selections, unless the destination project has its own model default.
Its branch and workspace mode come from your configured defaults. To continue in
an existing worktree, use **New thread in this worktree** from the branch toolbar.

When you change a new thread's project, ViewCode stays in the current environment
if that project exists there. Otherwise it selects an environment that has it.

The **New** menu at the top of the sidebar starts a **New chat** (Shift-click it to start in
the current project), a **New folder** (a new Git project from a name, on servers set up for
that), or **Add project** for an existing folder or a clone.

### Start without a project

A thread does not need a project. To start one without a project, click **or
start without a project** under a new thread's heading, pick **No project** from
the project menu in that heading or from **New thread in...** in the command
palette, or press `mod+alt+n`. On mobile, pick **No project** from the project
list. It starts on your current machine; before sending, pick another machine
from the machine menu to move it there. To move a draft into a project, pick the
project in the heading.

Each thread without a project works in its own folder under `~/.viewcode/scratch` (the
`scratch` folder of your ViewCode home), named after its date, the first words
of its first message, and a short id, like
`2026-09-25-convert-these-pngs-to-webp-a1b2c3d4`. Deleting a thread keeps its
folder, so the files the agent wrote stay until you delete them. Branch, worktree, and diff controls stay hidden because
these folders are not Git repositories. This is unavailable when the data
directory itself sits inside a Git checkout.

### Start in the background

In a desktop browser or the desktop app, press `Cmd+Enter` on macOS or `Ctrl+Enter`
on Windows and Linux to start a new thread and immediately open another draft. The
next draft keeps the workspace mode and base branch you selected. With **New
worktree**, each background submission creates its own worktree.

To send the same prompt to several models on web or desktop, **Shift-click** models
in a new thread's model picker to add or remove them. A regular click returns to a
single model. Choose a base branch and send. Each selection starts a separate thread
and worktree while you stay in the new thread composer. This requires a Git project.

## App rail and open-thread tabs

On web and desktop, a slim rail at the far left stays visible even when the thread sidebar
is collapsed. Its top lists your projects: click one to show only its threads in the sidebar
and open your work there (the thread you last viewed in it, else its most recent thread, else a
new thread). Picking a project from the sidebar's project menu does the same. Click **All
projects** to show everything again. While one project with a colour is shown, the rail,
the sidebar, the open thread's row and the composer's glow take on that colour; turn this off
in **Settings → Appearance → Project colour**. An amber count marks a project with
threads waiting for your approval or input, and a small dot one with threads working. Its
bottom holds one ring per enabled provider account in the environment of the open thread
(your local environment when no thread is open). A ring shows how much of that
account's most constrained usage limit is left (green, blue, amber, red as it runs out); hover
it for every limit and its reset time, or click it to open **Usage**. Below the rings are
**Settings**, **Pull Requests** (when the environment supports them), and **Connect phone**. On
a phone these stay in the sidebar sheet.

Once you have opened a second thread, tabs appear above the chat. Click a tab to switch,
click its **x** or middle-click to close it. Tabs are remembered per environment. Hold
`Ctrl` and press `Tab` (`Shift+Tab` to go back) for a list of recent threads; release
`Ctrl` to switch. `ctrl+pagedown` / `ctrl+pageup` move between tabs and `mod+alt+w`
closes the current one; all three are in the command palette and can be rebound in
[Keybindings](./keybindings.md). A tab carries the same status marks as its sidebar row (a
hand when the thread needs your approval or input, a spinner while it works, an alert when it
failed), and a child agent's tab names its lead first, such as `Printer Setup › sol-tuning-api`.

Hovering a thread row shows its status and last activity, branch, model, and linked pull
requests; hovering a project header shows its path and thread count.

## Pin and reorder threads

Pin a thread from its menu to keep it above your active work.

On web and desktop, unpinning, settling, snoozing, and archiving a thread each show
a notification with **Undo** for five seconds. Undo restores the thread's previous
state, including its pinned position, and reopens an archived thread you were
viewing. Discarding an unsent draft from the sidebar works the same way: Undo brings
back its text and attachments. `mod+z` triggers the most recent Undo when no text field is focused; see
[Keybindings](./keybindings.md#commands-with-special-behavior).

On web and desktop, you can also drag files from your computer onto any thread row:
the thread opens and the files are attached in its composer, ready for
your next message. The same per-message file limits apply as when attaching
files directly; see [Attach files](./composer.md#attach-files).

On web and desktop, pinning or unpinning a thread keeps the sidebar at your current
scroll position instead of following the thread to its new place in the list.

Pinning does not prevent automatic settlement. Settling a thread removes its pin.

On web and desktop, drag a thread between sections to change its state. Drag a thread up into
the pinned section to pin it at the spot you drop it; drag a pinned thread down into the active
list to unpin it. Dragging a thread onto the **Settled** header settles it, and dragging a settled
thread into the active list un-settles it. A snoozed thread can be dragged out of the snoozed
shelf, which wakes it, but threads cannot be dragged into the shelf because snoozing needs a wake
time. Dragging a pinned thread out of the pinned section does not ask for unpin confirmation.
Pinned and active boundary labels appear only while dragging, without moving the rows. The
other rows slide aside to show where the thread will land. When you cross into another section,
the dragged thread shows the action the drop performs, with its icon: **Pin**, **Unpin**,
**Settle**, **Un-settle**, or **Wake**. Its status and hover actions hide during the drag. A pinned
thread keeps its pin only while it stays in the pinned section; once it leaves, the badge takes
over. Reordering within the same section shows no badge. When there are no pins, drag to the top
edge to pin a thread. Section labels stay readable for the whole drag, and the section the
thread is over takes the accent color. Section labels also
identify empty sections and a collapsed settled shelf.

Drag within the pinned or active section to change its order. Other rows slide aside to show the
spot where the thread will land. Drops into either section keep the position you choose. On
mobile, open a thread's menu and choose **Arrange threads**. Drag a handle within or between
**Pinned** and **Active** to reorder, pin, or unpin. Drop onto the **Settled** divider to
settle a thread. The dragged card shows the action before you release it. Expand **Snoozed**
or **Settled** to drag a parked thread back into either live section. Each drop saves; **Done** returns to the thread list.
**Move up** and **Move down** are also available in the thread menu. The server
saves the order, so it survives a refresh and appears on your other connected devices.

On web and desktop, the list also animates section changes made with thread actions such as
**Pin**, **Settle**, and **Snooze**. These transitions respect your system's reduced-motion
preference. While dragging, rows follow the insertion gap without replaying a second transition
after the drop.

New threads appear above the active threads you have arranged. Until you arrange the list, a
thread you send a message to also moves to the top; once you have dragged or moved threads, they
keep the positions you gave them. Settling clears a thread's active position, so using
**Un-settle** returns it to the top. Pinning and snoozing preserve its active position until you
move it again. An agent working in a thread does not change the order. The settled shelf continues
to use settlement time.

If dragging is unavailable for one environment, update the ViewCode server running in that
environment. Pinned and active reordering require server support. Threads from older servers keep
their default order until the server is updated.

To generate a fresh title from the conversation, open a thread's menu and choose
**Regenerate title**. The action is unavailable while title generation is in progress
or when the connected environment needs a server update.

Agents connected through ViewCode can use the same server-owned metadata workflow to
rename a thread, regenerate its title, or link and unlink a pull request. These changes
appear on web, desktop, and mobile without requiring the originating browser to remain
open.

### Fold working threads (beta)

Turn on **Settings → General → Working section (beta)** on web and desktop, or **Settings →
Thread behavior → Working section** on iOS and Android, to move threads that are working or
monitoring into a collapsed **Working** section below the active list. A thread returns to the top
of the active list when it finishes, fails, or needs an approval or answer. The Working section
lists the thread you last sent work to first. Pinned threads stay in the pinned section. Each
device keeps its own choice.

While this is on, the active list is ordered by when each thread last came back to you, so you
cannot drag or move threads within it. Your saved order returns when you turn it off.

## Settle finished work

Choose **Settle thread** from its menu to move finished work out of the active list
without deleting the conversation. **Un-settle thread** restores it to active work
and prevents automatic settlement until new activity resumes the usual rules.
Manually settling an idle thread dismisses unanswered async questions without
sending an answer or restarting the agent. Settling also closes the thread's
terminals that wait at an idle prompt, and keeps their output. A terminal that
runs a command, such as a dev server, stays open.

To reclaim disk space from settled work, turn on **Run in the thread's worktree when the
thread settles** for one of the project's actions, or set `"runOnSettle": true` on a
`t3.json` script, for example `cargo clean`. It runs each time a thread in its own
worktree settles, manually or automatically, even if a terminal there still runs a
command such as a dev server. Threads in the project's main checkout skip it. Its terminal
closes when the command succeeds and stays open when it fails.

On web and desktop, press a thread's **Settle** button and drag up or down to
settle every thread in that section between it and the one you release on.
The **Un-settle** and **Wake** buttons work the same way in their sections.
Press `Escape` while dragging to cancel.

By default, environments settle inactive threads after three days and settle
threads whose pull request merged. A closed pull request can also settle an idle
thread. Work in progress, pending questions or approvals, and live background work
prevent automatic settlement. An open pull request does not prevent inactivity
settlement unless you turn on **Keep threads with a PR** in **Settings → General**,
but an old closed or merged pull request does not settle work you
resumed after it closed. Only your own messages count as resuming. A turn that
finished background work or a pull request watch starts on its own does not.

In the project-folder sidebar, settled threads collapse into one **Settled · N** row at the
bottom of their project. Click it to show them; they appear dimmed with the time since they
settled, and the sidebar remembers whether each project's row is open. A settled thread moves
back up on its own when you send it a message or it starts working again. A thread and its child
agents stay together: the lead thread decides where the group sits, so Settle and Un-settle are
offered on the lead's menu. Right-click a thread to choose **Settle thread** or **Un-settle
thread**. Opening a settled thread, for example from search, opens its project's Settled row.

Threads waiting on your approval or input gather under **Needs you · N** at the top of their
project, together with their lead thread and its other agents, and return to their usual place
once you answer. Pinned threads stay in the pinned list.

Child agents fold under their lead thread, which shows how many are working, need you, failed
or are done. They open while you are in that thread or one of its agents, and when an agent
needs your approval or input; moving to another thread folds them again. Click the counts to
open or close them yourself. An open thread lists its agents under **Working**, **Needs you**
and **Failed**, newest first, with finished ones folded under **Done (N)**; each shows how long
it has run, what it is waiting for, or when it finished.

To order a project's threads and agents differently, open the project's menu and choose **Sort
chats and agents**: **Status** (the default, described above), **Recent** (latest activity
first) or **Name**. The sidebar remembers the choice per project. On mobile, long-press the
project's header to pick one.

Under the search field, a row counts the threads and agents that **need you**, are
**working**, or finished since you last opened them (**new**). Click one to show only those, with
the threads they belong to, and **Clear** to show everything again.

To keep one thread out of the settled shelf no matter how long it sits idle, open its menu,
choose **Auto-settle behavior**, and pick **Disabled**. The current option is checked. Pick
**Enabled** to return to the usual rules. Manual settle, snooze, and archive still work while it
is disabled.

Change these rules in **Settings → General** on web and desktop, or **Settings → Thread behavior** on mobile.
They continue to run when your apps are closed. On web and desktop, choose an environment at the
top to change only its rules, or **All environments** to update connected environments together.
Mixed values show where the selected environments disagree. Mobile applies these
rules to connected environments that support shared settings. Offline environments
and older servers keep their previous values. Changing a rule does not reopen
already settled threads.

## Link a pull request

The server finds the PR for each unsettled thread's saved branch, even when your
apps are closed. Settled threads keep their saved links. Update the server if
automatic branch links do not appear.

On web and desktop, right-click a pull request link in a thread and choose
**Link to thread** to select a different PR. Use **Unlink from thread** on the
same link to return to the branch PR, if one exists.
The linked pull request participates in automatic settlement.

## Find and reference work

To search one project, hover its folder in the sidebar and choose the search icon. Typing
narrows that project's threads, including settled threads and child agents, by title, pull
request, or message text, and opens the Settled row when a match is inside it. Press `Escape`
or the close button to clear the search. The search field at the top of the sidebar still
searches every project, settled threads included, and the shortcut at its end opens the
command palette.

On web and desktop, open the command palette with `Cmd/Ctrl+K` to search threads
across connected environments. Message search starts after two characters and
includes your messages and final agent responses.

Use **Settings → Keybindings** to find or customize shortcuts for searching files
and copying a thread reference. A copied reference uses the thread's pull request
link when available, otherwise its thread ID. See [keybindings](./keybindings.md)
for custom configuration.

## Inspect agent work

**Limited** means the provider stopped on a usage or rate limit. The conversation
keeps the provider's explanation. Retry after the limit resets, or switch to
another provider instance.
On web and desktop, press **Resume** in an empty composer to continue a limited
or interrupted turn manually.
Queued messages stay saved while the limit blocks the thread. They run after
the continuation finishes. If the queue was held by a restart, resume it then.

When the provider reports a reset time, ViewCode shows it on the thread. Enable
**Resume after usage limits** in Settings to schedule a continuation about a minute
after the reset. The host must stay awake and ViewCode must be running. You can
resume immediately or cancel a waiting continuation from its notice. On desktop,
**Keep the computer awake** can prevent sleep while a continuation is waiting.

Choose **Snooze until reset** to hide the thread until its allowance returns.
Snooze and auto-resume are independent: snooze alone wakes the thread without
sending a message; enabling both wakes and continues it. **Wake now** cancels
the snooze. Enable **Snooze limited threads** in thread behavior settings to
snooze limit stops by default. Providers without a reset time offer manual
retry and the normal snooze choices.

On web and desktop, use **Agents** to follow delegated work. To start one yourself,
open a thread's menu, choose **New child agent**, and enter its name and task.
The child uses the parent's model and its own worktree. The parent needs an active
native run or at least one finished native turn; for an empty or imported thread,
send a message first. Agents can also delegate tasks and message one another.

Child threads appear under their parent in the sidebar. Stop on a thread also
stops the subagents it delegated to. Provider-native subagents that cannot accept
direct messages are controlled through their parent; approvals and questions are
shown there.

Expand a tool call in the conversation to see its full command and output.
Summaries shorten shell wrappers and can still describe the latest call after it
finishes; the call's own result shows its status.

## Snooze until later

Choose **Snooze → Custom…** from a thread's menu to pick a date and time in your
local time zone, or a duration in minutes, hours, or days. Durations start when
you confirm; one day means 24 hours. On web and desktop, you can also snooze
several selected threads together. Choose **Wake thread** to bring a thread back early.

## Split view

Watch one agent while steering another. Right-click a thread and choose **Open in
split**, Alt+click it, run **Split with...** from the command palette, or press
`Cmd/Ctrl+\` to pair the current thread with the most recent other one (press it
again to close). Each pane is a full chat; the focused pane has a subtle ring, and
find and shortcuts act on it. Click a pane to focus it, drag the divider to resize
(double-click to reset), and use the pane buttons to swap or close. Split needs a
window at least 1024px wide and falls back to a single chat below that; opening any
thread outside the pair returns to one chat.
