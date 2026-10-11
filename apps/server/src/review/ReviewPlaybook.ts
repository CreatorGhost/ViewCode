/**
 * The method an agent review follows, one markdown playbook per mode. A review thread's first
 * message only names the mode, the target and the playbook's path; the method lives here.
 *
 * The text ships inside the server bundle and is written to the state directory on use, the way
 * the `viewcode-computer` launcher is (see `ComputerUseShim.ts`). A file beside the code would not
 * be readable everywhere: the single executable has no sibling files and the desktop app's bundle
 * can sit inside an asar the agent's shell cannot open. The state directory is a real folder on the
 * machine the agent runs on, in dev, `dist`, the desktop app and the executable alike.
 */
import { AGENT_REVIEW_MODES, type AgentReviewMode } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const PLAYBOOK_DIR = "review-playbooks";

export const reviewModeLabel = (mode: AgentReviewMode): string =>
  AGENT_REVIEW_MODES.find((entry) => entry.mode === mode)?.label ?? mode;

const CREDIT = `<!-- ViewCode review playbook. Adapted ideas, not files, from
SpillwaveSolutions/pr-reviewer-skill (MIT) and cloudflare/security-audit-skill (MIT). -->`;

const SHARED_RULES = `## Ground rules

- Never modify the user's working tree, index or branch. Do not check anything out, stash, reset or
  commit. Read the change with the host CLI (\`gh pr view\`, \`gh pr diff\`, \`gh pr checks\`;
  \`glab mr view\`, \`glab mr diff\`; \`az repos pr show\`), or fetch the head into a temporary ref
  (\`git fetch <remote> <head-ref>:refs/viewcode/review/<n>\`) and read
  \`git diff <base>...refs/viewcode/review/<n>\`. Delete any temporary ref when you are done.
- Collect before judging: the description, the linked issue, existing review comments, CI status
  and the full diff. Do not repeat what a reviewer already said; build on it or disagree with it.
- Read the surrounding code for every hunk you comment on. A finding needs a concrete path from a
  real caller or input to the failure. "This could be a problem" without that path is a question.
- Severity is likelihood times impact:
  - **Blocker**: a realistic input or caller breaks correctness, security or data. Must be fixed.
  - **Important**: a real defect or gap with a narrower trigger or smaller impact. Should be fixed.
  - **Nit**: style, naming, small clean-ups, and defence-in-depth gaps another layer already
    blocks.
  - **Question**: something you could not settle from the code; say what would settle it.
- Post nothing to the host (comments, reviews, approvals, labels) unless the user asks.

## Report

1. A one-line verdict: approve, approve with nits, or request changes.
2. Findings, most severe first, each as
   \`path:line — problem — why it matters — suggested fix\`, grouped under their severity.
3. **Checked and fine**: one line per area you covered and found no problem in, so the reader
   knows what the review did and did not look at.`;

const QUICK = `## Quick review

One agent, one pass over the whole change. Cover:

- Correctness: logic errors, edge cases (empty, null, concurrent, repeated, very large), error
  handling, and behaviour the description promises but the code does not deliver.
- Security smells: untrusted input reaching a shell, path, query, URL or HTML; missing
  authorization; secrets in code or logs.
- Tests: what the change touches that no test covers, and tests that assert the implementation
  instead of the behaviour.
- Performance on hot paths: extra work per request, per render or per item, unbounded growth.
- Readability where it hides a bug.

Before reporting, re-read each finding against the code once and drop the ones that do not hold.`;

const DEEP = `## Deep review

A lead agent (you) and child agents. This uses several agents and more of the user's plan.

1. **Split.** Read the change and divide it into areas a reviewer can hold at once.
2. **Lenses.** Spawn one child agent per lens with the agent tools you have (ViewCode's
   \`viewcode_spawn_agent\`; \`viewcode_list_models\` lists the choices). Give each the change's
   identifiers, the areas, these ground rules and its lens:
   - correctness and edge cases
   - security
   - performance and resource use
   - tests and behaviour coverage
   - API and contract changes, and consistency across every caller and surface
   If you cannot spawn agents, run the lenses yourself as separate passes, one after another.
3. **Adversarial verification.** Hand every candidate finding to a fresh agent (or a fresh pass)
   whose only job is to disprove it from the code. Report only findings that survive. Put the ones
   nobody could settle under **Needs checking**, with what would settle each. Drop disproved ones;
   you may list them under **Rejected**, one line each.
4. **Consolidate.** Merge duplicates across lenses, keep the strongest evidence, and write the
   report.`;

const SECURITY = `## Security audit

Scope: the change, and the code paths it reaches. This uses several agents and more of the user's
plan. Never run the target's code outside a sandbox; anything that can only be proven by running it
is marked needs validation.

1. **Reconnaissance.** Map the trust boundaries the change touches: inputs and who controls them,
   authentication and authorization checks, secrets, outbound calls, files, processes and IPC.
2. **Hunt by attack class**, across the change and the paths it reaches:
   - injection (shell, SQL, template, prompt), path traversal, SSRF
   - authorization bypass and data isolation between users, projects or tenants
   - unsafe deserialization and parsing
   - secrets in code, logs, errors or URLs; crypto misuse
   - dependency and supply-chain changes (new packages, scripts, pinned versions)
   - resource exhaustion (unbounded input, loops, retries, memory)
   - client side: XSS, \`postMessage\` origin checks, unsafe HTML
   - desktop and IPC surfaces exposed to web content or other processes
   Use child agents for the classes (\`viewcode_spawn_agent\`) when you have them; otherwise work
   through them yourself.
3. **Adversarial validation**, as in a deep review: a fresh agent or pass tries to disprove each
   candidate.
4. **Verdicts.** Each finding is **confirmed** (with a complete trace from the attacker-controlled
   source to the sink, file:line at each step), **needs validation** (with what would prove it), or
   **rejected** (one line why).

If the user has Cloudflare's \`security-audit\` skill installed, say at the end that a full
repository audit is available with it. Do not run it yourself.`;

const MODE_SECTIONS: Record<AgentReviewMode, string> = {
  quick: QUICK,
  deep: DEEP,
  security: SECURITY,
};

const FILE_NAMES: Record<AgentReviewMode, string> = {
  quick: "quick-review.md",
  deep: "deep-review.md",
  security: "security-audit.md",
};

/** The playbook text for one mode: its method, then the rules and report every mode shares. */
export function reviewPlaybookMarkdown(mode: AgentReviewMode): string {
  return `${CREDIT}\n\n# ViewCode ${reviewModeLabel(mode)}\n\n${MODE_SECTIONS[mode]}\n\n${SHARED_RULES}\n`;
}

/**
 * Writes the mode's playbook into the state directory when it is missing or out of date, and
 * returns its absolute path. Reviews start concurrently, so a changed file is swapped in by rename
 * and no agent reads a half-written one.
 */
export const ensureReviewPlaybook = Effect.fn("ReviewPlaybook.ensure")(function* (input: {
  readonly stateDir: string;
  readonly mode: AgentReviewMode;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join(input.stateDir, PLAYBOOK_DIR);
  const target = path.join(dir, FILE_NAMES[input.mode]);
  const content = reviewPlaybookMarkdown(input.mode);
  const current = yield* fs.readFileString(target).pipe(Effect.orElseSucceed(() => undefined));
  if (current === content) return target;
  yield* fs.makeDirectory(dir, { recursive: true });
  const now = yield* Clock.currentTimeMillis;
  const temporary = `${target}.${process.pid}.${now.toString(36)}.tmp`;
  yield* fs.writeFileString(temporary, content);
  yield* fs.rename(temporary, target);
  return target;
});
