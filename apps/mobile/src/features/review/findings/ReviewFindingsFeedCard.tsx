import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, ReviewFindingsActivityPayload } from "@t3tools/contracts";
import { REVIEW_VERDICT_LABELS } from "@t3tools/shared/reviewFindings";
import { memo } from "react";
import { type ColorValue, Pressable, View } from "react-native";

import { SymbolView } from "../../../components/AppSymbol";
import { AppText as Text } from "../../../components/AppText";

/**
 * Where a reviewer's findings arrive in the transcript: what it concluded and how many issues,
 * opening the findings themselves. Like web, the transcript only says they came.
 */
export const ReviewFindingsFeedCard = memo(function ReviewFindingsFeedCard(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly findings: ReviewFindingsActivityPayload;
  readonly iconColor: ColorValue;
}) {
  const navigation = useNavigation();
  const issues = props.findings.findings.length + props.findings.needsChecking.length;
  // Findings sent while the review works have no verdict yet.
  const summary =
    props.findings.complete === false
      ? `Reviewing… ${issues} so far`
      : `${REVIEW_VERDICT_LABELS[props.findings.verdict]} · ${issues} ${issues === 1 ? "issue" : "issues"}`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint="Opens the review findings."
      onPress={() =>
        navigation.navigate("ThreadReviewFindings", {
          environmentId: props.environmentId,
          threadId: props.threadId,
        })
      }
      className="mb-4 min-h-12 flex-row items-center gap-2 rounded-lg border border-border bg-card px-3 py-2.5 active:opacity-70"
    >
      <SymbolView name="checklist" size={14} tintColor={props.iconColor} type="monochrome" />
      <Text className="text-sm font-t3-medium text-foreground">Review findings</Text>
      <View className="min-w-0 flex-1 flex-row items-center gap-1.5">
        <Text className="shrink text-sm text-foreground-muted" numberOfLines={1}>
          {summary}
        </Text>
      </View>
      <SymbolView name="chevron.right" size={12} tintColor={props.iconColor} type="monochrome" />
    </Pressable>
  );
});
