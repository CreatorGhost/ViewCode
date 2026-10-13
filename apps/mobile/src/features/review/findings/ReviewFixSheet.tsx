import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type ReviewFindingKey,
  reviewFindingMarksByKey,
  reviewFixAllInitiallyTicked,
} from "@t3tools/client-runtime/review-findings";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  REVIEW_FINDING_SEVERITY_LABELS,
  reviewFindingLocation,
} from "@t3tools/shared/reviewFindings";
import { useMemo, useState } from "react";
import { Platform, Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../../components/AndroidScreenHeader";
import { SymbolView } from "../../../components/AppSymbol";
import { AppText as Text } from "../../../components/AppText";
import { MaterialScreenContent } from "../../../components/MaterialScreenContent";
import { cn } from "../../../lib/cn";
import { NativeStackScreenOptions } from "../../../native/StackHeader";
import { reviewFindingsCardKey, useSentReviewFindings } from "../../../state/review-findings";
import { SheetActionButton } from "../../threads/git/gitSheetComponents";
import { REVIEW_SEVERITY_PRESENTATION } from "./ReviewFindingRow";
import { useReviewFix } from "./useReviewFix";
import { useReviewThreadFindings } from "./useReviewThreadFindings";

type ReviewFixSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  /** The review thread the findings come from. */
  readonly threadId: string;
  /** The findings to fix, by key, comma-separated. */
  readonly keys: string;
  /** The chat the reader came from, which takes the fix. */
  readonly fromThreadId?: string;
}>;

/**
 * Fix all, for more than one finding: the issues that go to the review's chat as one message, the
 * fixes not sent yet ticked (`reviewFixAllInitiallyTicked`) so the reader can change the selection
 * first. It lists issues only, never chats: where they go is the review's own chat
 * (`useReviewFix`).
 */
export function ReviewFixSheet({ route }: ReviewFixSheetProps) {
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
  // In the findings screen's order, which is the order the keys come in.
  const offered = route.params.keys
    .split(",")
    .flatMap((key) => entries.find((entry) => entry.key === key) ?? []);
  const sent = useSentReviewFindings(reviewFindingsCardKey(environmentId, reviewThreadId));
  const sentByKey = useMemo(() => reviewFindingMarksByKey(entries, sent), [entries, sent]);
  // Fixes not sent yet start ticked; questions, unsettled and sent findings are the reader's to
  // tick. What the reader toggles is kept apart, so findings arriving late start right too.
  const [toggled, setToggled] = useState<ReadonlySet<ReviewFindingKey>>(() => new Set());
  const isTicked = (entry: (typeof offered)[number]) =>
    reviewFixAllInitiallyTicked(entry, sentByKey) !== toggled.has(entry.key);
  const selection = offered.filter(isTicked);
  const { chat, fix } = useReviewFix({
    environmentId,
    reviewThreadId,
    reviewTitle: source?.threadTitle ?? "",
    fromThreadId:
      route.params.fromThreadId === undefined ? null : ThreadId.make(route.params.fromThreadId),
    target: source?.findings.target ?? null,
  });
  const [pending, setPending] = useState(false);

  const send = async () => {
    if (selection.length === 0 || pending) return;
    setPending(true);
    await fix(selection, { replaceScreen: true });
    setPending(false);
    if (chat?.kind === "thread") navigation.goBack();
  };

  const count = selection.length;
  const title = `Fix ${count} ${count === 1 ? "issue" : "issues"}`;
  const destination = chat?.kind === "thread" ? chat.title : "a new chat";
  const sendLabel =
    chat?.kind === "new"
      ? `Write ${count} into a new chat`
      : `Send ${count} to ${chat?.title ?? "the chat"}`;

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
          showsVerticalScrollIndicator={false}
          contentContainerClassName="gap-4 android:p-2 ios:px-5 ios:pt-5"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          <View className="gap-1.5 android:px-2">
            {Platform.OS !== "android" ? (
              <Text className="text-2xl font-t3-bold text-foreground">{title}</Text>
            ) : null}
            <Text className="text-sm leading-normal text-foreground-secondary">
              They go to {destination} as one message. The agent checks each issue first and says
              which it fixed and which it skipped.
            </Text>
          </View>
          <View className="overflow-hidden rounded-[20px] bg-card">
            {offered.map((entry, index) => {
              const ticked = isTicked(entry);
              const severity = REVIEW_SEVERITY_PRESENTATION[entry.finding.severity];
              return (
                <View key={entry.key}>
                  {index > 0 ? <View className="ml-4 h-px bg-border-subtle" /> : null}
                  <Pressable
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: ticked }}
                    onPress={() =>
                      setToggled((current) => {
                        const next = new Set(current);
                        if (!next.delete(entry.key)) next.add(entry.key);
                        return next;
                      })
                    }
                    className="min-h-16 flex-row items-start gap-3 px-4 py-3 active:bg-subtle"
                  >
                    <SymbolView
                      name={ticked ? "checkmark.square.fill" : "square"}
                      size={20}
                      tintColorClassName={ticked ? "accent-primary" : "accent-icon-muted"}
                      type="monochrome"
                    />
                    <View className="min-w-0 flex-1 gap-0.5">
                      <Text
                        className="text-[15px] font-t3-medium text-foreground"
                        numberOfLines={2}
                      >
                        {entry.finding.title}
                      </Text>
                      <Text className="text-[13px] text-foreground-muted" numberOfLines={1}>
                        <Text className={cn("text-[13px] font-t3-medium", severity.text)}>
                          {REVIEW_FINDING_SEVERITY_LABELS[entry.finding.severity]}
                        </Text>
                        {" · "}
                        <Text className="font-mono text-[12px] text-foreground-muted">
                          {reviewFindingLocation(entry.finding)}
                        </Text>
                        {entry.needsChecking ? " · needs checking" : ""}
                        {sentByKey[entry.key] !== undefined ? " · Already sent" : ""}
                      </Text>
                    </View>
                  </Pressable>
                </View>
              );
            })}
          </View>
          <SheetActionButton
            icon="hammer"
            label={pending ? "Sending…" : sendLabel}
            tone="primary"
            disabled={pending || count === 0 || chat === null}
            onPress={() => void send()}
          />
        </ScrollView>
      </MaterialScreenContent>
    </View>
  );
}
