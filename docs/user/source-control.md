# Source control

ViewCode integrates with GitHub, GitLab, Forgejo, Gitea, Bitbucket, Azure DevOps, and GitCafe to clone
and publish repositories, create pull requests, and review changes.

## Review turn changes

A turn's changed files and diff show only the turn's own work. When a turn pulls, merges, or
rebases, the files Git brought in are left out. A file stays in the list when the turn edited it,
committed it, or fixed a conflict in it. Use the branch comparison to review everything that changed
against your base branch. Restore still returns the complete saved workspace.

## Connect an account

Install Git and configure authentication on the machine running your ViewCode server. For a remote
environment, do this on the remote machine. After signing in, open **Settings → Source Control**
and choose **Rescan**.

### GitHub

ViewCode talks to GitHub's API directly and only needs a token. Any of these works, in this
order of precedence:

1. A token saved in **Settings → Source Control → GitHub**. It is kept in the server's secret
   store, and works without the GitHub CLI.
2. `GH_TOKEN` (`GH_ENTERPRISE_TOKEN` with `GH_HOST` for GitHub Enterprise Server) in the
   server's environment.
3. [GitHub CLI](https://cli.github.com/) 2.81.0 or newer, signed in with `gh auth login`.

If `gh` is signed in to several accounts or hosts, expand **GitHub** in the same place to pick
the account each host uses or turn a host off. A saved token or `GH_TOKEN` takes precedence
over that choice; a host turned off stays off either way.

For GitHub Enterprise, sign in with `gh auth login --hostname YOUR_HOST`. ViewCode treats a
custom server name as GitHub once it has a credential for that host.

For GitHub Enterprise Server, also run `gh auth login --hostname <your-server>`. ViewCode uses that
sign-in to recognize servers whose host name does not contain `github`.

If you work for several organizations with separate GitHub accounts, sign in to each with
`gh auth login`. ViewCode starts with the active account (`gh auth status`) and, for a repository
that account can't see, uses whichever of your other signed-in accounts can, without switching the
active account in your terminals. Pull requests show which account each project is read with. A
newly granted access or a sign-out is picked up within about ten minutes.

`git push` and clone don't follow this: they use Git's own credentials, and the helper
`gh auth setup-git` installs always pushes as the active account. Give each organization's remotes a
credential its account can push with, such as an SSH key per account chosen by a host alias
(`git@github-acme:acme/app.git` with a `Host github-acme` entry in `~/.ssh/config`).

### Forgejo and Gitea

Install [Forgejo CLI (`fj`)](https://codeberg.org/forgejo-contrib/forgejo-cli) or
[Gitea CLI (`tea`)](https://gitea.com/gitea/tea) 0.16 or later on your ViewCode server.
Sign in with `fj --host https://your-server auth add-token` or `tea login add`.
Repeat for each server you use, including Codeberg.

ViewCode prefers a matching `fj` login and falls back to `tea` when `fj` is unavailable
or has no login for that server. Once an account is selected, failed actions stay on that
account. Settings shows the detected CLI. Forgejo and Gitea share one integration entry.
Servers hosted under a URL subpath, such as `https://example.com/forgejo`, use `tea` because
fj 0.6 does not preserve the subpath when checking its account.

When cloning or publishing, use a full repository URL to select a specific server.
You can use `owner/repo` when only one fj server is configured, or with your default `tea`
login when fj is unavailable or unconfigured. With multiple fj servers, use the full URL.
If you have multiple `tea` accounts on one server, select one with
`tea login default <login-name>`. Git push and clone also need Git credentials or an SSH key
for that server.

### GitLab

Install [GitLab CLI](https://gitlab.com/gitlab-org/cli), then sign in:

```bash
glab auth login
```

For a self-managed server, run `glab auth login --hostname <your-server>`. ViewCode uses that sign-in
to recognize servers whose host name does not contain `gitlab`.

### Bitbucket

Only Bitbucket Cloud (`bitbucket.org`) is supported. Bitbucket Data Center and Bitbucket Server
use a different API, so pull requests on those servers are not available.

Open **Settings → Source Control**, expand **Bitbucket**, and choose how to sign in:

- **Access token**: a token created for one repository, project, or workspace. It can only reach
  what it was created for.
- **Atlassian account email** and **API token**: an Atlassian API token for your account. It can
  reach every repository you can. Give it read/write access to repositories and pull requests, plus
  user read access (`read:user:bitbucket`).

A field saves when you leave it, and applies right away. The access token wins when both are saved.
Credentials are saved on the environment's server, so select a remote environment to configure
it. Saved tokens can't be viewed again; enter a new one to replace it, or choose **Remove** to clear
everything saved for Bitbucket.

If no credentials are saved, ViewCode falls back to these variables in the server's environment.
Restart the server after changing them:

```bash
export T3CODE_BITBUCKET_ACCESS_TOKEN="your-access-token"
# or
export T3CODE_BITBUCKET_EMAIL="you@example.com"
export T3CODE_BITBUCKET_API_TOKEN="your-token"
```

### Azure DevOps

Install [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/), add the DevOps extension, and sign in:

```bash
az extension add --name azure-devops
az login
```

On a headless or remote server you can sign in with a personal access token instead, using
`az devops login` or the `AZURE_DEVOPS_EXT_PAT` environment variable. Settings → Source Control
then shows Azure DevOps as unverified rather than signed in, because only `az login` can be checked
without a repository; pull requests still work.

Only Azure DevOps Services (`dev.azure.com` and `*.visualstudio.com`) is supported. The Azure CLI
does not work with Azure DevOps Server (on-premises, formerly TFS), so pull requests on those
servers are not available.

## Start, clone, or publish a project

To start from nothing, choose **New project** in the command palette (`Cmd/Ctrl+K`), or
**New project** under **Add Project** on any client, and type a name. ViewCode makes a Git
repository in `~/.viewcode/projects` (the `projects` folder of your ViewCode home) with a README,
an icon, and a first commit, then opens a new thread in it. Until the project has a thread, new
threads work in its folder, even when your default is a new worktree. The folder is named after the project,
like `pinball-stats` for "Pinball Stats". Turn on **Create private repository on GitHub** to also
publish it. If Git has no name or email on that machine, the project is created without the
first commit.

Use **Add Project** in the command palette (`Cmd/Ctrl+K`) to clone a repository. Choose a hosting
provider or paste a Git URL, then choose where to save it. The project opens right away while the
clone runs in the background: you can write your first prompt, and sending waits until the files
are in place. A toast tracks progress and lets you cancel; if the clone fails, retry it from the
toast or from the banner above the composer.

For a local Git repository without a remote, **Publish Repository** creates a hosted repository,
adds it as `origin`, and pushes your commits. If there are no commits yet, it creates the remote;
make your first commit before pushing.

## Create a pull request

Use a thread's Git actions to commit, push, and create a pull request. ViewCode can generate commit
messages, review titles, and descriptions from your changes.

The thread's pull request then shows as a card in the chat, at the point where the thread got it,
with its state beside the composer and a short version at the top of the Review panel. The card
follows the pull request as it changes: your branch's commits against the base's commits since you
branched, which base commits conflict with yours (hover the conflict count to see the clashing
lines), each check as it finishes, and what the agent is doing while it works on the pull request.

Once a pull request is merged or closed, its card folds to one line and the composer chip goes
away. A thread that opens several pull requests shows a card for each, and only the newest open
one stays expanded. Use the chevron on a card to fold or unfold it; ViewCode remembers your choice
for that pull request.

**Resolve conflicts** asks the thread's agent to merge the base in, fix the conflicts, and push;
the card counts the conflicts down as it fixes them. **Merge** merges it on the host. Drafts and
pull requests with failing checks do not offer Merge.

The card reads commits and conflicts from the thread's checkout, against the base as the checkout
last fetched it. Conflict details need Git 2.38 or later; with an older Git the card only says that
the pull request conflicts.

The mobile app shows the same cards in the chat, without the commit map: the pull request's state,
its checks, conflicts, **Resolve conflicts** and **Merge** (after a confirmation). Merge uses the
project's default merge method, else the one you last chose on the phone, else squash, whichever
the repository allows. Folding on the phone lasts until the app restarts.

An existing fork PR can appear beside the branch even if you pushed without setting an upstream.
If its badge is missing because several remotes hold that branch, set the branch's upstream to
the intended remote with `git branch --set-upstream-to=<remote>/<branch>`.

Choose the writing style and model in **Settings → Source Control**. **Repository conventions**
uses the project's instructions and recent commit subjects.

## Review and merge

Open **Pull requests** to review changes and comments, request reviewers, check out a branch,
or merge. You can edit review titles and descriptions and your own comments where the host allows it.
GitLab calls these merge requests.

For a fork, a checkout whose `upstream` remote is on the same host as `origin`, the list shows the
fork's own pull requests and, under a separate heading marked upstream, the upstream repository's.
A repository the list cannot read is named above the list with the reason, such as no signed-in
account being able to see it or an SSH host alias that could not be resolved.

On mobile, **Pull requests** lists reviews across your connected environments. Open a review
to read its description, activity, commits, and changed files. Line comments stay as drafts
until you submit the review. **Work on PR** opens a chat with the review attached; sending
the first message prepares a worktree from the review's branch.

The ViewCode mobile app needs a connection to load or refresh pull requests and submit
changes. It does not save pull requests for offline use after restarting the app.

Enable **Remove agent credits when merging** in Settings → Source Control to remove recognized
agent co-author and generated-by lines from GitHub merge and squash commit messages. Human
co-authors stay credited. The setting is off by default and projects can override it. It also
applies to auto-merge, but not merge queues or native stack merges. Original commits keep their
messages, so merge and rebase can still retain agent credits in those commits.

On web and desktop, hold **Shift** in the GitHub pull request list for quick actions.
To close several, press **Close**, drag across the rows in the same group, and release.
Press **Escape** before releasing to cancel. Failed closes stay in the list so you can retry them.

GitHub, GitLab, and Azure DevOps support auto-merge while checks are outstanding. GitHub also
supports approving waiting fork workflows and opening a revert pull request for a merged change.

GitHub sharing is off by default. In Settings → Connections → GitHub sharing (Environments on mobile), choose
**Read PRs** or **Read and act** for each environment you trust to share GitHub access.
Enable both the original environment and the environment answering its requests on this client.
**Read and act** can use broader GitHub permissions than the original environment's credential;
only enable it for environments you control and trust. Changing a saved endpoint or removing an
environment clears its permission.

GitHub review details, linked PR status, and permitted review actions can then use another
connected environment signed in to the same GitHub account. Each needs a project on that host.
A connected local environment is preferred for actions and can answer slow or failed reads.
Browsers and mobile clients need a paired environment to use its GitHub credentials.
Credentials stay on their machines. Previously verified credentials remain usable for routing
for ten minutes during a GitHub outage; new credentials must be verified first. An action with
an uncertain result is never automatically retried elsewhere. Listings, diffs, and checkout or
PR creation from Git actions continue to use the project's environment.

For Azure DevOps, use the host website to change comments. Bitbucket does not support reopening a
declined pull request.

### Review with an agent

Choose **Review with agent...** in a pull request's actions menu to have an agent review it. Pick
**Quick review** (one pass), **Deep review** (several agents that check each other's findings), or
**Security audit**, then the model and, optionally, what to focus on. Deep reviews and security
audits run several agents and use more of your plan; they can take 10 to 20 minutes. Started from
a chat (its **Review** panel, or the pull request panel beside it), the reviewer is one of that
chat's agents: you stay in the chat, which shows the review as one block with its time, its current
step and the agents it started, and **Show findings** opens the panel. Started from the pull request
page, it runs in a thread of its own linked to the pull request, and the page's **Review** tab shows
it. It runs with your default permissions for new threads, reads the change without touching your
checkout, and posts nothing to the host unless you ask. On Android the pull request screen's header
also has a review button, which uses your default model and runs the review as the agent of the
chat you opened the screen from; the screen stays open, says the review is under way, and links to
its findings. Agents can start a review with the `review_pull_request`
tool, and review a thread's own changes with `review_local_changes`; either review runs as the
asking agent's child and changes nothing.

The **Review** panel beside a chat (web and desktop) shows the change at once, while the review
works, with how long it has run and what it is doing. Findings appear on the diff as the reviewer
verifies them, marked **Still reviewing…** until its last set arrives. While a newer review runs,
the findings still shown are marked **Earlier review** until its own arrive. The issues are listed
first, grouped by severity and naming only the file (the full path shows on hover); the panel goes
to the first one, and a row or the arrows go to the next, with each finding under the lines it is
about (findings without a place in the diff are listed under **General**). Files
without findings stay folded; **Show all files** opens them. A review that fails says why, with
**Try again** to start it again as it was asked; one that ends without findings says so, with
**Try again** too, and a running review has **Stop**. **Fix with agent** sends your chat a message
asking it to verify and fix the finding, with its lines attached: at once, or when the chat's
current step ends if it is working. **Fix all** does the same for every open finding, letting you
untick some first when there are several. The agent says which it fixed and which it skipped;
**Sent to …** on a finding shows that message. Seen from the reviewer itself, or from the pull
request page, the message goes to the chat the review was started from, else the chat working on
the pull request; with no chat at all, a new chat opens on the branch with the request ready to
send. **Dismiss** hides a finding until you show dismissed ones again, and like **Sent to …** it
stays on the finding when the review's next findings arrive. While the review works, **Post all**
waits for its final findings; a single comment can be posted at any time. To review from the panel, pick the depth, model and
focus in its empty state, or under **Find issues** for a new review. In a chat with no pull request
it reviews the chat's own changes, as does **Review my changes** in the command palette: under
**What to review**, **Auto** reads the uncommitted changes (or the branch when everything is
committed), **Uncommitted** only those, **Branch** the branch against a base you can change, and
**Commit** one commit picked from the latest ones or pasted.

With findings showing, **Find issues** can re-review them: **Changes since** reads just what was
pushed since and reports how many earlier findings were fixed and how many are still open. A
review of local changes reads the whole change again but still reports them. Thumbs up and down
rate a finding (click again to take the rating back); ratings follow you to every device, and
later reviews of the project lean away from the kinds of findings you turned down.

A fix is an ordinary message in your chat, so **Edit from here** can rewind its conversation.
Sessions started with **Fix with agent** offer **Undo review fixes** on their first message.
It restores the conversation and files only when the session owns an exclusive worktree and
its provider supports rollback. Root checkouts and worktrees shared with another thread,
including idle or archived threads, cannot use this action. The dialog explains this
restriction; review and revert those file changes manually with Git. Starting a fix session
keeps its existing checkout and pull-request branch routing, so it does not automatically
create an exclusive worktree.

In the mobile app, agent review sits at the top of a chat's **Review changes** (from the chat's Git
menu, the Git sheet or the command palette). **Find issues** reviews what the diff on screen is
about: the uncommitted changes while there are any, otherwise the chat's pull request, or its
branch against the base. The line under it says what it will read. The depth menu beside it picks
**Quick**, **Deep** or **Security** (the phone remembers your pick) and, under **What to review**,
the pull request, the current changes, the branch, or **A commit…** from the latest ones (search,
or paste a SHA). The model starts as the chat's own; tap it to pick another for this review. The
review runs as one of the chat's agents, and its findings screen opens at once and fills in as the
reviewer verifies findings. Back in the chat, the review is one agent row (**Deep review ·
Reviewing**) that opens its findings, and **Review changes** says where the latest review stands.

The findings screen shows, while the review runs, how long it has run and its agents, with **View
agent** and **Stop**; a review that failed says why, with **Try again**, and one that ended early
keeps the findings it sent. Then come the verdict, merge confidence and review effort, and the
findings grouped by severity; tap a finding for its detail and suggested fix. The phone shows no
diff, so each finding names its file and line instead. **Fix with agent** sends the request into
the chat the review belongs to, now or when that chat's current step ends, and marks the finding
**Sent to …**. **Fix all** sends a single finding the same way and lists several first so you can
leave some out. With no chat at all, a new chat opens with the request ready to send. For somebody
else's pull request, **Post comment**, **Post all** and **Post selected** (tick the findings first)
open a sheet where you choose what to submit the review as and write its overall comment before
posting; **Post all** waits for the review to finish. **Dismiss** hides a finding until you show
dismissed ones, and the thumbs tell later reviews of the project which findings helped.

For a review of somebody else's pull request the findings are review comments instead: **Post
comment** posts one, and **Post all** or **Post selected** posts several as one review, each time
after you choose what to submit it as and write its overall comment. Posted findings link to the
pull request. On GitHub they are posted on the commit the agent reviewed, so if the pull request
changed since, GitHub may show them as outdated; posting warns you when it has. You can also ask
in the chat, for example "post the blockers": the agent posts only when your own latest message
asks, never on its own or for another agent, and as a plain comment unless you say to approve or
request changes. To have the agent write them the way you do, describe your style under **Your
review style** in the GitHub entry of **Settings → Source control** (one per account; with several signed in, pick the account above it first).

On GitHub you can also let it learn from your own reviews: **Learn from my reviews** in the same
place reads up to 40 of your recent review comments and review texts from the past year, as that
account, and the agent imitates how you write them (tone, length, how you mark nits and blockers,
whether you ask or tell), not what they say. Empty, approval-only and bot-like comments are
skipped, and only repositories the account can see count. The card shows how many it learned from
and when, with a few examples; **Learn again** refreshes them and **Forget** deletes them. They stay
on the server you are connected to and reach only the reviewing agent. Your written style wins
where the two disagree. Other hosts do not offer this.

### Mark files as viewed

Tick a file off in the **Code** tab once you have read it and it collapses; the toolbar keeps a
running count. A tick belongs to the pull request rather than to a commit, so scoping the tab to a
single commit keeps them. A file pushed to after you cleared it comes back marked **Changed**.

On GitHub these are GitHub's own viewed marks, so a review carries between ViewCode and github.com
in either direction. Forgejo, GitLab, Bitbucket, and Azure DevOps expose no record ViewCode can read, so the
server you are connected to keeps them instead: they follow you across the apps connected to that
server, but the host's own site will not show them, and the count reads **viewed in ViewCode**.

On mobile, open a changed file and mark it viewed from its header. Viewed files collapse,
and their marks follow the same rules as on web and desktop.

## Troubleshooting

- **Not authenticated:** run the provider's login command on the server, then rescan. For Bitbucket,
  check the credentials saved in Settings → Source Control, or confirm the running server received
  the environment variables.
- **GitHub sign-in cannot be verified:** update GitHub CLI to at least 2.81.0, or save a token in Settings → Source Control.
- **Push fails despite a connected account:** check the Git remote's credentials. SSH and HTTPS
  remotes can require separate setup from the hosting provider's API access.
- **A review cannot load:** open it on the host website while resolving connectivity, permissions,
  or rate limits.

## Linked pull requests

A thread can hold several pull requests, including reviews from another repository on the same host.
Use **Link pull request** in the command palette or **Linked pull requests** panel, or right-click a
pull request link in the conversation. Creating a pull request from Git actions links it automatically.
Agents can link their pull requests with the `link_pull_request` tool.

Use **Link this PR** in a branch-detected badge's tooltip to keep it with the thread. From a review
on the Pull Requests page, **Link to thread** lets you search for an active thread. The review header
also lists the threads that link to it, including archived threads, so you can return to their context.

Thread badges show a stack's layer count or the current review number with a count of additional
links. Clicking a badge with more than one review opens the **Linked pull requests** panel. On
mobile, the Git overview lists linked reviews and their stacks; tap a review to open it. On Android
it opens in the app, with its checks, conflicts, reviewers and description, and an open review you
may merge has a merge button (choose squash, merge or rebase from its arrow). On iPhone it opens on
the host. Linking and unlinking are available in the web and desktop clients.

The **Linked pull requests** panel lists every review and groups stacks. Unlink a review from its
row menu. An unlinked stack layer stays out of later syncs. Open linked reviews refresh on the server;
closed reviews refresh periodically so reopening one on the host is detected. Merged reviews refresh
when requested. A settled thread's reviews stop refreshing until you unsettle it. With **Auto-settle merged threads** enabled, a thread can settle after every linked
review is terminal. An open or unsynced link keeps it active.

Ask the agent to watch, monitor, or babysit a pull request and it calls `watch_pull_request`. While
the thread is active, the server checks the pull request every two minutes and wakes the agent when a
check fails, the required checks pass, someone else comments or reviews, or the branch starts to
conflict. Threads in a project that watch the same pull request share one check. On GitHub, a check
first asks whether anything changed and reads the pull request only when it did, which keeps
watching inside GitHub's rate limit. Comments from your own account do not wake it. Watching ends
when the pull request merges or closes, after 10 wakes in a row that bring only comments, after 8
failed reads in a row, or when you press Stop on the thread. A rate limit only pauses watching.
Settling or archiving a thread also ends all its watches. Unsettle the thread before starting a new
watch. Watching a pull request again does not repeat check or conflict news its last
watch already reported; unlinking the pull request clears that. Subagents cannot watch pull requests; the thread that delegated to them does. To start or stop
it yourself, use the row menu in the **Linked pull requests** panel. In the thread details card, a
watched pull request shows an eye; click it to stop watching.

A watched thread counts as working between wakes, so it stays in the **Working** section and does
not auto-settle. Agents stop watching when they hand the work back to you, and the thread then
returns to your inbox.

Cross-repository links use a project on the same host. Azure DevOps reviews require a project checked
out from the matching organization and repository.

### Watching a pull request

Ask the agent to watch, monitor, or babysit a pull request and it calls `watch_pull_request`. The
server checks the pull request every two minutes and wakes the agent with a new message when a check
fails, all checks pass, someone else comments or reviews, or the branch starts to conflict. Comments
from your own host account do not wake it. If the agent is busy, paused, or out of usage, the update
waits until its turn ends. Watching ends when the pull request merges or closes, after 10 wakes in a
row that bring only comments, after 8 failed reads in a row, when the thread settles or is archived,
or when the agent calls `unwatch_pull_request`. A watched review shows an eye in the **Linked pull
requests** panel; use the row menu's **Watch for changes** or **Stop watching** to start or stop it
yourself. Unsettle a thread before starting a new watch on it.

## GitHub stacks

The Pull Requests page shows each PR's position in its GitHub stack. Open the stack badge in a
review to navigate its layers. **Merge stack** submits the selected pull request and every unmerged
layer below it to GitHub together, respecting branch rules and merge queues. The confirmation shows
the scope and merge strategy. GitHub rebases the remaining stack after merging.

**Rebase stack** updates remote branches from bottom to top without changing your local checkout.
It can rewrite history and restart checks. If a layer fails, earlier updates remain; resolve that
layer before retrying. GitHub may require manual conflict resolution after a lower layer is amended,
even when its changes look independent. Stack actions require an environment that supports them.
