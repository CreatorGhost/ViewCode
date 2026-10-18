import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  openReviewFindingCount,
  reviewFindingEntries,
  reviewFindingMarksByKey,
  selectLatestReview,
  selectPullRequestReviewFindings,
} from "@t3tools/client-runtime/review-findings";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AGENT_REVIEW_MODES,
  type AgentReviewMode,
  DEFAULT_SERVER_SETTINGS,
  type PullRequestDetail,
  ThreadId,
  type ThreadPullRequestKey,
} from "@t3tools/contracts";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { postedReviewFindings, REVIEW_VERDICT_LABELS } from "@t3tools/shared/reviewFindings";
import { useMemo, useState } from "react";
import { Alert } from "react-native";

import { ControlPillMenu } from "../../components/ControlPillMenu";
import {
  buildModelOptions,
  resolveDefaultableModelSelection,
  resolveNewTaskModelSelection,
} from "../../lib/modelOptions";
import { useEnvironmentServerConfig, useProject } from "../../state/entities";
import { composerPullRequests } from "../../state/pull-requests";
import {
  linkedReviewThreadsAtom,
  reviewFindingsCardKey,
  useDismissedReviewFindings,
} from "../../state/review-findings";
import { useAtomCommand } from "../../state/use-atom-command";
import { useStickyComposerModelSelection } from "../../state/use-composer-drafts";
import { PullRequestCardGroup, PullRequestCardRow } from "./PullRequestControls";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";

const NO_POSTED = new Map<string, never>();

/**
 * ViewCode's agent review of a pull request: start one, follow it while it runs, and open the
 * newest findings any linked thread submitted. Web offers the same from its pull request view.
 */
export function PullRequestAgentReview(props: {
  readonly pr: PullRequestDetail;
  readonly params: PullRequestParams;
}) {
  const { params, pr } = props;
  const navigation = useNavigation();
  const target = pullRequestTarget(params);
  const { environmentId } = target;
  const serverConfig = useEnvironmentServerConfig(environmentId);
  const project = useProject(scopeProjectRef(environmentId, target.input.projectId));
  const stickyModelSelection = useStickyComposerModelSelection();
  const startReview = useAtomCommand(composerPullRequests.startReview, { reportFailure: false });
  const [startingReview, setStartingReview] = useState(false);
  // A review started here, until its thread shows up among the pull request's linked threads.
  const [startedReview, setStartedReview] = useState<{
    readonly threadId: ThreadId;
    readonly mode: AgentReviewMode;
  } | null>(null);
  const canStartReview = serverConfig?.environment.capabilities.pullRequestAgentReview === true;
  // An agent review starts on the model a new task in this project would: the project's default,
  // then the last model picked, then the provider's default.
  const reviewModelSelection = useMemo(() => {
    const projectDefault = resolveDefaultableModelSelection(
      serverConfig,
      resolveProjectSettings(
        serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS,
        target.input.projectId,
        project,
      ).settings.defaultModelSelection,
      target.input.projectId,
    );
    const sticky = resolveDefaultableModelSelection(
      serverConfig,
      stickyModelSelection,
      target.input.projectId,
    );
    return resolveNewTaskModelSelection({
      draftSelection: null,
      projectDefaultSelection: projectDefault,
      stickySelection: sticky,
      modelOptions: buildModelOptions(
        serverConfig,
        projectDefault ?? sticky,
        undefined,
        target.input.projectId,
      ),
    });
  }, [project, target.input.projectId, serverConfig, stickyModelSelection]);
  const startAgentReview = (mode: AgentReviewMode) => {
    if (startingReview) return;
    setStartingReview(true);
    void startReview({
      environmentId,
      input: {
        ...target.input,
        mode,
        ...(reviewModelSelection ? { modelSelection: reviewModelSelection } : {}),
        // Opened from a chat, the reviewer runs as that chat's agent, as it does from web.
        ...(params.threadId ? { sourceThreadId: ThreadId.make(params.threadId) } : {}),
      },
    })
      .then((result) => {
        if (result._tag === "Failure") {
          if (isAtomCommandInterrupted(result)) return;
          const error = squashAtomCommandFailure(result);
          Alert.alert(
            "Could not start the review",
            error instanceof Error ? error.message : "The review could not be started.",
          );
          return;
        }
        // Like web, the review runs in its own thread while this screen stays open; its
        // findings show here when it is done.
        setStartedReview({ threadId: result.value.threadId, mode });
      })
      .finally(() => setStartingReview(false));
  };

  // Agent reviews of this pull request: the newest findings any linked thread submitted, and a
  // review still under way.
  const pullRequestKey = useMemo<ThreadPullRequestKey | null>(() => {
    const host = params.host ?? parseChangeRequestUrl(pr.url)?.host ?? null;
    return host === null ? null : { host, repository: params.repository, number: params.number };
  }, [params.host, params.number, params.repository, pr.url]);
  const linkedReviews = useAtomValue(
    linkedReviewThreadsAtom(
      pullRequestKey === null
        ? null
        : { environmentId, threadId: null, pullRequests: [pullRequestKey] },
    ),
  );
  const reviewSource = useMemo(
    () =>
      pullRequestKey === null
        ? null
        : selectPullRequestReviewFindings({
            pullRequests: [pullRequestKey],
            threads: linkedReviews,
          }),
    [linkedReviews, pullRequestKey],
  );
  const runningReview = useMemo(() => {
    const latest = selectLatestReview(linkedReviews);
    if (latest?.progress.kind === "running") {
      return { threadId: latest.thread.id, mode: latest.mode };
    }
    return startedReview !== null &&
      !linkedReviews.some((thread) => thread.id === startedReview.threadId)
      ? startedReview
      : null;
  }, [linkedReviews, startedReview]);
  const reviewSourceActivities =
    reviewSource === null
      ? null
      : (linkedReviews.find((thread) => thread.id === reviewSource.threadId)?.activities ?? null);
  const reviewPosted = useMemo(
    () =>
      reviewSource === null || reviewSourceActivities === null
        ? NO_POSTED
        : postedReviewFindings(reviewSourceActivities, reviewSource.activityId),
    [reviewSource, reviewSourceActivities],
  );
  const reviewDismissed = useDismissedReviewFindings(
    reviewFindingsCardKey(environmentId, reviewSource?.threadId ?? ""),
  );
  const openFindingCount =
    reviewSource === null
      ? 0
      : openReviewFindingCount(
          reviewSource.findings,
          reviewFindingMarksByKey(reviewFindingEntries(reviewSource.findings), reviewDismissed),
          reviewPosted,
        );
  const runningReviewLabel =
    runningReview === null
      ? null
      : (AGENT_REVIEW_MODES.find((entry) => entry.mode === runningReview.mode)?.label ?? "Review");
  const openFindings = (threadId: string) =>
    navigation.navigate("ThreadReviewFindings", {
      environmentId: params.environmentId,
      threadId,
      ...(params.threadId ? { fromThreadId: params.threadId } : {}),
    });

  if (!canStartReview && reviewSource === null && runningReview === null) return null;
  return (
    <PullRequestCardGroup>
      {reviewSource !== null ? (
        <PullRequestCardRow
          title={REVIEW_VERDICT_LABELS[reviewSource.findings.verdict]}
          icon="checklist"
          value={openFindingCount === 0 ? "Nothing open" : `${openFindingCount} open`}
          compact
          accessibilityLabel="Agent review findings"
          onPress={() => openFindings(reviewSource.threadId)}
        />
      ) : null}
      {runningReview !== null ? (
        <PullRequestCardRow
          title={`${runningReviewLabel} under way`}
          icon="clock"
          compact
          accessibilityLabel="Open the review's findings as they arrive"
          onPress={() => openFindings(runningReview.threadId)}
        />
      ) : null}
      {canStartReview ? (
        <ControlPillMenu
          title="Review with agent"
          actions={AGENT_REVIEW_MODES.map((entry) => ({
            id: `review:${entry.mode}`,
            title: entry.label,
            subtitle: entry.description,
          }))}
          onPressAction={({ nativeEvent }) => {
            const next = AGENT_REVIEW_MODES.find(
              (entry) => `review:${entry.mode}` === nativeEvent.event,
            );
            if (next) startAgentReview(next.mode);
          }}
        >
          <PullRequestCardRow
            title="Review with agent"
            icon="sparkles"
            value={startingReview ? "Starting…" : undefined}
            compact
            menu
            accessibilityLabel="Review with agent"
          />
        </ControlPillMenu>
      ) : null}
    </PullRequestCardGroup>
  );
}
