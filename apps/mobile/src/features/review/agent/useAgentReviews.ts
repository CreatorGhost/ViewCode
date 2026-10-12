import { useAtomValue } from "@effect/atom-react";
import {
  type AgentReviewChoices,
  type AgentReviewRequest,
  buildAgentReviewStart,
  canChooseLocalReviewScope,
} from "@t3tools/client-runtime/agent-review";
import {
  latestReviewFindingsSource,
  openReviewFindingCount,
  reviewFindingEntries,
  reviewFindingMarksByKey,
  type ReviewFindingsSource,
  type ReviewProgress,
  type ReviewRunState,
  reviewRunState,
  reviewStartedRecord,
  selectLatestReview,
} from "@t3tools/client-runtime/review-findings";
import {
  type ChildAgentEntry,
  collectChildAgents,
} from "@t3tools/client-runtime/state/child-agents";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AGENT_REVIEW_MODES,
  type AgentReviewMode,
  type EnvironmentId,
  type LocalReviewScope,
  type ModelSelection,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { postedReviewFindings } from "@t3tools/shared/reviewFindings";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "react-native";

import { environmentAgentControlAtom } from "../../../state/agentControl";
import {
  useEnvironmentServerConfig,
  useServerConfigs,
  useThreadShell,
  useThreadShells,
} from "../../../state/entities";
import { pullRequestEnvironment } from "../../../state/pullRequests";
import { reviewEnvironment } from "../../../state/review";
import {
  linkedReviewThreadsAtom,
  reviewFindingsCardKey,
  useDismissedReviewFindings,
} from "../../../state/review-findings";
import { useAtomCommand } from "../../../state/use-atom-command";
import { resolveHomeAgentModelLabel } from "../../home/homeFolderList";

/** "Deep", the depth a pill shows; menus use the full label ("Deep review"). */
export const AGENT_REVIEW_MODE_SHORT_LABELS: Record<AgentReviewMode, string> = {
  quick: "Quick",
  deep: "Deep",
  security: "Security",
};

export function agentReviewModeLabel(mode: AgentReviewMode): string {
  return AGENT_REVIEW_MODES.find((entry) => entry.mode === mode)?.label ?? "Review";
}

/** "Deep review · GPT-6.1": the kind of review and the model it runs on, as web words it. */
export function useAgentReviewLabel(
  environmentId: EnvironmentId,
  mode: AgentReviewMode,
  modelSelection: ModelSelection,
): string {
  const model = resolveHomeAgentModelLabel(useServerConfigs(), {
    environmentId,
    modelSelection,
    session: null,
  });
  const label = agentReviewModeLabel(mode);
  return model === null ? label : `${label} · ${model}`;
}

/** The latest review a chat knows of: one it started, or one of its pull request. */
export interface LatestAgentReview {
  readonly threadId: ThreadId;
  readonly mode: AgentReviewMode;
  readonly focus: string | null;
  readonly scope: LocalReviewScope | null;
  readonly modelSelection: ModelSelection;
  readonly startedAt: string;
  /** When the reviewer's latest turn ended, for how long a review that is over took. */
  readonly endedAt: string | null;
  readonly progress: ReviewProgress;
  /** Its latest findings, final or so far. */
  readonly source: ReviewFindingsSource | null;
  /** How many of them are neither dismissed nor posted. */
  readonly openCount: number;
}

/**
 * A chat's agent reviews as its Review changes screen shows them: whether the chat is itself a
 * reviewer, and the latest review of it (its child agents' and its pull request's linked threads',
 * `threadReviewCandidates`). Reading them subscribes to those threads while the screen is open.
 */
export function useChatAgentReviews(ref: ScopedThreadRef): {
  readonly isReviewer: boolean;
  readonly latest: LatestAgentReview | null;
} {
  const shell = useThreadShell(ref);
  const pullRequests = useMemo(
    () => visibleThreadPullRequests(shell?.pullRequests ?? []),
    [shell?.pullRequests],
  );
  const linked = useAtomValue(
    linkedReviewThreadsAtom(
      shell === null
        ? null
        : { environmentId: ref.environmentId, threadId: ref.threadId, pullRequests },
    ),
  );
  const self = linked.find((thread) => thread.id === ref.threadId);
  const isReviewer = self !== undefined && reviewStartedRecord(self.activities) !== null;
  const latest = useMemo(() => selectLatestReview(linked), [linked]);
  const source = useMemo(
    () => (latest === null ? null : latestReviewFindingsSource(latest.thread)),
    [latest],
  );
  const dismissed = useDismissedReviewFindings(
    reviewFindingsCardKey(ref.environmentId, latest?.thread.id ?? ""),
  );
  const openCount = useMemo(() => {
    if (latest === null || source === null) return 0;
    return openReviewFindingCount(
      source.findings,
      reviewFindingMarksByKey(reviewFindingEntries(source.findings), dismissed),
      postedReviewFindings(latest.thread.activities, source.activityId),
    );
  }, [dismissed, latest, source]);
  return {
    isReviewer,
    latest:
      latest === null
        ? null
        : {
            threadId: latest.thread.id,
            mode: latest.mode,
            focus: latest.focus,
            scope: latest.scope,
            modelSelection: latest.thread.modelSelection,
            startedAt: latest.thread.createdAt,
            endedAt: latest.thread.endedAt,
            progress: latest.progress,
            source,
            openCount,
          },
  };
}

/**
 * Starts an agent review: `start` says so when it fails and resolves to the new reviewer's
 * thread, or null. One request at a time; `pending` disables what starts one meanwhile.
 */
export function useStartAgentReview(environmentId: EnvironmentId) {
  const startPullRequestReview = useAtomCommand(pullRequestEnvironment.startReview, {
    reportFailure: false,
  });
  const startLocalReview = useAtomCommand(reviewEnvironment.startLocal, { reportFailure: false });
  const capabilities = useEnvironmentServerConfig(environmentId)?.environment.capabilities;
  const [pending, setPending] = useState(false);
  // A second tap before the re-render that disables the button must not start a second review.
  const inFlight = useRef(false);
  const start = useCallback(
    async (request: AgentReviewRequest, choices: AgentReviewChoices): Promise<ThreadId | null> => {
      if (inFlight.current) return null;
      inFlight.current = true;
      setPending(true);
      const call = buildAgentReviewStart(request, choices, {
        canScope: canChooseLocalReviewScope(request, capabilities),
      });
      const result =
        call.method === "pullRequests.startReview"
          ? await startPullRequestReview({ environmentId, input: call.input })
          : await startLocalReview({ environmentId, input: call.input });
      inFlight.current = false;
      setPending(false);
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          Alert.alert(
            "Could not start the review",
            error instanceof Error ? error.message : "The review could not be started.",
          );
        }
        return null;
      }
      return result.value.threadId;
    },
    [capabilities, environmentId, startLocalReview, startPullRequestReview],
  );
  return { start, pending };
}

/**
 * Where a reviewer's work stands (`reviewRunState`): it and the agents it started, with agent
 * messages queued for them counted, and those agents for listing.
 */
export function useReviewerRun(
  environmentId: EnvironmentId,
  reviewer: EnvironmentThreadShell | null,
): {
  readonly run: ReviewRunState | null;
  readonly agents: ReadonlyArray<ChildAgentEntry<EnvironmentThreadShell>>;
} {
  const threads = useThreadShells();
  const control = useAtomValue(environmentAgentControlAtom(environmentId));
  const reviewerId = reviewer?.id ?? null;
  const agents = useMemo(
    () =>
      reviewerId === null
        ? []
        : collectChildAgents(threads, { environmentId, threadId: reviewerId }),
    [environmentId, reviewerId, threads],
  );
  const run = useMemo(
    () =>
      reviewer === null
        ? null
        : reviewRunState(
            reviewer,
            agents.map((agent) => agent.thread),
            (threadId) => control.get(threadId)?.queued ?? 0,
          ),
    [agents, control, reviewer],
  );
  return { run, agents };
}

/** Now, refreshed once a minute while `active`: a review's elapsed time is told in minutes. */
export function useMinuteClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}
