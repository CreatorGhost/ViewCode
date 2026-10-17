# Working on ViewCode

Read `AGENTS.md`, [ViewCode decisions](internals/viewcode.md), and the relevant
[orchestration v2 docs](orchestration-v2/README.md) before changing the server.
ViewCode is a T3 Code fork. Preserve its name, theme, app identities, provider
choices, agent tools, and existing mobile screens.

## Staying mergeable with upstream T3 Code

ViewCode follows upstream by **ordinary Git merges again**. The v2 port merges
upstream `13aa882c22d584de5388dfce3b3ca413387ba059` (0.1.0). The earlier common
base was `024d49520`; the intervening cherry-pick policy is retired. Check the
actual graph with `git merge-base HEAD upstream/main` before the next update.

```sh
git fetch upstream main
git switch -c viewcode/upstream-update dev
git merge upstream/main
```

Use a review branch; do not merge into `dev` or publish a release without the
owner's instruction. Resolve orchestration conflicts against upstream's native
`apps/server/src/orchestration-v2/`, provider packages, and shared client runtime.
ViewCode extensions live in small modules with thin integration hooks. Keep
upstream names and layout; wire contracts gain optional fields. Theme work uses
tokens and UI variants. Hide excluded upstream features behind flags rather
than deleting their implementations.

The old ViewCode v1 services are reference material, not an alternative runtime.
Do not revive their command union, adapters, projector, or turn reactor to make
a feature compile. Use native commands, events, receipts, thread lineage,
delegated tasks, context handoffs, and runtime requests.

### Database compatibility is part of every merge

Upstream owns `effect_sql_migrations`. ViewCode owns
`viewcode_sql_migrations`, starting at fork id 1. Never add a fork migration to
the upstream ledger. Before upstream validates migrations, the one-time repair
moves only the six known released ViewCode names at ids 55–60 into fork ids
1–6, preserving timestamps in one transaction. Unknown names must cause a
reviewable failure, never a blanket deletion of ledger rows.

The first v2 launch copies `state.sqlite` to `statev2.sqlite` once. Lazy import
must preserve ViewCode metadata as well as upstream fields. In particular, test
parent lineage, side-chat kind, goals, debug mode, project color and PR watch.
A second launch must preserve changes made in v2. See
[thread migration](user/thread-migration.md) for what conversation history keeps
and loses. Never run a development server against the user's live userdata.
Use the `VACUUM INTO` procedure in `AGENTS.md`, copy secrets only when needed,
and keep the original backup untouched.

### Integration checks that matter

Use focused behavior tests and targeted typecheck/lint, never repo-wide checks.
For cross-cutting changes, cover web, desktop's web wrapper, mobile, MCP and
scheduled-agent paths. Both ends of the socket speak
`ORCHESTRATION_PROTOCOL_VERSION = 2`.

Account routing needs two different accounts and a repository the default
account cannot see. Check SSH aliases as well as ordinary GitHub remotes. Pin
one credential for the entire operation; never switch global `gh` auth state.
Provider/account switching must use the native handoff engine and must not
reuse another account's resume handle.

An automated test passing is not visual verification. Follow the app/mobile
skills for an integrated UI pass when the owner authorizes it, against isolated
state. Do not claim screenshots, provider turns, simulator results, or external
API behavior that were not actually observed.

## Product decisions to preserve

- Child agents use native delegated tasks and their own worktrees. ViewCode
  adds messaging, control queues, the sidebar tree and side chats.
- Provider and model switches use upstream portable handoffs. ViewCode adds
  mid-chat account changes and provider-neutral goals/debug guidance. Hide the
  upstream native `/goal` UI so there is one goal feature.
- Keep ViewCode agent PR reviews, findings, Fix with agent, review CLI,
  collapsible project groups and automatic GitHub account routing. Upstream's
  guided review, guides and quick actions complement those features.
- Admin provider policy wins over project toggles. Keep the first-run provider
  gate, Command Code, Droid, Devin and Pi; include upstream Muse.
- Mobile uses protocol 2 and shared native runtime, with ViewCode's existing
  screens. Do not take the upstream navigation redesign, iPad columns, tab bar,
  Enriched Markdown, native segmented controls or offline PR redesign.
- Hide doctor and its prompts, Settings command installation, Nightly/Discord/
  beta notices, T3 Connect promotions and anonymous-usage onboarding text. Keep
  ViewCode's `vc/` generated branches and product/package identities.

## References and operating constraints

[ViewCode decisions](internals/viewcode.md) records the durable constraints and
new feature homes. [Droppy look](design/droppy-look.md) remains the visual
reference. Managed-machine work starts with
[managed macOS](operations/managed-macos.md) and its linked experiments; a
managed provider policy must not be bypassed by a new adapter or setup flow.

Droppy Code is an MIT-licensed visual reference:
https://github.com/kalki-kgp/droppy-code. MonoCode and Traycer supplied handoff
and agent ideas. T3 Code upstream is https://github.com/pingdotgg/t3code. Retain
upstream license and attribution files when updating the fork.
