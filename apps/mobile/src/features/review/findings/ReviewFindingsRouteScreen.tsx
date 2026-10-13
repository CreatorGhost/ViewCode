import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  type AgentReviewChoices,
  type AgentReviewRequest,
  agentReviewRetryRequest,
  localReviewScopeLabel,
  reviewedChangeLabel,
  reviewFindingsSentText,
  reviewStatusText,
  reviewStopPlan,
} from "@t3tools/client-runtime/agent-review";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  groupReviewFindingsBySeverity,
  reviewFindingsInFileOrder,
  reviewIssueOrder,
  type ReviewFindingEntry,
  reviewFindingIdentity,
  reviewFindingMarksByKey,
  reviewFixAllMode,
  reviewPostAllWaits,
  type ReviewProgress,
  reviewProgress,
  reviewRunWithErrors,
} from "@t3tools/client-runtime/review-findings";
import {
  type ChildAgentEntry,
  resolveSpawnedAgentRowStatus,
  SPAWNED_AGENT_STATUS_LABEL,
  spawnedAgentElapsedRange,
} from "@t3tools/client-runtime/state/child-agents";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type AgentReviewMode,
  EnvironmentId,
  type ReviewFindingRating,
  type ReviewFindingsActivityPayload,
  type ReviewVerdict,
  ThreadId,
} from "@t3tools/contracts";
import {
  REVIEW_FINDING_SEVERITY_LABELS,
  REVIEW_VERDICT_LABELS,
  reviewFindingsMode,
} from "@t3tools/shared/reviewFindings";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, Alert, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { type AppSymbolName, SymbolView } from "../../../components/AppSymbol";
import { AppText as Text } from "../../../components/AppText";
import { ControlPill } from "../../../components/ControlPill";
import { EmptyState } from "../../../components/EmptyState";
import { MaterialScreenContent } from "../../../components/MaterialScreenContent";
import { ScreenHeader } from "../../../components/ScreenHeader";
import { cn } from "../../../lib/cn";
import { tryOpenExternalUrl } from "../../../lib/openExternalUrl";
import { relativeTime } from "../../../lib/time";
import { useEnvironmentServerConfig, useThreadShells } from "../../../state/entities";
import { reviewEnvironment } from "../../../state/review";
import {
  reviewFindingsCardKey,
  setReviewFindingDismissed,
  useDismissedReviewFindings,
  useSentReviewFindings,
} from "../../../state/review-findings";
import { useAtomCommand } from "../../../state/use-atom-command";
import { useAgentControlActions } from "../../agents/useAgentControlActions";
import {
  useAgentReviewLabel,
  useMinuteClock,
  useReviewerRun,
  useStartAgentReview,
} from "../agent/useAgentReviews";
import {
  REVIEW_SEVERITY_PRESENTATION,
  type ReviewFindingAction,
  ReviewFindingRow,
} from "./ReviewFindingRow";
import { useReviewFix } from "./useReviewFix";
import { useReviewThreadFindings } from "./useReviewThreadFindings";

type ReviewFindingsRouteParams = {
  readonly environmentId: string;
  /** The review thread whose findings these are. */
  readonly threadId: string;
  /** The chat the reader came from, when it is not the review: fixes are sent into it. */
  readonly fromThreadId?: string;
};

const FOOTER_BUTTON_HEIGHT = 56;

const VERDICT_CHIP: Record<ReviewVerdict, { readonly className: string; readonly text: string }> = {
  approve: { className: "bg-adaptive-emerald-500-a12-a16", text: "text-adaptive-emerald-700-300" },
  "approve-with-nits": {
    className: "bg-adaptive-sky-500-a12-a16",
    text: "text-adaptive-sky-700-300",
  },
  "request-changes": {
    className: "bg-adaptive-amber-500-a12-a16",
    text: "text-adaptive-amber-700-300",
  },
};


function SummaryRow(props: {
  readonly icon: AppSymbolName;
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <View className="min-h-[44px] flex-row items-center gap-3 py-2">
      <SymbolView
        name={props.icon}
        size={18}
        tintColorClassName="accent-foreground-muted"
        type="monochrome"
      />
      <Text className="w-[124px] text-[15px] text-foreground-muted">{props.label}</Text>
      <View className="min-w-0 flex-1">{props.children}</View>
    </View>
  );
}

/**
 * An agent review's latest findings on a phone: where the review stands while it is not done
 * (running, failed or ended), what the reviewer concluded, then the findings by severity, each
 * opening to its detail and suggested fix. No diff here, unlike web: a phone has no room to read
 * findings under their lines, so each says where it is instead. Findings sent while the review
 * works show as they arrive.
 */
export function ReviewFindingsRouteScreen({ route }: StaticScreenProps<ReviewFindingsRouteParams>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const reviewThreadId = ThreadId.make(route.params.threadId);
  const reviewRef = useMemo(
    () => scopeThreadRef(environmentId, reviewThreadId),
    [environmentId, reviewThreadId],
  );
  const {
    shell: reviewer,
    source,
    entries,
    posted,
    ratings,
    loading,
    started,
    activities,
  } = useReviewThreadFindings(reviewRef);
  const serverConfig = useEnvironmentServerConfig(environmentId);
  const canRate = serverConfig?.environment.capabilities.reviewFindingRatings === true;
  const findings = source?.findings ?? null;
  const { run, agents } = useReviewerRun(environmentId, reviewer);
  // Only a review thread has a run to tell; an older one without its start record reads as done.
  // One that stopped after a provider error failed, whatever turns ran after it.
  const progress =
    started === null || run === null
      ? null
      : reviewProgress({ run: reviewRunWithErrors(run, activities), findings });
  const stillReviewing = progress?.kind === "running";
  // A review just asked for may reach this phone before its thread or its start record does.
  const waiting = loading || reviewer === null || (started === null && run?.kind === "running");

  // The reader's marks belong to the review, by finding identity, so they hold when its next set
  // of findings arrives.
  const cardKey = reviewFindingsCardKey(environmentId, reviewThreadId);
  const dismissedByIdentity = useDismissedReviewFindings(cardKey);
  const sentByIdentity = useSentReviewFindings(cardKey);
  const dismissed = useMemo(
    () => reviewFindingMarksByKey(entries, dismissedByIdentity),
    [dismissedByIdentity, entries],
  );
  const sent = useMemo(
    () => reviewFindingMarksByKey(entries, sentByIdentity),
    [entries, sentByIdentity],
  );
  const [showDismissed, setShowDismissed] = useState(false);
  // By identity too, so a finding stays open when the next set arrives; null until findings show.
  const [expanded, setExpanded] = useState<ReadonlySet<string> | null>(null);

  // Most severe first, each severity in file order, as web lists issues; Fix all follows it too.
  const ordered = useMemo(() => {
    const byKey = new Map(entries.map((entry) => [entry.key, entry] as const));
    return reviewIssueOrder(
      [],
      reviewFindingsInFileOrder(entries).map((entry) => ({ entry })),
    ).flatMap((key) => byKey.get(key) ?? []);
  }, [entries]);
  const dismissedCount = entries.filter((entry) => dismissed[entry.key]).length;
  const openEntries = ordered.filter((entry) => !dismissed[entry.key]);
  const groups = useMemo(
    () =>
      groupReviewFindingsBySeverity(
        showDismissed ? ordered : ordered.filter((entry) => !dismissed[entry.key]),
      ),
    [dismissed, ordered, showDismissed],
  );
  // The first open finding opens by itself when findings first show, as web goes to it.
  const firstOpen = groups[0]?.entries[0] ?? null;
  if (expanded === null && firstOpen !== null) {
    setExpanded(new Set([reviewFindingIdentity(firstOpen.finding)]));
  }

  const toggleExpanded = useCallback(
    (entry: ReviewFindingEntry) =>
      setExpanded((current) => {
        const identity = reviewFindingIdentity(entry.finding);
        const next = new Set(current ?? []);
        if (!next.delete(identity)) next.add(identity);
        return next;
      }),
    [],
  );
  const dismiss = useCallback(
    (entry: ReviewFindingEntry, value: boolean) =>
      setReviewFindingDismissed(cardKey, reviewFindingIdentity(entry.finding), value),
    [cardKey],
  );
  const rateFinding = useAtomCommand(reviewEnvironment.rateFinding, { reportFailure: false });
  const activityId = source?.activityId ?? null;
  // Rating a finding the way it is already rated takes the rating back.
  const rate = useCallback(
    (entry: ReviewFindingEntry, rating: ReviewFindingRating) => {
      if (activityId === null) return;
      void rateFinding({
        environmentId,
        input: {
          reviewThreadId,
          findingsActivityId: activityId,
          findingKey: entry.key,
          rating: ratings.get(entry.key) === rating ? null : rating,
        },
      }).then((result) => {
        if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        Alert.alert(
          "Could not save the rating",
          error instanceof Error ? error.message : "The rating could not be saved.",
        );
      });
    },
    [activityId, environmentId, rateFinding, ratings, reviewThreadId],
  );
  const openPosted = useCallback((url: string) => {
    void tryOpenExternalUrl(url, "pull-request").then((opened) => {
      if (!opened) Alert.alert("Unable to open PR", "The pull request could not be opened.");
    });
  }, []);

  const verdictChip = findings ? VERDICT_CHIP[findings.verdict] : null;

  // Fixing is a message sent into the chat the reader came from, else the chat the review
  // belongs to (`useReviewFix`): no dialog, and the reader stays here.
  const fromThreadId = route.params.fromThreadId;
  const chatThreadId =
    fromThreadId !== undefined && fromThreadId !== reviewThreadId
      ? ThreadId.make(fromThreadId)
      : null;
  const { fix } = useReviewFix({
    environmentId,
    reviewThreadId,
    reviewTitle: source?.threadTitle ?? "",
    fromThreadId: chatThreadId,
    target: findings?.target ?? null,
  });
  const fixAction = useMemo<ReviewFindingAction>(
    () => ({ label: "Fix with agent", icon: "hammer", run: (entry) => void fix([entry]) }),
    [fix],
  );
  const fixAll = () => {
    if (reviewFixAllMode(openEntries.length) === "send") {
      void fix(openEntries);
      return;
    }
    navigation.navigate("ThreadReviewFindingsFix", {
      environmentId,
      threadId: reviewThreadId,
      keys: openEntries.map((entry) => entry.key).join(","),
      ...(chatThreadId === null ? {} : { fromThreadId: chatThreadId }),
    });
  };

  // Somebody else's pull request: findings are posted to it as review comments, not fixed, and
  // only ever behind the post sheet's own tap.
  const commentMode =
    findings !== null &&
    reviewFindingsMode(findings) === "comment" &&
    findings.target.kind === "pull-request";
  const [ticks, setTicks] = useState<ReadonlySet<string>>(() => new Set());
  const tick = useCallback(
    (entry: ReviewFindingEntry) =>
      setTicks((current) => {
        const next = new Set(current);
        if (!next.delete(entry.key)) next.add(entry.key);
        return next;
      }),
    [],
  );
  const startPost = useCallback(
    (keys: ReadonlyArray<string>) => {
      if (keys.length === 0) return;
      navigation.navigate("ThreadReviewFindingsPost", {
        environmentId,
        threadId: reviewThreadId,
        keys: keys.join(","),
      });
    },
    [environmentId, navigation, reviewThreadId],
  );
  const postAction = useMemo<ReviewFindingAction>(
    () => ({ label: "Post comment", icon: "text.bubble", run: (entry) => startPost([entry.key]) }),
    [startPost],
  );
  const unposted = openEntries.filter((entry) => !posted.has(entry.key));
  const tickedKeys = unposted.filter((entry) => ticks.has(entry.key)).map((entry) => entry.key);
  // A review still at work may change or drop what it sent so far: Post all waits for it.
  const postAllWaits = reviewPostAllWaits({
    commentMode,
    tickedCount: tickedKeys.length,
    stillReviewing,
  });
  const primary: {
    label: string;
    icon: AppSymbolName;
    disabled: boolean;
    run: () => void;
  } | null = commentMode
    ? unposted.length === 0
      ? null
      : tickedKeys.length > 0
        ? {
            label: `Post selected (${tickedKeys.length})`,
            icon: "text.bubble",
            disabled: false,
            run: () => startPost(tickedKeys),
          }
        : {
            label: postAllWaits ? "Wait for the review to finish" : `Post all (${unposted.length})`,
            icon: "text.bubble",
            disabled: postAllWaits,
            run: () => startPost(unposted.map((entry) => entry.key)),
          }
    : openEntries.length > 0
      ? { label: "Fix all", icon: "hammer", disabled: false, run: fixAll }
      : null;
  const footerHeight =
    primary === null ? 0 : FOOTER_BUTTON_HEIGHT + 12 + Math.max(insets.bottom, 16);
  const issueCount =
    findings === null ? 0 : findings.findings.length + findings.needsChecking.length;

  // Try again repeats the review as it was asked for, as the same chat's agent.
  const retryRequest =
    reviewer === null || started === null
      ? null
      : agentReviewRetryRequest({
          reviewer,
          scope: started.scope,
          findingsTarget: findings?.target ?? null,
        });
  const retry =
    retryRequest === null || reviewer === null || started === null
      ? null
      : {
          request: retryRequest,
          choices: {
            mode: started.mode ?? "quick",
            modelSelection: reviewer.modelSelection,
            focus: started.focus ?? "",
            scope: started.scope,
          },
        };
  // What was reviewed, as web's header names it: "PR #12", "Branch vs origin/main", "Commit 7523ce0".
  const changeLabel =
    source !== null
      ? reviewedChangeLabel(source.findings.target, source.scope, null)
      : started?.scope
        ? localReviewScopeLabel(started.scope)
        : null;
  const statusBlock =
    progress !== null && progress.kind !== "done" && reviewer !== null && started !== null ? (
      <ReviewStatusBlock
        environmentId={environmentId}
        reviewer={reviewer}
        mode={started.mode ?? "quick"}
        progress={progress}
        agents={agents}
        findings={findings}
        onViewAgent={() =>
          navigation.navigate("Thread", { environmentId, threadId: reviewThreadId })
        }
        retry={retry}
        onRetried={(threadId) =>
          navigation.dispatch(
            StackActions.replace("ThreadReviewFindings", {
              environmentId,
              threadId,
              ...(fromThreadId === undefined ? {} : { fromThreadId }),
            }),
          )
        }
      />
    ) : null;

  return (
    <View className={Platform.OS === "android" ? "flex-1 bg-header" : "flex-1 bg-screen"}>
      <ScreenHeader
        title="Review findings"
        subtitle={changeLabel ?? undefined}
        onBack={() => navigation.goBack()}
        sidebar={false}
      />
      <MaterialScreenContent>
        {findings === null || source === null || verdictChip === null ? (
          statusBlock !== null ? (
            <ScrollView
              className="flex-1 bg-screen"
              contentInsetAdjustmentBehavior="automatic"
              contentContainerStyle={{
                paddingHorizontal: 16,
                paddingBottom: Math.max(insets.bottom, 16) + 24,
              }}
            >
              {statusBlock}
              {progress?.kind === "running" ? (
                <Text className="mt-5 px-1 text-[15px] text-foreground-muted">
                  Findings show here as the reviewer verifies them.
                </Text>
              ) : null}
            </ScrollView>
          ) : (
            <View className="flex-1 items-center justify-center bg-screen px-8">
              {waiting ? (
                <ActivityIndicator colorClassName="accent-icon-muted" />
              ) : (
                <EmptyState
                  variant="plain"
                  title="No findings"
                  detail="This thread has not submitted review findings."
                />
              )}
            </View>
          )
        ) : (
          <View className="flex-1 bg-screen">
            <ScrollView
              className="flex-1"
              contentInsetAdjustmentBehavior="automatic"
              contentContainerStyle={{
                paddingHorizontal: 16,
                paddingBottom: Math.max(footerHeight, Math.max(insets.bottom, 16)) + 24,
              }}
            >
              {statusBlock}
              <View className="mt-3 rounded-[22px] bg-grouped-card px-4 py-1.5">
                {findings.complete === false ? null : (
                  <>
                    <SummaryRow icon="checklist" label="Verdict">
                      <View className="flex-row">
                        <View className={cn("rounded-full px-3 py-1", verdictChip.className)}>
                          <Text className={cn("text-sm font-t3-bold", verdictChip.text)}>
                            {REVIEW_VERDICT_LABELS[findings.verdict]}
                          </Text>
                        </View>
                      </View>
                    </SummaryRow>
                    <SummaryRow icon="checkmark.circle" label="Merge confidence">
                      <Text className="text-[15px] text-foreground">
                        {findings.mergeConfidence}/5
                      </Text>
                    </SummaryRow>
                    <SummaryRow icon="clock" label="Review effort">
                      <Text className="text-[15px] text-foreground">{findings.reviewEffort}/5</Text>
                    </SummaryRow>
                  </>
                )}
                <SummaryRow
                  icon={findings.target.kind === "pull-request" ? "arrow.triangle.pull" : "folder"}
                  label="Target"
                >
                  <Text className="text-[15px] text-foreground" numberOfLines={1}>
                    {findings.target.kind === "pull-request"
                      ? `${findings.target.repository} #${findings.target.number}`
                      : changeLabel}
                  </Text>
                </SummaryRow>
                <SummaryRow icon="person.crop.circle" label="Reviewed by">
                  <Text className="text-[15px] text-foreground" numberOfLines={2}>
                    {chatThreadId === null ? (
                      source.threadTitle || "Review thread"
                    ) : (
                      <Text
                        accessibilityRole="link"
                        className="text-[15px] text-foreground underline"
                        onPress={() =>
                          navigation.navigate("Thread", { environmentId, threadId: reviewThreadId })
                        }
                      >
                        {source.threadTitle || "Review thread"}
                      </Text>
                    )}
                    <Text className="text-[15px] text-foreground-muted">
                      {` · ${relativeTime(source.createdAt)} ago`}
                    </Text>
                  </Text>
                </SummaryRow>
              </View>

              <View className="mt-5 flex-row items-center gap-2 px-1">
                <Text className="flex-1 text-[15px] text-foreground-muted">
                  {stillReviewing
                    ? `Still reviewing — ${issueCount} so far`
                    : openEntries.length === 0
                      ? "No issues"
                      : `${openEntries.length} ${openEntries.length === 1 ? "issue" : "issues"}`}
                </Text>
                {dismissedCount > 0 ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected: showDismissed }}
                    hitSlop={6}
                    onPress={() => setShowDismissed((value) => !value)}
                    className="min-h-9 justify-center rounded-full bg-subtle px-3 active:opacity-70"
                  >
                    <Text className="text-[13px] font-t3-medium text-foreground">
                      {dismissedCount} dismissed · {showDismissed ? "Hide" : "Show"}
                    </Text>
                  </Pressable>
                ) : null}
              </View>

              {groups.map((group) => {
                const severity = REVIEW_SEVERITY_PRESENTATION[group.severity];
                return (
                  <View key={group.severity} className="mt-4">
                    <Text
                      accessibilityRole="header"
                      className={cn(
                        "mb-1.5 px-1 text-xs font-t3-bold tracking-[0.9px] uppercase",
                        severity.text,
                      )}
                    >
                      {REVIEW_FINDING_SEVERITY_LABELS[group.severity]} ({group.entries.length})
                    </Text>
                    <View className="overflow-hidden rounded-[22px] bg-grouped-card">
                      {group.entries.map((entry, index) => (
                        <View key={entry.key}>
                          {index > 0 ? <View className="ml-4 h-px bg-border-subtle" /> : null}
                          <ReviewFindingRow
                            entry={entry}
                            expanded={expanded?.has(reviewFindingIdentity(entry.finding)) === true}
                            dismissed={dismissed[entry.key] === true}
                            rating={ratings.get(entry.key)}
                            canRate={canRate}
                            posted={posted.get(entry.key)}
                            sentTo={sent[entry.key]}
                            action={commentMode ? postAction : fixAction}
                            {...(commentMode && !posted.has(entry.key)
                              ? { ticked: ticks.has(entry.key), onTick: tick }
                              : {})}
                            onToggleExpanded={toggleExpanded}
                            onDismiss={dismiss}
                            onRate={rate}
                            onOpenPosted={openPosted}
                          />
                        </View>
                      ))}
                    </View>
                  </View>
                );
              })}
            </ScrollView>
            {primary !== null ? (
              <View
                className="absolute inset-x-0 bottom-0 border-t border-border-subtle bg-screen px-4 pt-3"
                style={{ paddingBottom: Math.max(insets.bottom, 16) }}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: primary.disabled }}
                  disabled={primary.disabled}
                  onPress={primary.run}
                  className={cn(
                    "flex-row items-center justify-center gap-2.5 rounded-full bg-foreground active:opacity-70",
                    primary.disabled && "opacity-50",
                  )}
                  style={{ height: FOOTER_BUTTON_HEIGHT }}
                >
                  <SymbolView name={primary.icon} size={20} tintColorClassName="accent-screen" />
                  <Text className="text-[17px] font-t3-bold text-screen" numberOfLines={1}>
                    {primary.label}
                  </Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        )}
      </MaterialScreenContent>
    </View>
  );
}

/**
 * Where a review that is not done stands, above its findings: while it runs, how long, at what
 * depth and on which model, and the agents it started, with View agent and Stop; once it stopped
 * without its final findings, why, with Try again. Stop stops the reviewer and its own agents
 * only: the chat it belongs to is in the same agent tree.
 */
function ReviewStatusBlock(props: {
  readonly environmentId: EnvironmentId;
  readonly reviewer: EnvironmentThreadShell;
  readonly mode: AgentReviewMode;
  readonly progress: Exclude<ReviewProgress, { readonly kind: "done" }>;
  readonly agents: ReadonlyArray<ChildAgentEntry<EnvironmentThreadShell>>;
  /** The findings it sent so far, if any. */
  readonly findings: ReviewFindingsActivityPayload | null;
  readonly onViewAgent: () => void;
  readonly retry: {
    readonly request: AgentReviewRequest;
    readonly choices: AgentReviewChoices;
  } | null;
  readonly onRetried: (threadId: ThreadId) => void;
}) {
  const { environmentId, reviewer, progress, agents } = props;
  const label = useAgentReviewLabel(environmentId, props.mode, reviewer.modelSelection);
  const now = useMinuteClock(progress.kind === "running");
  const actions = useAgentControlActions();
  const { start, pending } = useStartAgentReview(environmentId);
  const [stopping, setStopping] = useState(false);
  const endMs = spawnedAgentElapsedRange(reviewer)?.endMs ?? null;
  const text = reviewStatusText({
    progress,
    label,
    elapsedMs: now - Date.parse(reviewer.createdAt),
    // Once it is over, how long it took ("took 3 min").
    durationMs: endMs === null ? null : endMs - Date.parse(reviewer.createdAt),
    newer: false,
  });
  // Under it, while findings arrive the step web names ("Sent 2 findings so far"); once the
  // review stopped, what it was.
  const detail =
    progress.kind === "running"
      ? props.findings === null
        ? null
        : reviewFindingsSentText(props.findings)
      : label;
  const threads = useThreadShells();
  // Stopped for good, as web stops it (`reviewStopPlan`): the reviewer and its working agents,
  // then discard for its agents and the reviewer so nothing is left paused. The chat it belongs to
  // is in the same agent tree and is never touched.
  const stop = async () => {
    setStopping(true);
    const plan = reviewStopPlan(threads, { environmentId, threadId: reviewer.id });
    for (const id of plan.stop) await actions.stop({ environmentId, id }, "thread");
    for (const id of plan.discard) await actions.discard({ environmentId, id }, "thread");
    setStopping(false);
  };
  return (
    <View
      accessibilityRole="summary"
      className="mt-3 gap-2 rounded-[22px] bg-grouped-card px-4 py-3"
    >
      <View className="flex-row items-center gap-2">
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
            "min-w-0 flex-1 text-[15px]",
            progress.kind === "failed" ? "text-adaptive-rose-700-300" : "text-foreground",
          )}
        >
          {text}
        </Text>
      </View>
      {detail !== null ? (
        <Text className="pl-4 text-[13px] text-foreground-muted" numberOfLines={1}>
          {detail}
        </Text>
      ) : null}
      {progress.kind === "running" && agents.length > 0 ? (
        <View className="gap-1 pl-4">
          {agents.map((agent) => {
            const status = resolveSpawnedAgentRowStatus(agent.thread, "started");
            return (
              <Text key={agent.thread.id} className="text-[13px] text-foreground" numberOfLines={1}>
                {agent.thread.title}
                {status === null ? null : (
                  <Text
                    className={cn(
                      "text-[13px] text-foreground-muted",
                      status === "failed" && "text-adaptive-rose-700-300",
                    )}
                  >
                    {` · ${SPAWNED_AGENT_STATUS_LABEL[status].toLowerCase()}`}
                  </Text>
                )}
              </Text>
            );
          })}
        </View>
      ) : null}
      <View className="flex-row flex-wrap gap-2 pt-1">
        <ControlPill variant="pill" label="View agent" onPress={props.onViewAgent} />
        {progress.kind === "running" ? (
          <ControlPill
            variant="pill"
            label={stopping ? "Stopping…" : "Stop"}
            disabled={stopping}
            onPress={() => void stop()}
          />
        ) : props.retry !== null ? (
          <ControlPill
            variant="pill"
            label={pending ? "Starting…" : "Try again"}
            disabled={pending}
            onPress={() => {
              const { retry } = props;
              if (retry === null) return;
              void start(retry.request, retry.choices).then((threadId) => {
                if (threadId !== null) props.onRetried(threadId);
              });
            }}
          />
        ) : null}
      </View>
    </View>
  );
}
