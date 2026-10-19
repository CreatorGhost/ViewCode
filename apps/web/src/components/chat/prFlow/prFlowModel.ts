/**
 * One pull request on its way from "Create PR" to merged, as the chat shows it. The card, its
 * branch map and the composer chip all read this one value, so they never disagree.
 */
export type PrFlowPhase =
  | "committing"
  | "pushing"
  | "opening"
  | "fetching"
  | "checking"
  | "conflicts"
  | "resolving"
  | "testing"
  | "ready"
  | "merging"
  | "merged";

export const PR_FLOW_PHASES: ReadonlyArray<PrFlowPhase> = [
  "committing",
  "pushing",
  "opening",
  "fetching",
  "checking",
  "conflicts",
  "resolving",
  "testing",
  "ready",
  "merging",
  "merged",
];

export interface PrFlowConflictFile {
  readonly path: string;
  readonly count: number;
}

export interface PrFlow {
  readonly phase: PrFlowPhase;
  readonly title: string;
  /** Known once the pull request exists. */
  readonly number: number | null;
  readonly head: string;
  /** Null until the pull request exists and names its base. */
  readonly base: string | null;
  readonly commitCount: number | null;
  readonly additions: number | null;
  readonly deletions: number | null;
  /** Set when the base moved and touched the same lines. The host names neither the files nor who. */
  readonly conflicts: {
    readonly author: string | null;
    readonly files: ReadonlyArray<PrFlowConflictFile>;
    readonly resolved: number;
  } | null;
  readonly tests: { readonly passed: number; readonly total: number } | null;
  /** The host's checks once they have settled; a failure holds back Merge. */
  readonly checksFailed?: boolean;
  /** A draft cannot be merged until it is marked ready. */
  readonly draft?: boolean;
}

/** Whether the flow has reached `target` (or gone past it). */
export function prFlowReached(phase: PrFlowPhase, target: PrFlowPhase): boolean {
  return PR_FLOW_PHASES.indexOf(phase) >= PR_FLOW_PHASES.indexOf(target);
}

export type PrFlowTone = "busy" | "warning" | "success" | "merged";

export interface PrFlowStatus {
  readonly tone: PrFlowTone;
  /** The live sentence for the card's footer and the activity row. */
  readonly label: string;
  /** The short form for the composer chip, without the PR number. */
  readonly short: string;
}

/** How many conflicting hunks the flow knows of; 0 when the host only says it conflicts. */
export function prFlowConflictCount(flow: PrFlow): number {
  return flow.conflicts?.files.reduce((total, file) => total + file.count, 0) ?? 0;
}

export function prFlowStatus(flow: PrFlow): PrFlowStatus {
  const conflictCount = prFlowConflictCount(flow);
  const conflicts =
    conflictCount === 0
      ? "Conflicts"
      : `${conflictCount} conflict${conflictCount === 1 ? "" : "s"}`;
  const base = flow.base ?? "the base";
  switch (flow.phase) {
    case "committing":
      return { tone: "busy", label: "Committing the last changes", short: "Creating PR" };
    case "pushing":
      return {
        tone: "busy",
        label:
          flow.commitCount === null
            ? "Pushing to origin"
            : `Pushing ${flow.commitCount} commit${flow.commitCount === 1 ? "" : "s"} to origin`,
        short: "Creating PR",
      };
    case "opening":
      return { tone: "busy", label: "Opening the pull request", short: "Creating PR" };
    case "fetching":
      return { tone: "busy", label: `Fetching ${base}`, short: "Creating PR" };
    case "checking":
      return { tone: "busy", label: "Checking it merges cleanly", short: "Creating PR" };
    case "conflicts":
      return {
        tone: "warning",
        label: `${conflictCount === 0 ? "Conflicts" : conflicts} with ${base}`,
        short: conflicts,
      };
    case "resolving": {
      const files = flow.conflicts?.files.length ?? 0;
      if (files === 0) return { tone: "busy", label: "Resolving conflicts", short: "Resolving" };
      const current = Math.min((flow.conflicts?.resolved ?? 0) + 1, files);
      return {
        tone: "busy",
        label: `Resolving ${current} of ${files} file${files === 1 ? "" : "s"}`,
        short: "Resolving",
      };
    }
    case "testing":
      return {
        tone: "busy",
        label:
          flow.tests === null
            ? "Checks are running"
            : `Running ${flow.tests.passed} of ${flow.tests.total} tests`,
        short: "Running checks",
      };
    case "ready":
      if (flow.checksFailed)
        return { tone: "warning", label: "Checks failed", short: "Checks failed" };
      if (flow.draft) return { tone: "success", label: "Draft, no conflicts", short: "Draft" };
      return { tone: "success", label: "Ready to merge", short: "Ready to merge" };
    case "merging":
      return { tone: "busy", label: `Merging into ${base}`, short: "Merging" };
    case "merged":
      return { tone: "merged", label: `Merged into ${base}`, short: "Merged" };
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

/** What the thread's pull request link says about it; the server keeps it in sync with the host. */
export interface PrFlowPullRequest {
  readonly number: number;
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

/**
 * The flow for a pull request that exists. Closed ones have nothing left to show. `resolving`
 * is the reader having asked the agent to resolve the conflicts; `merging` a merge in flight.
 */
export function prFlowFromPullRequest(
  pr: PrFlowPullRequest,
  options: { readonly resolving: boolean; readonly merging: boolean },
): PrFlow | null {
  if (pr.state === "closed") return null;
  const conflicting = pr.state === "open" && pr.mergeability === "conflicting";
  const phase: PrFlowPhase =
    pr.state === "merged"
      ? "merged"
      : options.merging
        ? "merging"
        : conflicting
          ? options.resolving
            ? "resolving"
            : "conflicts"
          : pr.checksState === "pending"
            ? "testing"
            : "ready";
  return {
    phase,
    title: pr.title,
    number: pr.number,
    head: pr.headBranch,
    base: pr.baseBranch,
    commitCount: null,
    additions: pr.additions ?? null,
    deletions: pr.deletions ?? null,
    conflicts: conflicting ? { author: null, files: [], resolved: 0 } : null,
    tests: null,
    checksFailed: pr.checksState === "failing",
    draft: pr.isDraft === true,
  };
}
