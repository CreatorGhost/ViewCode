import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  groupReviewFindingsBySeverity,
  type ReviewFindingEntry,
} from "@t3tools/client-runtime/review-findings";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentId,
  type ReviewFindingRating,
  type ReviewFindingsTarget,
  type ReviewVerdict,
  ThreadId,
} from "@t3tools/contracts";
import {
  REVIEW_FINDING_SEVERITY_LABELS,
  REVIEW_VERDICT_LABELS,
} from "@t3tools/shared/reviewFindings";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, Alert, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { type AppSymbolName, SymbolView } from "../../../components/AppSymbol";
import { AppText as Text } from "../../../components/AppText";
import { EmptyState } from "../../../components/EmptyState";
import { MaterialScreenContent } from "../../../components/MaterialScreenContent";
import { ScreenHeader } from "../../../components/ScreenHeader";
import { cn } from "../../../lib/cn";
import { tryOpenExternalUrl } from "../../../lib/openExternalUrl";
import { relativeTime } from "../../../lib/time";
import { useEnvironmentServerConfig } from "../../../state/entities";
import { reviewEnvironment } from "../../../state/review";
import {
  reviewFindingsCardKey,
  setReviewFindingDismissed,
  useDismissedReviewFindings,
} from "../../../state/review-findings";
import { useAtomCommand } from "../../../state/use-atom-command";
import { REVIEW_SEVERITY_PRESENTATION, ReviewFindingRow } from "./ReviewFindingRow";
import { useReviewThreadFindings } from "./useReviewThreadFindings";

type ReviewFindingsRouteParams = {
  readonly environmentId: string;
  /** The review thread whose findings these are. */
  readonly threadId: string;
};

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

function targetLabel(target: ReviewFindingsTarget): string {
  return target.kind === "pull-request" ? `PR #${target.number}` : "Local changes";
}

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
 * An agent review's latest findings on a phone: what the reviewer concluded, then the findings
 * by severity, each opening to its detail and suggested fix. No diff here, unlike web: a phone
 * has no room to read findings under their lines, so each says where it is instead.
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
  const { source, entries, posted, ratings, loading } = useReviewThreadFindings(reviewRef);
  const serverConfig = useEnvironmentServerConfig(environmentId);
  const canRate = serverConfig?.environment.capabilities.reviewFindingRatings === true;
  const cardKey = reviewFindingsCardKey(environmentId, source?.activityId ?? "");
  const dismissed = useDismissedReviewFindings(cardKey);
  const [showDismissed, setShowDismissed] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  const dismissedCount = entries.filter((entry) => dismissed[entry.key]).length;
  const openEntries = entries.filter((entry) => !dismissed[entry.key]);
  const groups = useMemo(
    () =>
      groupReviewFindingsBySeverity(
        showDismissed ? entries : entries.filter((entry) => !dismissed[entry.key]),
      ),
    [dismissed, entries, showDismissed],
  );

  const toggleExpanded = useCallback(
    (entry: ReviewFindingEntry) =>
      setExpanded((current) => {
        const next = new Set(current);
        if (!next.delete(entry.key)) next.add(entry.key);
        return next;
      }),
    [],
  );
  const dismiss = useCallback(
    (entry: ReviewFindingEntry, value: boolean) =>
      setReviewFindingDismissed(cardKey, entry.key, value),
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

  const findings = source?.findings ?? null;
  const verdictChip = findings ? VERDICT_CHIP[findings.verdict] : null;

  return (
    <View className={Platform.OS === "android" ? "flex-1 bg-header" : "flex-1 bg-screen"}>
      <ScreenHeader
        title="Review findings"
        subtitle={findings ? targetLabel(findings.target) : undefined}
        onBack={() => navigation.goBack()}
        sidebar={false}
      />
      <MaterialScreenContent>
        {findings === null || source === null || verdictChip === null ? (
          <View className="flex-1 items-center justify-center bg-screen px-8">
            {loading ? (
              <ActivityIndicator colorClassName="accent-icon-muted" />
            ) : (
              <EmptyState
                variant="plain"
                title="No findings"
                detail="This thread has not submitted review findings."
              />
            )}
          </View>
        ) : (
          <ScrollView
            className="flex-1 bg-screen"
            contentInsetAdjustmentBehavior="automatic"
            contentContainerStyle={{
              paddingHorizontal: 16,
              paddingBottom: Math.max(insets.bottom, 16) + 24,
            }}
          >
            <View className="mt-3 rounded-[22px] bg-grouped-card px-4 py-1.5">
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
                <Text className="text-[15px] text-foreground">{findings.mergeConfidence}/5</Text>
              </SummaryRow>
              <SummaryRow icon="clock" label="Review effort">
                <Text className="text-[15px] text-foreground">{findings.reviewEffort}/5</Text>
              </SummaryRow>
              <SummaryRow
                icon={findings.target.kind === "pull-request" ? "arrow.triangle.pull" : "folder"}
                label="Target"
              >
                <Text className="text-[15px] text-foreground" numberOfLines={1}>
                  {findings.target.kind === "pull-request"
                    ? `${findings.target.repository} #${findings.target.number}`
                    : "Local changes"}
                </Text>
              </SummaryRow>
              <SummaryRow icon="person.crop.circle" label="Reviewed by">
                <Text className="text-[15px] text-foreground" numberOfLines={2}>
                  {source.threadTitle || "Review thread"}
                  <Text className="text-[15px] text-foreground-muted">
                    {` · ${relativeTime(source.createdAt)} ago`}
                  </Text>
                </Text>
              </SummaryRow>
            </View>

            <View className="mt-5 flex-row items-center gap-2 px-1">
              <Text className="flex-1 text-[15px] text-foreground-muted">
                {openEntries.length === 0
                  ? "No issues found"
                  : `${openEntries.length} ${openEntries.length === 1 ? "issue" : "issues"} found`}
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
                          expanded={expanded.has(entry.key)}
                          dismissed={dismissed[entry.key] === true}
                          rating={ratings.get(entry.key)}
                          canRate={canRate}
                          posted={posted.get(entry.key)}
                          sentTo={undefined}
                          busy={false}
                          action={null}
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
        )}
      </MaterialScreenContent>
    </View>
  );
}
