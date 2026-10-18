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
  readonly base: string;
  readonly commitCount: number;
  readonly additions: number;
  readonly deletions: number;
  /** Set when the base moved and touched the same lines. */
  readonly conflicts: {
    readonly author: string;
    readonly files: ReadonlyArray<PrFlowConflictFile>;
    readonly resolved: number;
  } | null;
  readonly tests: { readonly passed: number; readonly total: number } | null;
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

export function prFlowStatus(flow: PrFlow): PrFlowStatus {
  const conflictCount = flow.conflicts?.files.reduce((total, file) => total + file.count, 0) ?? 0;
  const conflicts = `${conflictCount} conflict${conflictCount === 1 ? "" : "s"}`;
  switch (flow.phase) {
    case "committing":
      return { tone: "busy", label: "Committing the last changes", short: "Creating PR" };
    case "pushing":
      return {
        tone: "busy",
        label: `Pushing ${flow.commitCount} commit${flow.commitCount === 1 ? "" : "s"} to origin`,
        short: "Creating PR",
      };
    case "opening":
      return { tone: "busy", label: "Opening the pull request", short: "Creating PR" };
    case "fetching":
      return { tone: "busy", label: `Fetching ${flow.base}`, short: "Creating PR" };
    case "checking":
      return { tone: "busy", label: "Checking it merges cleanly", short: "Creating PR" };
    case "conflicts":
      return { tone: "warning", label: `${conflicts} with ${flow.base}`, short: conflicts };
    case "resolving": {
      const files = flow.conflicts?.files.length ?? 0;
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
        label: `Running ${flow.tests?.passed ?? 0} of ${flow.tests?.total ?? 0} tests`,
        short: "Running checks",
      };
    case "ready":
      return { tone: "success", label: "Ready to merge", short: "Ready to merge" };
    case "merging":
      return { tone: "busy", label: `Merging into ${flow.base}`, short: "Merging" };
    case "merged":
      return { tone: "merged", label: `Merged into ${flow.base}`, short: "Merged" };
  }
}
