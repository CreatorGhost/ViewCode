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

- Restore every deleted ViewCode test, or say in the PR why its behaviour is gone on
  purpose.
- Review each listed file against `git diff <base> <P> -- <file>`, starting from the
  top of the list. Treat a large missing count on a file upstream rewrote as a lost
  fix until shown otherwise.
- A fix you restore gets a guard in a `*.viewcode.test.ts(x)` file beside the code.

## Test

```sh
vp run test:viewcode                   # every *.viewcode.test.* guard, from the root
```

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
- Mobile against the merged server.

## Write it up

The PR names P, the upstream commit, the check's deleted-test list with what happened
to each, the files reviewed, and which ViewCode fixes were confirmed by guard tests or
by hand.
