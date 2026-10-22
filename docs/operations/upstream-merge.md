# Merging upstream T3 Code

Upstream merges have dropped ViewCode fixes without a single conflict: upstream
rewrote or deleted the file a fix lived in, the resolution took upstream's side,
and the test that guarded the fix went with it. A clean merge proves nothing.
Follow these steps for every merge from `upstream`.

## Merge on a branch

Never merge into `dev` directly, and do not release without the owner's go-ahead.

```sh
git fetch upstream main
git switch -c viewcode/upstream-update origin/dev
git rev-parse HEAD   # P, ViewCode before the merge: put it in the PR
git merge upstream/main
```

Resolve conflicts as [Working on ViewCode](../NEXT_AGENT.md#staying-mergeable-with-upstream-t3-code)
describes, then commit the merge.

## Check what the merge did to ViewCode

```sh
vp run upstream-merge-check            # HEAD is the merge; or --merge <M> --viewcode <P>
```

It lists test files the merge deleted, `*.viewcode.test.*` guards and ViewCode-owned
paths it touched, and every file ViewCode had changed that the merge changed, with
how many of ViewCode's lines are gone. It exits 1 when a ViewCode test file was
deleted.

CI runs the same check on every pull request that merges upstream: one of its merge
commits has a second parent on upstream's `main` that the base branch lacks. It compares
the whole PR with its base, so a test restored in a later commit counts, and fails the
`Upstream merge check` job while a ViewCode test file is still deleted.

- Restore every deleted ViewCode test, or say in the PR why its behaviour is gone on
  purpose.
- Review each listed file against `git diff <base> <P> -- <file>`, starting from the
  top of the list. Treat a large missing count on a file upstream rewrote as a lost
  fix until shown otherwise.
- A fix you restore gets a guard in a `*.viewcode.test.ts(x)` file beside the code.
- Keep GitHub Enterprise host routing and the `gh` transport fallback (`GitHubGhTransport.ts`, wrapped in `GitHubRest.ts` and `gitHubGraphQlClient.ts`), and run their guards: `GitHubGhTransport`, `GitHubRoutedSourceControlProvider` and `PullRequestService` `.viewcode.test.ts`.

## Test

```sh
vp run test:viewcode                   # every *.viewcode.test.* guard, from the root
```

CI's test jobs run the guards of every package a PR affects; running them all locally
finds a lost fix in an unaffected package too.

Then run the tests of each package the merge changed (`vp test run <files>` from the
package) and typecheck those packages. No repo-wide runs.

## Smoke-test the fragile areas

On a dev server with copied data ([Test data](../../AGENTS.md#test-data)):

- Quick connect with a long thread: it opens without a reconnect loop.
- The Usage page: Limits shows one card per provider with pace rows.
- Mid-chat handoff to another provider, and to another account of the same one.
- Child agents: create, message, stop and resume one.
- A Command Code turn.
- The composer: send, queue while busy, attachments.
- The look and the motion. ViewCode Teal is Obsidian: a raised composer card, a lifted
  panel, light sidebar type, a whisper of project colour. The sidebar and the right panel
  slide for 300 ms with their edges on the content sheet, sidebar rows glide when they move,
  and the ring beside the send button opens the context and limits card with Compact now.
- Mobile against the merged server.

## Where the look lives in upstream files

ViewCode's styling is in `viewcode-theme.css`, `viewcode-chat.css` and `viewcode-native.css`,
which upstream never has. What a merge can lose is the upstream-owned code that reaches
them: the imports in `apps/web/src/main.tsx` and `apps/web/src/index.css`, the ViewCode
Teal palette in `packages/shared/src/themePalettes.ts`, the ViewCode variants in
`apps/web/src/components/ui/button.tsx` and `popover.tsx`, the 300 ms default in
`packages/contracts/src/settings.ts`, and the sidebar, header and composer wiring in
`Sidebar.tsx`, `AppSidebarLayout.tsx` and `ChatComposer.tsx`. The `*.viewcode.test` guards
beside them fail when the imports, variants or default go; the rest shows up in the
check's missing-line counts, so review those files first.

## Write it up

The PR names P, the upstream commit, the check's deleted-test list with what happened
to each, the files reviewed, and which ViewCode fixes were confirmed by guard tests or
by hand.
