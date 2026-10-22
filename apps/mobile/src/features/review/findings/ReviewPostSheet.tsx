import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { reviewPostOverallComment } from "@t3tools/client-runtime/review-findings";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentId,
  type PullRequestReviewVerdict,
  REVIEW_POST_MAX_OVERALL_COMMENT_CHARS,
  ThreadId,
} from "@t3tools/contracts";
import {
  reviewFindingCommentBody,
  reviewFindingLocation,
  reviewSubmitVerdictFor,
} from "@t3tools/shared/reviewFindings";
import { useMemo, useState } from "react";
import { Alert, Platform, ScrollView, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../../components/AndroidScreenHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../../components/AppText";
import { MaterialScreenContent } from "../../../components/MaterialScreenContent";
import { SegmentedControl } from "../../../components/SegmentedControl";
import { tryOpenExternalUrl } from "../../../lib/openExternalUrl";
import { NativeStackScreenOptions } from "../../../native/StackHeader";
import { reviewEnvironment } from "../../../state/review";
import { useAtomCommand } from "../../../state/use-atom-command";
import { MarkdownText } from "../../files/FileMarkdownPreview";
import { SheetActionButton } from "../../threads/git/gitSheetComponents";
import { useReviewThreadFindings } from "./useReviewThreadFindings";

const SUBMIT_AS: ReadonlyArray<{
  readonly value: PullRequestReviewVerdict;
  readonly label: string;
}> = [
  { value: "comment", label: "Comment" },
  { value: "approve", label: "Approve" },
  { value: "request-changes", label: "Request changes" },
];

type ReviewPostSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  /** The review thread the findings come from. */
  readonly threadId: string;
  /** The findings to post, by key, comma-separated. */
  readonly keys: string;
}>;

/**
 * Posting findings to somebody else's pull request, which other people will read: always behind
 * this tap, with the verdict the review is submitted as and its own words above the findings. One
 * finding shows the comment that will be posted on its line.
 */
export function ReviewPostSheet({ route }: ReviewPostSheetProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const reviewThreadId = ThreadId.make(route.params.threadId);
  const reviewRef = useMemo(
    () => scopeThreadRef(environmentId, reviewThreadId),
    [environmentId, reviewThreadId],
  );
  const { source, entries } = useReviewThreadFindings(reviewRef);
  const keys = route.params.keys.split(",");
  const selection = entries.filter((entry) => keys.includes(entry.key));
  const findings = source?.findings ?? null;
  const target = findings?.target.kind === "pull-request" ? findings.target : null;
  const [chosenVerdict, setChosenVerdict] = useState<PullRequestReviewVerdict | null>(null);
  const [editedComment, setEditedComment] = useState<string | null>(null);
  const submitAs =
    chosenVerdict ?? (findings === null ? "comment" : reviewSubmitVerdictFor(findings.verdict));
  const overallComment =
    editedComment ??
    (findings === null ? "" : reviewPostOverallComment(findings.verdict, selection));
  const postFindings = useAtomCommand(reviewEnvironment.postFindings, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const only = selection.length === 1 ? selection[0] : undefined;

  const post = async () => {
    if (source === null || target === null || selection.length === 0 || pending) return;
    setPending(true);
    setFailure(null);
    const result = await postFindings({
      environmentId,
      input: {
        reviewThreadId,
        findingsActivityId: source.activityId,
        target,
        verdict: submitAs,
        overallComment,
        findings: selection.map((entry) => ({ key: entry.key, finding: entry.finding })),
      },
    });
    if (result._tag === "Failure") {
      setPending(false);
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      // A review is one request, so its failure is every finding's it carried.
      setFailure(error instanceof Error ? error.message : "Could not post the review.");
      return;
    }
    const { url, headMoved } = result.value;
    Alert.alert(
      selection.length === 1 ? "Posted the finding" : `Posted ${selection.length} findings`,
      headMoved
        ? "The pull request has commits the review did not read, so the host may show these comments as outdated."
        : undefined,
      [
        { text: "OK", style: "cancel", onPress: () => navigation.goBack() },
        {
          text: "Open pull request",
          onPress: () => {
            navigation.goBack();
            void tryOpenExternalUrl(url, "pull-request");
          },
        },
      ],
      { cancelable: false },
    );
  };

  const title = `Post ${only ? "this finding" : `${selection.length} findings`} as a review`;

  return (
    <View
      collapsable={false}
      className="bg-sheet ios:flex-1"
      style={Platform.OS === "android" ? { maxHeight: windowHeight * 0.92 } : undefined}
    >
      {Platform.OS === "android" ? (
        <NativeStackScreenOptions
          options={{ sheetCornerRadius: 28, sheetAllowedDetents: "fitToContents" }}
        />
      ) : null}
      {Platform.OS === "android" ? (
        <AndroidSheetHeader title={title} onBack={() => navigation.goBack()} hideBottomBorder />
      ) : null}
      <MaterialScreenContent fitToContents>
        <ScrollView
          className="android:shrink android:grow-0 ios:flex-1"
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerClassName="gap-4 android:p-2 ios:px-5 ios:pt-5"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          <View className="gap-1.5 android:px-2">
            {Platform.OS !== "android" ? (
              <Text className="text-2xl font-t3-bold text-foreground">{title}</Text>
            ) : null}
            <Text className="text-sm leading-normal text-foreground-secondary">
              Each finding goes on its line where the pull request's diff shows it, and into the
              review's text otherwise. Everyone on the pull request can read it.
            </Text>
          </View>

          <View className="gap-2">
            <Text className="text-sm font-t3-bold text-foreground">Submit as</Text>
            <SegmentedControl
              options={SUBMIT_AS}
              selected={submitAs}
              onSelect={setChosenVerdict}
              size="compact"
            />
          </View>

          <View className="gap-2">
            <Text className="text-sm font-t3-bold text-foreground">Overall comment</Text>
            <TextInput
              multiline
              accessibilityLabel="Overall comment"
              value={overallComment}
              onChangeText={setEditedComment}
              editable={!pending}
              maxLength={REVIEW_POST_MAX_OVERALL_COMMENT_CHARS}
              textAlignVertical="top"
              className="min-h-[112px] px-4 py-3.5 android:rounded-xl android:bg-sheet-solid ios:rounded-[20px] ios:bg-card"
            />
          </View>

          {only ? (
            <View className="gap-2">
              <Text className="text-[13px] text-foreground-muted">
                On {reviewFindingLocation(only.finding)} where the diff shows it
              </Text>
              <View className="rounded-[20px] bg-card px-4 py-3">
                <MarkdownText markdown={reviewFindingCommentBody(only.finding, "inline")} />
              </View>
            </View>
          ) : (
            <View className="gap-2 rounded-[20px] bg-card px-4 py-3">
              {selection.map((entry) => (
                <View key={entry.key} className="gap-0.5">
                  <Text className="text-[15px] text-foreground" numberOfLines={2}>
                    {entry.finding.title}
                  </Text>
                  <Text className="font-mono text-[12px] text-foreground-muted" numberOfLines={1}>
                    {reviewFindingLocation(entry.finding)}
                  </Text>
                </View>
              ))}
            </View>
          )}

          {failure !== null ? (
            <Text accessibilityRole="alert" className="text-sm text-adaptive-rose-700-300">
              {failure}
            </Text>
          ) : null}

          <SheetActionButton
            icon="text.bubble"
            label={pending ? "Posting…" : "Post review"}
            tone="primary"
            disabled={pending || selection.length === 0 || target === null}
            onPress={() => void post()}
          />
        </ScrollView>
      </MaterialScreenContent>
    </View>
  );
}
