import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { reviewFixCandidates } from "@t3tools/client-runtime/review-findings";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { buildReviewFixMessage } from "@t3tools/shared/reviewFindings";
import { useMemo, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../../components/AndroidScreenHeader";
import { AppText as Text } from "../../../components/AppText";
import { MaterialRadioIndicator } from "../../../components/MaterialRadioIndicator";
import { MaterialScreenContent } from "../../../components/MaterialScreenContent";
import { makeQueuedMessageMetadata } from "../../../lib/commandMetadata";
import { relativeTime } from "../../../lib/time";
import { NativeStackScreenOptions } from "../../../native/StackHeader";
import { useThreadShells } from "../../../state/entities";
import { reviewEnvironment } from "../../../state/review";
import { markReviewFindingsSent, reviewFindingsCardKey } from "../../../state/review-findings";
import { enqueueThreadOutboxMessage } from "../../../state/thread-outbox";
import { useAtomCommand } from "../../../state/use-atom-command";
import { SheetActionButton } from "../../threads/git/gitSheetComponents";
import { useReviewThreadFindings } from "./useReviewThreadFindings";

const NEW_SESSION = "new";

type ReviewFixSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  /** The review thread the findings come from. */
  readonly threadId: string;
  /** The findings to fix, by key, comma-separated. */
  readonly keys: string;
}>;

function SessionRow(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly selected: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected: props.selected }}
      onPress={props.onPress}
      className="min-h-16 flex-row items-center gap-3 px-4 py-3 active:bg-subtle"
    >
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-base font-t3-medium text-foreground" numberOfLines={1}>
          {props.title}
        </Text>
        <Text className="text-xs leading-snug text-foreground-muted">{props.subtitle}</Text>
      </View>
      <View className="size-6 items-center justify-center">
        <MaterialRadioIndicator selected={props.selected} />
      </View>
    </Pressable>
  );
}

/**
 * Where findings go to be fixed, the web Fix dialog's rules: a session already working on the
 * reviewed change, through its queue so a busy one takes them when it can, or a new session the
 * server starts on the pull request's head in a worktree of its own (the review's checkout for a
 * local review).
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
  const { shell: reviewThread, source, entries } = useReviewThreadFindings(reviewRef);
  const keys = route.params.keys.split(",");
  const selection = entries.filter((entry) => keys.includes(entry.key));
  const shells = useThreadShells();
  const target = source?.findings.target ?? null;
  const { candidates, preselectedId } = useMemo(
    () =>
      reviewThread === null || target === null
        ? { candidates: [], preselectedId: null }
        : reviewFixCandidates({
            reviewThread,
            target,
            threads: shells.filter((shell) => shell.environmentId === environmentId),
          }),
    [environmentId, reviewThread, shells, target],
  );
  const [picked, setPicked] = useState<string | null>(null);
  const selected = picked ?? preselectedId ?? (candidates.length === 0 ? NEW_SESSION : null);
  const startFixThread = useAtomCommand(reviewEnvironment.startFixThread, {
    reportFailure: false,
  });
  const [pending, setPending] = useState(false);

  const send = async () => {
    if (source === null || target === null || selection.length === 0) return;
    if (selected === null || pending) return;
    const cardKey = reviewFindingsCardKey(environmentId, source.activityId);
    const sentKeys = selection.map((entry) => entry.key);
    const findings = selection.map((entry) => ({
      finding: entry.finding,
      needsChecking: entry.needsChecking,
    }));
    if (selected === NEW_SESSION) {
      setPending(true);
      const result = await startFixThread({
        environmentId,
        input: {
          reviewThreadId,
          target,
          findings,
          findingsActivityId: source.activityId,
        },
      });
      setPending(false);
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        Alert.alert(
          "Could not start a session to fix the findings",
          error instanceof Error ? error.message : "An error occurred.",
        );
        return;
      }
      markReviewFindingsSent(cardKey, sentKeys, result.value);
      navigation.dispatch(
        StackActions.replace("Thread", { environmentId, threadId: result.value.threadId }),
      );
      return;
    }
    const thread = candidates.find((candidate) => candidate.id === selected);
    if (thread === undefined) return;
    const metadata = makeQueuedMessageMetadata();
    setPending(true);
    try {
      // The session keeps its own model and modes.
      await enqueueThreadOutboxMessage({
        environmentId,
        threadId: thread.id,
        messageId: MessageId.make(metadata.messageId),
        commandId: CommandId.make(metadata.commandId),
        text: buildReviewFixMessage({ reviewTitle: source.threadTitle, target, findings }),
        attachments: [],
        createdAt: metadata.createdAt,
      });
    } catch (error) {
      setPending(false);
      Alert.alert(
        "Could not send the findings",
        error instanceof Error ? error.message : "The message could not be queued.",
      );
      return;
    }
    markReviewFindingsSent(cardKey, sentKeys, { threadId: thread.id, title: thread.title });
    Alert.alert(
      `Sent to ${thread.title}`,
      "It goes out now, or when the session can take it if it is working.",
      [
        { text: "OK", style: "cancel", onPress: () => navigation.goBack() },
        {
          text: "Open session",
          onPress: () =>
            navigation.dispatch(
              StackActions.replace("Thread", { environmentId, threadId: thread.id }),
            ),
        },
      ],
      { cancelable: false },
    );
  };

  const count = selection.length;
  const title = `Fix ${count === 1 ? "this finding" : `${count} findings`} in a session`;
  const newSessionDescription =
    target?.kind === "pull-request"
      ? `A new thread on PR #${target.number}'s branch in its own worktree, linked to the pull request. Your checkout stays as it is.`
      : "A new thread on the checkout this review looked at.";

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
              The session checks each finding against the code first, fixes the ones that hold and
              says which it skipped.
            </Text>
          </View>
          <View className="overflow-hidden rounded-[20px] bg-card">
            {candidates.map((thread) => (
              <SessionRow
                key={thread.id}
                title={thread.title}
                subtitle={`${
                  target?.kind === "pull-request"
                    ? "Works on this pull request"
                    : "Works on this checkout"
                } · ${relativeTime(thread.updatedAt)} ago`}
                selected={selected === thread.id}
                onPress={() => setPicked(thread.id)}
              />
            ))}
            <SessionRow
              title="New session"
              subtitle={newSessionDescription}
              selected={selected === NEW_SESSION}
              onPress={() => setPicked(NEW_SESSION)}
            />
          </View>
          <SheetActionButton
            icon="hammer"
            label={pending ? "Starting…" : "Send"}
            tone="primary"
            disabled={pending || selected === null || count === 0 || reviewThread === null}
            onPress={() => void send()}
          />
        </ScrollView>
      </MaterialScreenContent>
    </View>
  );
}
