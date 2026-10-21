---
name: upstream-merge
description: Merge upstream T3 Code into ViewCode without silently losing ViewCode fixes. Use when asked to merge upstream, pull upstream, sync with T3 Code, update to a new T3 Code release, or review such a merge.
---

# Merge upstream T3 Code

Follow [docs/operations/upstream-merge.md](../../../docs/operations/upstream-merge.md)
step by step. It is short; read all of it before starting.

- Merge on a branch, never on `dev`. Record P (`git rev-parse HEAD`) before merging.
- Resolve conflicts, commit the merge, then run `vp run upstream-merge-check`.
  A non-zero exit means the merge deleted a ViewCode test: restore it, or justify it.
- Review every listed file against `git diff <base> <P> -- <file>`, largest missing
  count first. A file upstream rewrote is where fixes vanish without a conflict.
- Run `vp run test:viewcode` and the changed packages' tests and typecheck. No
  repo-wide runs.
- A ViewCode fix you restore gets a guard in a `*.viewcode.test.ts(x)` file beside it.
- Smoke-test the listed fragile areas only when the user agrees to running a dev
  server; otherwise list them as unverified.
- Do not push or open a PR unless asked. The PR names P, the upstream commit and the
  ViewCode fixes checked.
