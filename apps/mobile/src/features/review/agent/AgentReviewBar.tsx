import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { MenuAction } from "@react-native-menu/menu";
import { useNavigation } from "@react-navigation/native";
import {
  type AgentReviewRequest,
  type AgentReviewTarget,
  agentReviewRetryRequest,
  agentReviewTargetChoices,
  agentReviewTargetKey,
  agentReviewTargetLabel,
  inferAgentReviewTarget,
  localReviewScopeReady,
  reviewStatusText,
} from "@t3tools/client-runtime/agent-review";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AGENT_REVIEW_MODES,
  type AgentReviewMode,
  type EnvironmentId,
  type LocalReviewScope,
  type ModelSelection,
  type ThreadId,
} from "@t3tools/contracts";
import { REVIEW_VERDICT_LABELS } from "@t3tools/shared/reviewFindings";
import {
  resolveThreadCurrentPullRequestLink,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Platform, Pressable, View } from "react-native";

import { SymbolView } from "../../../components/AppSymbol";
import { AppText as Text } from "../../../components/AppText";
import { ControlPill, ControlPillMenu } from "../../../components/ControlPill";
import { cn } from "../../../lib/cn";
import { useEnvironmentServerConfig, useThreadShell } from "../../../state/entities";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../../state/preferences";
import { SidechatModelPicker } from "../../sidechat/SidechatModelPicker";
import type { ReviewSectionMenu } from "../review-section-menu";
import type { ReviewSectionItem } from "../reviewModel";
import {
  AGENT_REVIEW_MODE_SHORT_LABELS,
  type LatestAgentReview,
  agentReviewModeLabel,
  useAgentReviewLabel,
  useChatAgentReviews,
  useMinuteClock,
  useStartAgentReview,
} from "./useAgentReviews";

const COMMIT_EVENT = "commit";

function sectionHasChanges(section: ReviewSectionItem | null): boolean | null {
  if (section === null) return false;
  if (section.isLoading && section.diff === null) return null;
  return Boolean(section.diff?.trim() || section.files?.length);
}

/**
 * Agent review at the top of a chat's Review changes: Find issues starts one on what the diff on
 * screen is about (`inferAgentReviewTarget`), at the depth last picked on this device and on the
 * chat's model unless picked otherwise here; the menu also says what it reads and offers the
 * rest. Below, where the latest review stands, opening its findings. The reviewer runs as this
 * chat's agent. Nothing for a chat that is itself a reviewer, or a server without agent review.
 */
export function AgentReviewBar(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly sections: ReviewSectionMenu;
  readonly selectedSection: ReviewSectionItem | null;
  /** A commit picked in the commit sheet, to review now; taken back with `onCommitTaken`. */
  readonly commitToReview: string | null;
  readonly onCommitTaken: () => void;
}) {
  const { environmentId, threadId } = props;
  const navigation = useNavigation();
  const ref = useMemo(() => scopeThreadRef(environmentId, threadId), [environmentId, threadId]);
  const shell = useThreadShell(ref);
  const serverConfig = useEnvironmentServerConfig(environmentId);
  const capabilities = serverConfig?.environment.capabilities;
  const canReviewPullRequest = capabilities?.pullRequestAgentReview === true;
  const canReviewLocal = capabilities?.localAgentReview === true;
  const canScope = canReviewLocal && capabilities?.localAgentReviewScope === true;
  const { isReviewer, latest } = useChatAgentReviews(ref);
  const { start, pending } = useStartAgentReview(environmentId);
  const reviewer = useThreadShell(
    useMemo(
      () => (latest === null ? null : scopeThreadRef(environmentId, latest.threadId)),
      [environmentId, latest],
    ),
  );
  // Try again repeats the latest review as it was asked for (`agentReviewRetryRequest`).
  const retryRequest =
    latest === null || reviewer === null
      ? null
      : agentReviewRetryRequest({
          reviewer,
          scope: latest.scope,
          findingsTarget: latest.source?.findings.target ?? null,
        });

  const pullRequest = useMemo(
    () =>
      canReviewPullRequest
        ? resolveThreadCurrentPullRequestLink(visibleThreadPullRequests(shell?.pullRequests ?? []))
        : null,
    [canReviewPullRequest, shell?.pullRequests],
  );
  const pullRequestNumber = pullRequest?.number ?? null;
  const { workingTree, branchChanges } = props.sections;
  const branchBase = branchChanges?.source?.baseRef ?? null;
  const branchChanged = sectionHasChanges(branchChanges) === true;
  const changes = useMemo(
    () => ({
      pullRequestNumber,
      dirty: sectionHasChanges(workingTree),
      branch: branchChanged
        ? {
            // A base the server would refuse is left to it to find.
            base:
              branchBase !== null && localReviewScopeReady({ kind: "branch", base: branchBase })
                ? branchBase
                : null,
          }
        : null,
      canReviewLocal,
      canScope,
    }),
    [branchBase, branchChanged, canReviewLocal, canScope, pullRequestNumber, workingTree],
  );
  const choices = useMemo(() => agentReviewTargetChoices(changes), [changes]);
  const sectionId = props.selectedSection?.id ?? null;
  const inferred = useMemo(
    () => inferAgentReviewTarget(props.selectedSection?.kind ?? null, changes),
    [changes, props.selectedSection?.kind],
  );
  // A pick holds while the reader stays on the diff they picked it on; another diff infers again.
  const [picked, setPicked] = useState<{
    readonly sectionId: string | null;
    readonly key: string;
  } | null>(null);
  const target =
    (picked?.sectionId === sectionId
      ? choices.find((choice) => agentReviewTargetKey(choice) === picked.key)
      : undefined) ?? inferred;

  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const mode: AgentReviewMode =
    (AsyncResult.isSuccess(preferences) ? preferences.value.agentReviewMode : undefined) ?? "quick";
  // The chat's own model unless picked otherwise, for this screen only.
  const [pickedModel, setPickedModel] = useState<ModelSelection | null>(null);
  const modelSelection = pickedModel ?? shell?.modelSelection ?? null;

  const request = useCallback(
    (kind: AgentReviewTarget["kind"]): AgentReviewRequest | null => {
      if (shell === null) return null;
      if (kind === "local")
        return { kind: "local", projectId: shell.projectId, sourceThreadId: threadId };
      if (pullRequest === null) return null;
      const { host, repository, number } = pullRequest;
      return {
        kind: "pull-request",
        reference: { projectId: shell.projectId, host, repository, number },
        sourceThreadId: threadId,
      };
    },
    [pullRequest, shell, threadId],
  );
  const openFindings = useCallback(
    (reviewThreadId: ThreadId) =>
      navigation.navigate("ThreadReviewFindings", {
        environmentId,
        threadId: reviewThreadId,
        fromThreadId: threadId,
      }),
    [environmentId, navigation, threadId],
  );
  const startReview = useCallback(
    async (kind: AgentReviewTarget["kind"], scope: LocalReviewScope | null) => {
      const asked = request(kind);
      if (asked === null) return;
      const started = await start(asked, { mode, modelSelection, focus: "", scope });
      if (started !== null) openFindings(started);
    },
    [mode, modelSelection, openFindings, request, start],
  );

  const { commitToReview, onCommitTaken } = props;
  useEffect(() => {
    if (commitToReview === null) return;
    onCommitTaken();
    void startReview("local", { kind: "commit", sha: commitToReview });
  }, [commitToReview, onCommitTaken, startReview]);

  if (!canReviewPullRequest && !canReviewLocal) return null;
  if (shell === null || isReviewer) return null;

  const canPickCommit = canScope;
  const targetLabel = target === null ? null : agentReviewTargetLabel(target, pullRequestNumber);
  const android = Platform.OS === "android";
  const actions: MenuAction[] = [
    {
      id: "depth",
      title: "Depth",
      displayInline: true,
      ...(android ? { subtitle: agentReviewModeLabel(mode) } : {}),
      subactions: AGENT_REVIEW_MODES.map((entry) => ({
        id: `mode:${entry.mode}`,
        title: entry.label,
        subtitle: entry.description,
        state: entry.mode === mode ? "on" : "off",
      })),
    },
    ...(choices.length > 0 || canPickCommit
      ? [
          {
            id: "target",
            title: "What to review",
            displayInline: true,
            ...(android && targetLabel !== null ? { subtitle: targetLabel } : {}),
            subactions: [
              ...choices.map((choice) => ({
                id: `target:${agentReviewTargetKey(choice)}`,
                title: agentReviewTargetLabel(choice, pullRequestNumber),
                state:
                  target !== null && agentReviewTargetKey(choice) === agentReviewTargetKey(target)
                    ? ("on" as const)
                    : ("off" as const),
              })),
              ...(canPickCommit ? [{ id: COMMIT_EVENT, title: "A commit…" }] : []),
            ],
          } satisfies MenuAction,
        ]
      : []),
  ];
  const onMenuAction = (event: string) => {
    const nextMode = AGENT_REVIEW_MODES.find((entry) => `mode:${entry.mode}` === event)?.mode;
    if (nextMode !== undefined) {
      savePreferences({ agentReviewMode: nextMode });
      return;
    }
    if (event === COMMIT_EVENT) {
      navigation.navigate("ThreadReviewCommits", { environmentId, threadId });
      return;
    }
    if (event.startsWith("target:")) {
      setPicked({ sectionId, key: event.slice("target:".length) });
    }
  };

  return (
    <View className="px-4 pt-3">
      <View className="gap-1 rounded-2xl bg-card px-2 py-2">
        <View className="flex-row items-center gap-1">
          <ControlPill
            variant="primary"
            icon="magnifyingglass"
            label={pending ? "Starting…" : "Find issues"}
            accessibilityLabel={
              targetLabel === null ? "Find issues" : `Find issues in ${targetLabel}`
            }
            disabled={pending || target === null || modelSelection === null}
            onPress={() => {
              if (target === null) return;
              void startReview(target.kind, target.kind === "local" ? target.scope : null);
            }}
          />
          <ControlPillMenu
            title="Agent review"
            accessibilityLabel={`Review depth: ${agentReviewModeLabel(mode)}`}
            actions={actions}
            onPressAction={({ nativeEvent }) => onMenuAction(nativeEvent.event)}
          >
            <View className="h-11 flex-row items-center gap-1.5 rounded-xl px-2">
              <Text className="text-sm font-t3-medium text-foreground">
                {AGENT_REVIEW_MODE_SHORT_LABELS[mode]}
              </Text>
              <SymbolView
                name="chevron.down"
                size={10}
                tintColorClassName="accent-icon"
                type="monochrome"
              />
            </View>
          </ControlPillMenu>
          <View className="min-w-0 flex-1 flex-row justify-end">
            {modelSelection !== null ? (
              <SidechatModelPicker
                environmentId={environmentId}
                serverConfig={serverConfig}
                selection={modelSelection}
                runtimeMode={shell.runtimeMode}
                sessionInstanceId={null}
                disabled={pending}
                onChange={setPickedModel}
                title="Review model"
                accessibilityLabel="Review model"
              />
            ) : null}
          </View>
        </View>
        <Text className="px-2 text-xs text-foreground-muted" numberOfLines={1}>
          {targetLabel === null ? "No changes to review" : `Reviews ${lowerFirst(targetLabel)}`}
        </Text>
        {latest !== null ? (
          <AgentReviewStatusRow
            environmentId={environmentId}
            review={latest}
            onOpen={() => openFindings(latest.threadId)}
            onRetry={
              retryRequest === null
                ? null
                : () =>
                    void start(retryRequest, {
                      mode: latest.mode,
                      modelSelection: latest.modelSelection,
                      focus: latest.focus ?? "",
                      scope: latest.scope,
                    }).then((started) => {
                      if (started !== null) openFindings(started);
                    })
            }
            retrying={pending}
          />
        ) : null}
      </View>
    </View>
  );
}

/** "This PR #12" reads "this PR #12" mid-sentence; "Current changes", "current changes". */
function lowerFirst(text: string): string {
  return text.length === 0 ? text : `${text[0]!.toLowerCase()}${text.slice(1)}`;
}

/** Where the latest review stands, in the words web uses; opens its findings. */
function AgentReviewStatusRow(props: {
  readonly environmentId: EnvironmentId;
  readonly review: LatestAgentReview;
  readonly onOpen: () => void;
  /** Null when the review cannot be asked for again from here. */
  readonly onRetry: (() => void) | null;
  readonly retrying: boolean;
}) {
  const { review } = props;
  const { progress } = review;
  const label = useAgentReviewLabel(props.environmentId, review.mode, review.modelSelection);
  const now = useMinuteClock(progress.kind === "running");
  const findings = review.source?.findings ?? null;
  const soFar = findings === null ? 0 : findings.findings.length + findings.needsChecking.length;
  const text =
    progress.kind === "done"
      ? `${findings === null ? "Done" : REVIEW_VERDICT_LABELS[findings.verdict]} · ${
          review.openCount === 0 ? "nothing open" : `${review.openCount} open`
        }`
      : `${reviewStatusText({
          progress,
          label,
          elapsedMs: now - Date.parse(review.startedAt),
          newer: false,
        })}${progress.kind === "running" && progress.partial ? ` · ${soFar} so far` : ""}`;
  return (
    <View className="flex-row items-center gap-1">
      <Pressable
        accessibilityRole="button"
        accessibilityHint="Opens the review's findings."
        onPress={props.onOpen}
        className="min-h-11 min-w-0 flex-1 flex-row items-center gap-2 rounded-xl px-2 active:bg-subtle"
      >
        <View
          className={cn(
            "size-2 rounded-full",
            progress.kind === "running"
              ? "bg-adaptive-sky-600-400"
              : progress.kind === "failed"
                ? "bg-adaptive-rose-600-400"
                : "bg-foreground-muted",
          )}
        />
        <Text
          className={cn(
            "min-w-0 flex-1 text-sm",
            progress.kind === "failed" ? "text-adaptive-rose-700-300" : "text-foreground",
          )}
          numberOfLines={1}
        >
          {text}
        </Text>
        <SymbolView
          name="chevron.right"
          size={12}
          tintColorClassName="accent-icon-subtle"
          type="monochrome"
        />
      </Pressable>
      {progress.kind === "failed" && props.onRetry !== null ? (
        <ControlPill
          variant="pill"
          label={props.retrying ? "Starting…" : "Try again"}
          disabled={props.retrying}
          onPress={props.onRetry}
        />
      ) : null}
    </View>
  );
}
