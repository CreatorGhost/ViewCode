import type {
  GitConflictHunk,
  GitGraphLane,
  GitPullRequestGraph,
  PullRequestCheck,
} from "@t3tools/contracts";

/**
 * One pull request on its way from "Create PR" to merged, as the chat shows it. The card, its
 * commit graph and the composer chip all read this one value, so they never disagree.
 */
export type PrFlowPhase =
  | "committing"
  | "pushing"
  | "opening"
  | "conflicts"
  | "resolving"
  | "testing"
  | "ready"
  | "merging"
  | "merged";

const PR_FLOW_PHASES: ReadonlyArray<PrFlowPhase> = [
  "committing",
  "pushing",
  "opening",
  "conflicts",
  "resolving",
  "testing",
  "ready",
  "merging",
  "merged",
];

/** Whether the flow has reached `target` (or gone past it). */
export function prFlowReached(phase: PrFlowPhase, target: PrFlowPhase): boolean {
  return PR_FLOW_PHASES.indexOf(phase) >= PR_FLOW_PHASES.indexOf(target);
}

export interface PrFlowConflictFile {
  readonly path: string;
  readonly count: number;
  readonly theirsAuthor: string | null;
  readonly oursAuthor: string | null;
  readonly hunks: ReadonlyArray<GitConflictHunk>;
  /** Fixed in the merge in progress. */
  readonly resolved: boolean;
}

export interface PrFlowConflicts {
  /**
   * What `total` and `resolved` count, the same unit everywhere in the card: clashing hunks when
   * the checkout could read them, else conflicted files of the merge in progress.
   */
  readonly unit: "conflict" | "file";
  /** 0 when only the host knows it conflicts, not where. */
  readonly total: number;
  readonly resolved: number;
  readonly files: ReadonlyArray<PrFlowConflictFile>;
}

export type PrFlowCheckState = "running" | "passed" | "failed" | "skipped";

export interface PrFlowCheck {
  readonly name: string;
  readonly state: PrFlowCheckState;
  /** The host's word for it: passed, failed, cancelled, skipped, needs action, running. */
  readonly result: string;
  readonly description: string | null;
  readonly url: string | null;
  readonly durationMs: number | null;
}

export interface PrFlowChecks {
  readonly list: ReadonlyArray<PrFlowCheck>;
  readonly done: number;
  readonly total: number;
  readonly failed: number;
}

export interface PrFlowCommitRow {
  readonly kind: "commit";
  readonly key: string;
  readonly sha: string;
  readonly subject: string;
  /** "You" for the checkout's own Git user. */
  readonly author: string;
  readonly authoredAt: string;
  readonly lane: GitGraphLane;
  readonly refs: ReadonlyArray<string>;
  readonly parents: ReadonlyArray<string>;
  /** Conflicting hunks this base commit brought (the newest base commit to touch the file). */
  readonly conflicts: number;
  /** Shown with a check: its clashes are fixed, or it is merged into the branch while resolving. */
  readonly resolved: boolean;
}

/** The merge the agent has started in the checkout, before it is a commit. */
export interface PrFlowMergeRow {
  readonly kind: "merging";
  readonly key: string;
  readonly subject: string;
  readonly done: number;
  readonly total: number;
  readonly parents: ReadonlyArray<string>;
}

export type PrFlowRow = PrFlowCommitRow | PrFlowMergeRow;

export interface PrFlow {
  readonly phase: PrFlowPhase;
  readonly title: string;
  /** Known once the pull request exists. */
  readonly number: number | null;
  readonly url: string | null;
  readonly head: string;
  /** Null until the pull request exists and names its base. */
  readonly base: string | null;
  readonly additions: number | null;
  readonly deletions: number | null;
  /** A draft cannot be merged until it is marked ready. */
  readonly draft: boolean;
  /** Newest first: the branch, the base since the fork, and the fork itself last. */
  readonly rows: ReadonlyArray<PrFlowRow>;
  readonly headCommits: number | null;
  readonly conflicts: PrFlowConflicts | null;
  readonly checks: PrFlowChecks | null;
  /** What the agent or the git menu is doing for this pull request right now. */
  readonly step: string | null;
}

export type PrFlowTone = "busy" | "warning" | "success" | "merged";

export interface PrFlowStatus {
  readonly tone: PrFlowTone;
  /** The live sentence for the card's footer. */
  readonly label: string;
  /** The short form for the composer chip, without the PR number. */
  readonly short: string;
  /** The top row's state, beside "Merge into <base>". */
  readonly target: string;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

export function prFlowStatus(flow: PrFlow): PrFlowStatus {
  const base = flow.base ?? "the base";
  const conflicts = flow.conflicts;
  const conflictWord =
    conflicts === null || conflicts.total === 0 ? "Conflicts" : plural(conflicts.total, "conflict");
  switch (flow.phase) {
    case "committing":
      return {
        tone: "busy",
        label: flow.step ?? "Committing the last changes",
        short: "Creating PR",
        target: "",
      };
    case "pushing":
      return {
        tone: "busy",
        label:
          flow.step ??
          (flow.headCommits === null
            ? "Pushing to origin"
            : `Pushing ${plural(flow.headCommits, "commit")} to origin`),
        short: "Creating PR",
        target: "",
      };
    case "opening":
      return {
        tone: "busy",
        label: flow.step ?? "Opening the pull request",
        short: "Creating PR",
        target: "",
      };
    case "conflicts":
      return {
        tone: "warning",
        label: `${conflictWord} with ${base}`,
        short: conflictWord,
        target: conflictWord.toLowerCase(),
      };
    case "resolving": {
      const unit = conflicts?.unit ?? "conflict";
      const total = conflicts?.total ?? 0;
      const resolved = conflicts?.resolved ?? 0;
      const remaining = total - resolved;
      const progress =
        total > 0 && remaining > 0
          ? `Resolving ${unit} ${Math.min(resolved + 1, total)} of ${total}`
          : null;
      return {
        tone: "busy",
        label: flow.step ?? progress ?? "Working…",
        short: "Resolving",
        target: total === 0 ? "resolving" : remaining > 0 ? plural(remaining, unit) : "resolved",
      };
    }
    case "testing": {
      const checks = flow.checks;
      return {
        tone: "busy",
        label:
          checks === null || checks.total === 0
            ? "Checks are running"
            : `Running checks, ${checks.done} of ${checks.total} done`,
        short: "Running checks",
        target: "checks",
      };
    }
    case "ready":
      if ((flow.checks?.failed ?? 0) > 0) {
        const failed = plural(flow.checks?.failed ?? 0, "check");
        return { tone: "warning", label: `${failed} failed`, short: "Checks failed", target: "" };
      }
      if (flow.draft) {
        return { tone: "success", label: "Draft, no conflicts", short: "Draft", target: "draft" };
      }
      return { tone: "success", label: "Ready to merge", short: "Ready to merge", target: "ready" };
    case "merging":
      return {
        tone: "busy",
        label: `Merging into ${base}`,
        short: "Merging",
        target: "merging",
      };
    case "merged":
      return {
        tone: "merged",
        label: `Merged into ${base}`,
        short: "Merged",
        target: "merged",
      };
  }
}

/**
 * Where a pull request being opened from the git menu is, from the step label the server
 * reports ("Committing...", "Pushing to origin...", "Creating pull request...").
 */
export function prFlowCreatingPhase(label: string | null): PrFlowPhase {
  if (label === null) return "committing";
  if (/^push/i.test(label)) return "pushing";
  if (/\b(PR|pull request|merge request|change request)\b/i.test(label)) return "opening";
  return "committing";
}

const GIT = String.raw`\bgit(?:\s+-[Cc]\s+\S+)*\s+`;
const COMMAND_STEPS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly label: (base: string, head: string) => string;
}> = [
  { pattern: new RegExp(`${GIT}fetch\\b`), label: (base) => `Fetching ${base}` },
  {
    pattern: new RegExp(`${GIT}merge(?![-\\w])`),
    label: (base, head) => `Merging ${base} into ${head}`,
  },
  { pattern: new RegExp(`${GIT}push\\b`), label: () => "Pushing to origin" },
  {
    pattern:
      /\b(?:vitest|jest|pytest)\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\bvpr?\s+(?:run\s+)?test\b|\b(?:go|cargo)\s+test\b/,
    label: () => "Running tests",
  },
];

/** A command the agent is running, as the step it is for this pull request; null when unknown. */
export function prFlowCommandStep(command: string, base: string, head: string): string | null {
  return COMMAND_STEPS.find((step) => step.pattern.test(command))?.label(base, head) ?? null;
}

/** Whether a finished command can have moved the branch, the base or the merge state. */
function isGitCommand(command: string): boolean {
  return new RegExp(`${GIT}\\w`).test(command);
}

const RESOLVE_PROMPT = /^Pull request #(\d+) has merge conflicts with /;

export function prFlowResolvePrompt(input: {
  readonly number: number;
  readonly base: string;
  readonly head: string;
}): string {
  return `Pull request #${input.number} has merge conflicts with ${input.base}. Merge the latest ${input.base} into ${input.head}, resolve the conflicts so both sides keep working, run the affected tests, then commit and push.`;
}

/** The pull request a message asked the agent to resolve, when it is the Resolve prompt. */
function prFlowResolvePromptNumber(text: string): number | null {
  const match = RESOLVE_PROMPT.exec(text);
  return match ? Number(match[1]) : null;
}

const ACTIVE_RUN = new Set(["preparing", "queued", "starting", "running", "waiting"]);
const LIVE_ITEM = new Set(["pending", "running", "waiting"]);

/** Just what the flow reads of a thread's projection. */
export interface PrFlowActivitySource {
  readonly runs: ReadonlyArray<{
    readonly id: string;
    readonly status: string;
    readonly ordinal: number;
  }>;
  readonly turnItems: ReadonlyArray<{
    readonly type: string;
    readonly runId: string | null;
    readonly status: string;
    /** A command's command line. */
    readonly input?: unknown;
    /** A message's text. */
    readonly text?: unknown;
  }>;
}

function latestRun(source: PrFlowActivitySource) {
  let latest: PrFlowActivitySource["runs"][number] | null = null;
  for (const run of source.runs) if (latest === null || run.ordinal > latest.ordinal) latest = run;
  return latest;
}

function activeRunId(source: PrFlowActivitySource): string | null {
  const run = latestRun(source);
  return run !== null && ACTIVE_RUN.has(run.status) ? run.id : null;
}

/** The command the thread's active run is executing, if any. */
export function prFlowRunningCommand(source: PrFlowActivitySource): string | null {
  const runId = activeRunId(source);
  if (runId === null) return null;
  for (let index = source.turnItems.length - 1; index >= 0; index -= 1) {
    const item = source.turnItems[index];
    if (item?.runId !== runId || item.type !== "command_execution") continue;
    if (typeof item.input === "string" && LIVE_ITEM.has(item.status)) return item.input;
  }
  return null;
}

/** Changes whenever the latest run finishes another git command: the graph's refetch key. */
export function prFlowGitCommandsKey(source: PrFlowActivitySource): string {
  const run = latestRun(source);
  if (run === null) return "";
  let finished = 0;
  for (const item of source.turnItems) {
    if (item.runId !== run.id || item.type !== "command_execution") continue;
    if (typeof item.input === "string" && !LIVE_ITEM.has(item.status) && isGitCommand(item.input)) {
      finished += 1;
    }
  }
  return `${run.id}:${finished}`;
}

/**
 * The pull request the agent is resolving right now: the thread's latest message is the Resolve
 * prompt and its run has not ended. Read from the thread, so a reload or another device sees it.
 */
export function prFlowResolvingNumber(source: PrFlowActivitySource): number | null {
  for (let index = source.turnItems.length - 1; index >= 0; index -= 1) {
    const item = source.turnItems[index];
    if (item?.type !== "user_message" || typeof item.text !== "string") continue;
    const number = prFlowResolvePromptNumber(item.text);
    if (number === null) return null;
    const run = source.runs.find((candidate) => candidate.id === item.runId);
    return run === undefined || ACTIVE_RUN.has(run.status) ? number : null;
  }
  return null;
}

const CHECK_RESULT: Record<PullRequestCheck["status"], [PrFlowCheckState, string]> = {
  pending: ["running", "running"],
  success: ["passed", "passed"],
  failure: ["failed", "failed"],
  cancelled: ["failed", "cancelled"],
  "action-required": ["failed", "needs action"],
  skipped: ["skipped", "skipped"],
  neutral: ["skipped", "neutral"],
};

function prFlowChecks(checks: ReadonlyArray<PullRequestCheck>): PrFlowChecks {
  const list = checks.map((check): PrFlowCheck => {
    const [state, result] = CHECK_RESULT[check.status];
    const started = check.startedAt ? Date.parse(check.startedAt) : Number.NaN;
    const completed = check.completedAt ? Date.parse(check.completedAt) : Number.NaN;
    const durationMs = completed - started;
    return {
      name: check.name,
      state,
      result,
      description: check.description,
      url: check.url,
      durationMs: Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : null,
    };
  });
  return {
    list,
    done: list.filter((check) => check.state !== "running").length,
    total: list.length,
    failed: list.filter((check) => check.state === "failed").length,
  };
}

export function formatCheckDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

/** The graph's commits as rows, newest first, with the clashes each base commit brought. */
function prFlowRows(
  graph: GitPullRequestGraph,
  options: { readonly base: string; readonly head: string; readonly resolving: boolean },
): { readonly rows: ReadonlyArray<PrFlowRow>; readonly conflicts: PrFlowConflicts | null } {
  const you = (name: string) =>
    graph.viewerName !== null && name === graph.viewerName ? "You" : name;
  const unresolved = graph.resolving === null ? null : new Set<string>(graph.resolving.unresolved);
  const files = (graph.conflicts?.files ?? []).map(
    (file): PrFlowConflictFile & { readonly baseCommits: ReadonlyArray<string> } => ({
      path: file.path,
      count: file.count,
      theirsAuthor: file.theirsAuthor === null ? null : you(file.theirsAuthor),
      oursAuthor: file.oursAuthor === null ? null : you(file.oursAuthor),
      hunks: file.hunks,
      baseCommits: file.baseCommits,
      resolved: unresolved !== null && !unresolved.has(file.path),
    }),
  );
  const shown = new Set(graph.base.map((commit) => commit.sha));
  const brought = new Map<string, { count: number; open: number }>();
  for (const file of files) {
    const sha = file.baseCommits.find((candidate) => shown.has(candidate));
    if (sha === undefined) continue;
    const entry = brought.get(sha) ?? { count: 0, open: 0 };
    entry.count += file.count;
    if (!file.resolved) entry.open += file.count;
    brought.set(sha, entry);
  }
  const commits = [...graph.head, ...graph.base]
    .map((commit, order) => ({ commit, order, at: Date.parse(commit.authoredAt) }))
    .toSorted((left, right) =>
      Number.isFinite(left.at) && Number.isFinite(right.at) && left.at !== right.at
        ? right.at - left.at
        : left.order - right.order,
    )
    .map(({ commit }): PrFlowCommitRow => {
      const conflict = brought.get(commit.sha);
      return {
        kind: "commit",
        key: commit.sha,
        sha: commit.sha,
        subject: commit.subject,
        author: you(commit.authorName),
        authoredAt: commit.authoredAt,
        lane: commit.lane,
        refs: commit.refs,
        parents: commit.parents,
        conflicts: (unresolved === null ? conflict?.count : conflict?.open) ?? 0,
        resolved:
          conflict !== undefined
            ? conflict.open === 0 && unresolved !== null
            : options.resolving && commit.inHead === true,
      };
    });
  const fork =
    graph.fork === null
      ? []
      : [
          {
            kind: "commit",
            key: `fork:${graph.fork.sha}`,
            sha: graph.fork.sha,
            subject: graph.fork.subject,
            author: you(graph.fork.authorName),
            authoredAt: graph.fork.authoredAt,
            lane: "base",
            refs: graph.fork.refs,
            parents: [],
            conflicts: 0,
            resolved: false,
          } satisfies PrFlowCommitRow,
        ];
  const conflicts: PrFlowConflicts | null =
    files.length > 0
      ? {
          unit: "conflict",
          total: files.reduce((sum, file) => sum + file.count, 0),
          resolved: files.reduce((sum, file) => sum + (file.resolved ? file.count : 0), 0),
          files: files.map(({ baseCommits: _baseCommits, ...file }) => file),
        }
      : graph.resolving !== null && graph.resolving.total > 0
        ? {
            unit: "file",
            total: graph.resolving.total,
            resolved: Math.max(0, graph.resolving.total - graph.resolving.unresolved.length),
            files: [],
          }
        : null;
  const merging: ReadonlyArray<PrFlowMergeRow> =
    graph.resolving === null
      ? []
      : [
          {
            kind: "merging",
            key: "merging",
            subject: `Merge ${options.base} into ${options.head}`,
            done: conflicts?.resolved ?? 0,
            total: conflicts?.total ?? 0,
            parents: [graph.head[0]?.sha, graph.base[0]?.sha].filter(
              (sha): sha is string => sha !== undefined,
            ),
          },
        ];
  return {
    rows: [...merging, ...commits, ...fork],
    conflicts,
  };
}

/** What the thread's pull request link says about it; the server keeps it in sync with the host. */
export interface PrFlowPullRequest {
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly state: "open" | "closed" | "merged";
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly isDraft?: boolean | undefined;
  readonly additions?: number | undefined;
  readonly deletions?: number | undefined;
  readonly checksState?: "passing" | "failing" | "pending" | null | undefined;
  readonly mergeability?: "mergeable" | "conflicting" | "unknown" | undefined;
}

export interface PrFlowSources {
  /** Null when the checkout cannot say (not loaded, another machine, too old a Git). */
  readonly graph: GitPullRequestGraph | null;
  readonly checks: ReadonlyArray<PullRequestCheck> | null;
  /** The agent was asked to resolve this pull request and its run has not ended. */
  readonly resolveAsked: boolean;
  readonly merging: boolean;
  /** The command the thread's agent is running now. */
  readonly command: string | null;
}

/**
 * The flow for a pull request that exists. Closed ones have nothing left to show. The host's
 * mergeability is the authority on conflicts; the checkout's own merge says where they are,
 * and alone decides only while the host has not worked it out yet.
 */
export function prFlowFromPullRequest(
  pr: PrFlowPullRequest,
  sources: PrFlowSources,
): PrFlow | null {
  if (pr.state === "closed") return null;
  const graph = sources.graph;
  const localConflicts = (graph?.conflicts?.files.length ?? 0) > 0;
  const open = pr.state === "open";
  const conflicting =
    open &&
    (pr.mergeability === "conflicting" || (pr.mergeability !== "mergeable" && localConflicts));
  const mergeInProgress = open && graph?.resolving != null;
  const checks = sources.checks === null ? null : prFlowChecks(sources.checks);
  const checksRunning =
    checks !== null && checks.total > 0 ? checks.done < checks.total : pr.checksState === "pending";
  const phase: PrFlowPhase =
    pr.state === "merged"
      ? "merged"
      : sources.merging
        ? "merging"
        : mergeInProgress || (sources.resolveAsked && conflicting)
          ? "resolving"
          : conflicting
            ? "conflicts"
            : checksRunning
              ? "testing"
              : "ready";
  const laid =
    graph === null
      ? null
      : prFlowRows(graph, {
          base: pr.baseBranch,
          head: pr.headBranch,
          resolving: phase === "resolving",
        });
  const conflicts: PrFlowConflicts | null =
    laid?.conflicts ??
    (conflicting ? { unit: "conflict", total: 0, resolved: 0, files: [] } : null);
  const command =
    phase === "resolving" && sources.command !== null
      ? prFlowCommandStep(sources.command, pr.baseBranch, pr.headBranch)
      : null;
  return {
    phase,
    title: pr.title,
    number: pr.number,
    url: pr.url,
    head: pr.headBranch,
    base: pr.baseBranch,
    additions: pr.additions ?? null,
    deletions: pr.deletions ?? null,
    draft: pr.isDraft === true,
    rows: laid?.rows ?? [],
    headCommits: graph?.head.length ?? null,
    conflicts: phase === "conflicts" || phase === "resolving" ? conflicts : null,
    checks:
      checks ?? (pr.checksState === "failing" ? { list: [], done: 0, total: 0, failed: 1 } : null),
    step: command,
  };
}

/** The flow while the git menu opens a pull request, before the host has one. */
export function prFlowCreating(input: {
  readonly title: string;
  readonly head: string;
  readonly stepLabel: string | null;
  /** Commits the push will send, from the checkout's status. */
  readonly commitsToPush: number | null;
}): PrFlow {
  return {
    phase: prFlowCreatingPhase(input.stepLabel),
    title: input.title,
    number: null,
    url: null,
    head: input.head,
    base: null,
    additions: null,
    deletions: null,
    draft: false,
    rows: [],
    headCommits: input.commitsToPush,
    conflicts: null,
    checks: null,
    step: null,
  };
}
