import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { filterReviewCommits, pastedReviewCommitSha } from "@t3tools/client-runtime/agent-review";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../../components/AndroidScreenHeader";
import { SymbolView } from "../../../components/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../../components/AppText";
import { MaterialScreenContent } from "../../../components/MaterialScreenContent";
import { relativeTime } from "../../../lib/time";
import { NativeStackScreenOptions } from "../../../native/StackHeader";
import { useProject, useThreadShell } from "../../../state/entities";
import { useEnvironmentQuery } from "../../../state/query";
import { reviewEnvironment } from "../../../state/review";

type ReviewCommitSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  /** The chat whose checkout's commits are listed, and whose Review changes screen reviews one. */
  readonly threadId: string;
}>;

function CommitRow(props: {
  readonly title: string;
  readonly detail: string;
  readonly sha: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint="Reviews this commit."
      onPress={props.onPress}
      className="min-h-16 flex-row items-center gap-3 px-4 py-3 active:bg-subtle"
    >
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-base font-t3-medium text-foreground" numberOfLines={2}>
          {props.title}
        </Text>
        <Text className="text-xs text-foreground-muted" numberOfLines={1}>
          <Text className="font-mono text-xs text-foreground-muted">{props.sha}</Text>
          {props.detail}
        </Text>
      </View>
      <SymbolView
        name="chevron.right"
        size={13}
        tintColorClassName="accent-icon-subtle"
        type="monochrome"
      />
    </Pressable>
  );
}

/**
 * "A commit…" from a chat's Review changes screen: its checkout's latest commits, searchable, or
 * a pasted SHA. Picking one hands it back to that screen, which starts the review with the depth
 * and model chosen there.
 */
export function ReviewCommitSheet({ route }: ReviewCommitSheetProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const threadId = ThreadId.make(route.params.threadId);
  const thread = useThreadShell(scopeThreadRef(environmentId, threadId));
  const project = useProject(
    thread === null ? null : scopeProjectRef(environmentId, thread.projectId),
  );
  // The checkout a review of this chat's changes reads.
  const cwd = thread?.worktreePath ?? project?.workspaceRoot ?? null;
  const listed = useEnvironmentQuery(
    cwd === null ? null : reviewEnvironment.commits({ environmentId, input: { cwd } }),
  );
  const [query, setQuery] = useState("");
  const commits = useMemo(
    () => filterReviewCommits(listed.data?.commits ?? [], query),
    [listed.data?.commits, query],
  );
  const pasted = pastedReviewCommitSha(query);
  const pastedListed = pasted !== null && commits.some((commit) => commit.sha.startsWith(pasted));

  const pick = (sha: string) =>
    navigation.dispatch(
      StackActions.popTo(
        "ThreadReview",
        { environmentId, threadId, reviewCommit: sha },
        { merge: true },
      ),
    );

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
        <AndroidSheetHeader
          title="Review a commit"
          onBack={() => navigation.goBack()}
          hideBottomBorder
        />
      ) : null}
      <MaterialScreenContent fitToContents>
        <ScrollView
          className="android:shrink android:grow-0 ios:flex-1"
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerClassName="gap-4 android:p-2 ios:px-5 ios:pt-5"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {Platform.OS !== "android" ? (
            <Text className="text-2xl font-t3-bold text-foreground">Review a commit</Text>
          ) : null}
          <TextInput
            accessibilityLabel="Search commits, or paste a SHA"
            placeholder="Search commits, or paste a SHA"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            value={query}
            onChangeText={setQuery}
            className="android:rounded-xl android:bg-sheet-solid ios:rounded-[18px]"
          />
          <View className="overflow-hidden rounded-[20px] bg-card">
            {pasted !== null && !pastedListed ? (
              <CommitRow
                title={`Review commit ${pasted.slice(0, 12)}`}
                sha=""
                detail="A commit not among the latest ones"
                onPress={() => pick(pasted)}
              />
            ) : null}
            {commits.map((commit, index) => (
              <View key={commit.sha}>
                {index > 0 || (pasted !== null && !pastedListed) ? (
                  <View className="ml-4 h-px bg-border-subtle" />
                ) : null}
                <CommitRow
                  title={commit.subject || "(no subject)"}
                  sha={commit.shortSha}
                  detail={` · ${commit.author} · ${relativeTime(commit.committedAt)} ago`}
                  onPress={() => pick(commit.sha)}
                />
              </View>
            ))}
            {commits.length === 0 && pasted === null ? (
              <View className="min-h-16 items-center justify-center px-4 py-4">
                {listed.isPending ? (
                  <ActivityIndicator colorClassName="accent-icon-muted" />
                ) : (
                  <Text className="text-center text-sm text-foreground-muted">
                    {listed.error ??
                      (query.trim().length > 0 ? "No commits match." : "No commits found.")}
                  </Text>
                )}
              </View>
            ) : null}
          </View>
        </ScrollView>
      </MaterialScreenContent>
    </View>
  );
}
