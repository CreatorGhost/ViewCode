/**
 * The method a thread follows in debug mode. Every turn carries the short note below; the
 * playbook it points to holds the whole method. Written to the state directory on use, beside the
 * review playbooks and for the same reason (see `ReviewPlaybook.ts`): the agent's shell must be
 * able to read it in dev, `dist`, the desktop app and the single executable alike.
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const PLAYBOOK_DIR = "review-playbooks";
const FILE_NAME = "debug-mode.md";

/** The few lines every debug-mode turn carries, whichever provider runs it. */
export const DEBUG_MODE_NOTE = `Debug mode is on for this thread: work from evidence, not guesses.
1. Reproduce the problem first and note the exact steps and output. If you cannot, say what you need from the user.
2. Gather logs, errors and stack traces before reading theories into the code.
3. List the plausible causes, then test them one at a time, cheapest first.
4. Do not change code to fix it until the evidence shows the cause.
5. Report the evidence: what you ran, what you saw, and what it rules in or out.`;

const DEBUG_PLAYBOOK_MARKDOWN = `<!-- ViewCode debug playbook. The idea of an evidence-first debug mode comes from Synara (MIT). -->

# ViewCode debug mode

The user switched this thread into debug mode. Find the cause of the problem from evidence before
changing anything. Debug mode grants no extra access: the thread's permissions are unchanged.

## 1. Reproduce

- Restate the symptom in one sentence: what happens, and what should happen instead.
- Reproduce it with the smallest command, test or request you can. Record the exact steps and the
  output. A failing test that shows the bug is the best reproduction.
- If it needs something only the user can do (a device, an account, a browser session), give them
  exact steps and say which output you need back, then stop and wait for it.
- If it does not reproduce, say so plainly and list what differs between your setup and theirs.

## 2. Gather evidence

- Read the logs, error messages and stack traces in full before reading code for theories.
- Check what changed recently (\`git log\`, \`git diff\`), the versions in use, and the configuration.
- Note facts and guesses separately. A guess is not evidence until a check confirms it.

## 3. Form hypotheses

- List the plausible causes, each with the observation that would confirm or rule it out.
- Order them by likelihood and by how cheap they are to check.

## 4. Test one at a time

- Change one thing per experiment: add a log line, a breakpoint, a narrower test, a bisect step.
- Write down each result and what it ruled in or out before running the next one.
- Remove temporary logging and probes when you are done with them.

## 5. Fix only a proven cause

- Do not edit code to fix the problem until the evidence shows the cause. A fix that makes the
  symptom go away without an explanation is a guess.
- Fix the smallest root cause, not the symptom. Add a regression test where practical.
- Run the reproduction again and confirm the original symptom is gone.

## 6. Report

- What you reproduced and how, the evidence you gathered, the cause and how it was shown, the fix
  (if any) and how you verified it.
- When you are blocked, report what you inspected, what you found, what is still uncertain and the
  next concrete step.
`;

/**
 * Writes the playbook into the state directory when it is missing or out of date and returns its
 * absolute path. Turns start concurrently, so a changed file is swapped in by rename.
 */
export const ensureDebugPlaybook = Effect.fn("DebugPlaybook.ensure")(function* (input: {
  readonly stateDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join(input.stateDir, PLAYBOOK_DIR);
  const target = path.join(dir, FILE_NAME);
  const current = yield* fs.readFileString(target).pipe(Effect.orElseSucceed(() => undefined));
  if (current === DEBUG_PLAYBOOK_MARKDOWN) return target;
  yield* fs.makeDirectory(dir, { recursive: true });
  const now = yield* Clock.currentTimeMillis;
  const temporary = `${target}.${process.pid}.${now.toString(36)}.tmp`;
  yield* fs.writeFileString(temporary, DEBUG_PLAYBOOK_MARKDOWN);
  yield* fs.rename(temporary, target);
  return target;
});
