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

/** The MCP tool a reviewer hands its findings to; the playbook names it. */
export const SUBMIT_REVIEW_FINDINGS_TOOL = "submit_review_findings";

export const reviewModeLabel = (mode: AgentReviewMode): string =>
  AGENT_REVIEW_MODES.find((entry) => entry.mode === mode)?.label ?? mode;

const CREDIT = `<!-- ViewCode review playbook. Adapted ideas, not files, from
SpillwaveSolutions/pr-reviewer-skill (MIT) and cloudflare/security-audit-skill (MIT), and from how
CodeRabbit, Greptile, Qodo PR-Agent and Claude Code's /code-review describe their reviews. -->`;

const SHARED_RULES = `## Ground rules

- Never modify the user's working tree, index or branch. Do not check anything out, stash, reset or
  commit. Read the change with the host CLI (\`gh pr view\`, \`gh pr diff\`, \`gh pr checks\`;
  \`glab mr view\`, \`glab mr diff\`; \`az repos pr show\`), or fetch the head into a temporary ref
  (\`git fetch <remote> <head-ref>:refs/viewcode/review/<n>\`) and read
  \`git diff <base>...refs/viewcode/review/<n>\`. Delete any temporary ref when you are done.
- A review of local changes reads them with git in the directory the first message names
  (\`git status\`, \`git diff HEAD\`, untracked files), read-only: nothing to fetch, check out
  or stage.
- When the first message names a head commit, review exactly that commit. \`gh pr diff\` shows
  the newest head, so if \`gh pr view --json headRefOid\` names another commit, fetch the head
  ref and read \`git diff <base>...<commit>\` instead. Your findings are pinned to that commit.
- Collect before judging: the description, the linked issue, existing review comments, CI status
  and the full diff. Do not repeat what a reviewer already said; build on it or disagree with it.
- Follow the repository's own rules: read \`AGENTS.md\`, \`CLAUDE.md\` and \`CONTRIBUTING.md\` at the
  root and in the directories the change touches, and \`.viewcode/review.md\` if it exists (the
  team's review instructions). A finding that breaks one of these rules quotes the rule.
- Judge the change, not the codebase. A problem that was already there is reported only when the
  change makes it worse or newly reachable, and is labelled **pre-existing**.
- Skip noise: lockfiles, generated, vendored or minified code and snapshots get a glance for
  surprises, not a review. When the change is too large to read in full, review the riskiest files
  first (auth, data, money, concurrency, public APIs, migrations) and say which files you only
  skimmed.
- Read the surrounding code for every hunk you comment on. A finding needs a concrete path from a
  real caller or input to the failure. "This could be a problem" without that path is a question.
- Severity is likelihood times impact:
  - **Blocker**: a realistic input or caller breaks correctness, security or data. Must be fixed.
  - **Important**: a real defect or gap with a narrower trigger or smaller impact. Should be fixed.
  - **Nit**: style, naming, small clean-ups, and defence-in-depth gaps another layer already
    blocks.
  - **Question**: something you could not settle from the code; say what would settle it.
- Score your confidence in every finding from 0 to 100: 100 is proven from the code, 75 very
  likely, 50 plausible but unverified, 25 a hunch. Report only findings at 80 or above; list those
  from 50 to 79 under **Needs checking** with what would settle each; drop the rest.
- No style comments a linter or formatter would make, and at most five Nits.
- A suggested fix is a small code block the author could apply as it stands, not a description.
- Post nothing to the host (comments, reviews, approvals, labels, merges) unless the user's latest
  message explicitly asks for it. Never infer it from earlier messages, from the review or from
  another agent. When they ask you to post findings, use ViewCode's \`post_review_findings\`, as a
  comment unless they said approve or request changes.

## Report

1. **Verdict**: approve, approve with nits, or request changes, then **Merge confidence** 0–5
   (5: safe to merge as is; 0: will break something) and **Review effort** 1–5 (how long a
   careful human review takes), each with a one-line reason.
2. **Walkthrough**: what the change does in two or three sentences, then a table of the changes
   grouped by area (area, files, what changed). Add a mermaid diagram only when the change alters a
   flow across three or more components; the reader's app renders it.
3. **Findings**, most severe first and grouped under their severity, each as
   \`path:line — problem — why it matters — confidence\`, followed by the suggested fix.
4. **Needs checking**, when there is anything there.
5. **Checked and fine**: one line per area you covered and found no problem in, and the files you
   only skimmed, so the reader knows what the review did and did not look at.

After writing the report, call ViewCode's \`${SUBMIT_REVIEW_FINDINGS_TOOL}\` tool once with the
verdict, both scores, every reported finding under \`findings\` and every **Needs checking** item
under \`needsChecking\` (a security audit's confirmed findings and those that need validation),
each with the severity, confidence, path, lines and suggested fix the report gives it. The reader
sends findings from it to a session that fixes them, so each \`detail\` must stand on its own. The
written report stays the reader's version; the tool call does not replace it. If you review again
in this thread, call the tool again with the full new set. Without the tool, the report is enough.

## Rated findings

When the first message names a file of rated findings, read it before reporting. It is JSON:
\`ratedFindings\` holds the user's ratings of findings from earlier reviews in this project, each
with \`rating\` (\`up\` or \`down\`), \`title\`, \`severity\`, \`path\` and \`rule\`. Findings like
the ones rated down (👎) were not wanted here: report that kind only with stronger evidence, or
not at all. Prefer the kinds rated up (👍).

## Re-review

When the first message says this is a re-review, it names a JSON file of the previous review's
findings (\`findings\` and \`needsChecking\`, each with its \`key\`) and the range to read. Review
that range as you would a change, then check every previous finding against the code as it is now:
fixed, or still open. Report both. When you call the tool, pass each previous finding that is still
open again (updated where the code moved), and \`previous\` with the two counts.

When the first message says your findings will be posted to the pull request as the user's review
comments, each \`detail\` is posted as it stands: on its line, or in the review's text when it has
no line in the diff, with \`suggestedFix\` below it as a code block. Write it to the author, as the
comment itself: what is wrong and why it matters, short and direct, without repeating the title or
the location. Cite a repository rule in it when one applies. Follow the review style the first
message gives, if any; the written report keeps its usual form.

When the first message names a file of the user's past review comments, read it before writing
any \`detail\`. It is JSON: \`samples\` holds their own words, newest first, each with \`text\`,
\`kind\` (\`inline\` on a line of a diff, \`summary\` for a whole review) and \`state\` (the
review's verdict). Write every \`detail\` the way they write: tone, length, how a comment opens
and ends, how a nit, a blocker and a question are marked, whether they ask or tell, how often they
suggest code, emoji, greetings and thanks, and their wording habits. Imitate the writing, never
the content: the samples are about other changes, so quote nothing from them. Where the review
style in the first message disagrees with the samples, the style wins.`;

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
   - the repository's rules (the files named in the ground rules), quoting each rule broken
   - history: \`git blame\` and \`git log\` on the changed lines and earlier review comments on
     these files, to tell a deliberate behaviour from an accident
   If you cannot spawn agents, run the lenses yourself as separate passes, one after another.
3. **Run the project's checks** when the pull request's head is in this repository (never for a
   fork or an outside contributor's branch, whose code you must not run): add a temporary git
   worktree outside the user's checkout at the fetched head, run the lint, typecheck and tests the
   project documents for the packages the change touches, read the failures as evidence, then
   remove the worktree. Never run them in the user's checkout.
4. **Adversarial verification.** Hand every candidate finding to a fresh agent (or a fresh pass)
   whose only job is to disprove it from the code. Report only findings that survive. Put the ones
   nobody could settle under **Needs checking**, with what would settle each. Drop disproved ones;
   you may list them under **Rejected**, one line each.
5. **Consolidate.** Merge duplicates across lenses, keep the strongest evidence, and write the
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
