import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { MenuAction } from "@react-native-menu/menu";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentId,
  ProjectId,
  type PullRequestDetail,
  type PullRequestMergeMethod,
  type PullRequestRef,
} from "@t3tools/contracts";
import { Image } from "expo-image";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidAnchoredMenu } from "../../components/AndroidAnchoredMenu";
import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { useAndroidControlSizing } from "../../components/useAndroidControlSizing";
import { cn } from "../../lib/cn";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { relativeTime } from "../../lib/time";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { pullRequestEnvironment } from "../../state/pullRequests";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { MarkdownText } from "../files/FileMarkdownPreview";
import { HomePillIconButton, HomePillSurface } from "../home/HomePillButton";
import {
  MERGE_METHOD_LABELS,
  availablePullRequestMergeMethods,
  canMergePullRequest,
  summarizePullRequestChecks,
  summarizePullRequestMerge,
  type PullRequestTone,
} from "./pullRequestScreen.logic";

type PullRequestRouteParams = {
  readonly environmentId: string;
  readonly threadId: string;
  readonly projectId: string;
  readonly repository: string;
  readonly number: string;
  readonly host?: string;
};

const TONE_TEXT: Record<PullRequestTone, string> = {
  positive: "text-adaptive-emerald-700-300",
  warning: "text-adaptive-amber-700-300",
  negative: "text-adaptive-rose-700-300",
  neutral: "text-foreground",
};

const STATE_CHIP: Record<
  "open" | "draft" | "merged" | "closed",
  {
    readonly label: string;
    readonly className: string;
    readonly textClassName: string;
    readonly iconClassName: string;
  }
> = {
  open: {
    label: "Open",
    className: "bg-adaptive-emerald-500-a12-a16",
    textClassName: "text-adaptive-emerald-700-300",
    iconClassName: "accent-adaptive-emerald-700-300",
  },
  draft: {
    label: "Draft",
    className: "bg-row-hover",
    textClassName: "text-foreground-muted",
    iconClassName: "accent-foreground-muted",
  },
  merged: {
    label: "Merged",
    className: "bg-adaptive-violet-500-a12-a16",
    textClassName: "text-adaptive-violet-700-300",
    iconClassName: "accent-adaptive-violet-700-300",
  },
  closed: {
    label: "Closed",
    className: "bg-adaptive-rose-500-a12-a16",
    textClassName: "text-adaptive-rose-700-300",
    iconClassName: "accent-adaptive-rose-700-300",
  },
};

function InfoRow(props: {
  readonly icon: AppSymbolName;
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <View className="min-h-[46px] flex-row items-center gap-3 py-2">
      <SymbolView
        name={props.icon}
        size={18}
        tintColorClassName="accent-foreground-muted"
        type="monochrome"
      />
      <Text className="w-[84px] text-[15px] text-foreground-muted">{props.label}</Text>
      <View className="min-w-0 flex-1">{props.children}</View>
    </View>
  );
}

function AuthorAvatar(props: { readonly login: string; readonly avatarUrl: string | null }) {
  if (props.avatarUrl) {
    return (
      <Image
        source={{ uri: props.avatarUrl }}
        style={{ width: 26, height: 26, borderRadius: 13 }}
        accessibilityIgnoresInvertColors
      />
    );
  }
  return (
    <View className="size-[26px] items-center justify-center rounded-full bg-row-hover">
      <Text className="text-xs font-t3-bold text-foreground-muted">
        {props.login.slice(0, 2).toUpperCase()}
      </Text>
    </View>
  );
}

/**
 * One pull request on Android, opened from a thread's linked pull requests:
 * what it changes, whether it can merge, and the merge itself.
 */
export function PullRequestRouteScreen({ route }: StaticScreenProps<PullRequestRouteParams>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { scale } = useAndroidControlSizing();
  const params = route.params;
  const environmentId = EnvironmentId.make(params.environmentId);
  const number = Number(params.number);
  const reference = useMemo<PullRequestRef>(
    () => ({
      projectId: ProjectId.make(params.projectId),
      ...(params.host ? { host: params.host } : {}),
      repository: params.repository,
      number,
    }),
    [number, params.host, params.projectId, params.repository],
  );
  const detailQuery = useEnvironmentQuery(
    pullRequestEnvironment.detail({ environmentId, input: reference }),
  );
  const activityQuery = useEnvironmentQuery(
    pullRequestEnvironment.activity({ environmentId, input: reference }),
  );
  const detail: PullRequestDetail | null = detailQuery.data;
  const invalidate = useAtomCommand(pullRequestEnvironment.invalidate, { reportFailure: false });
  const runAction = useAtomCommand(pullRequestEnvironment.runAction, { reportFailure: false });
  const [refreshing, setRefreshing] = useState(false);
  const [merging, setMerging] = useState(false);
  const [descriptionOpen, setDescriptionOpen] = useState(true);
  const [chosenMethod, setChosenMethod] = useState<PullRequestMergeMethod | null>(null);

  const refreshFromHost = useCallback(async () => {
    setRefreshing(true);
    try {
      await invalidate({ environmentId, input: { reference } });
      detailQuery.refresh();
      activityQuery.refresh();
    } finally {
      setRefreshing(false);
    }
  }, [activityQuery, detailQuery, environmentId, invalidate, reference]);

  const openOnHost = useCallback(() => {
    if (!detail) return;
    void tryOpenExternalUrl(detail.url, "pull-request").then((opened) => {
      if (!opened) Alert.alert("Unable to open PR", "The pull request could not be opened.");
    });
  }, [detail]);

  const mergeMethods = detail ? availablePullRequestMergeMethods(detail) : [];
  const mergeMethod =
    chosenMethod !== null && mergeMethods.includes(chosenMethod)
      ? chosenMethod
      : (mergeMethods[0] ?? null);
  const showMerge = detail !== null && canMergePullRequest(detail);
  const mergeBlocked = detail?.mergeability === "conflicting";

  const merge = useCallback(() => {
    if (!detail || mergeMethod === null) return;
    Alert.alert(
      `${MERGE_METHOD_LABELS[mergeMethod]} #${detail.number}?`,
      `${detail.headBranch} goes into ${detail.baseBranch}.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: MERGE_METHOD_LABELS[mergeMethod],
          onPress: () => {
            setMerging(true);
            void runAction({
              environmentId,
              input: { ...reference, action: "merge", mergeMethod },
            })
              .then(async (result) => {
                if (result._tag === "Failure") {
                  if (isAtomCommandInterrupted(result)) return;
                  const error = squashAtomCommandFailure(result);
                  Alert.alert(
                    "Could not merge",
                    error instanceof Error ? error.message : "The host refused the merge.",
                  );
                  return;
                }
                await refreshFromHost();
              })
              .finally(() => setMerging(false));
          },
        },
      ],
    );
  }, [detail, environmentId, mergeMethod, reference, refreshFromHost, runAction]);

  const methodActions = useMemo<MenuAction[]>(
    () =>
      mergeMethods.map((method) => ({
        id: `merge-method:${method}`,
        title: MERGE_METHOD_LABELS[method],
        state: method === mergeMethod ? ("on" as const) : undefined,
      })),
    [mergeMethod, mergeMethods],
  );

  const stateChip = detail
    ? STATE_CHIP[detail.state === "open" && detail.isDraft ? "draft" : detail.state]
    : null;
  const checks = detail ? summarizePullRequestChecks(detail.checks) : null;
  const mergeSummary = detail ? summarizePullRequestMerge(detail) : null;
  const commentCount = activityQuery.data?.commentCount;
  const footerHeight = showMerge ? 56 * scale + 24 + Math.max(insets.bottom, 16) : 0;

  return (
    <View className="flex-1 bg-screen">
      <NativeStackScreenOptions options={{ headerShown: false }} />
      <View
        className="flex-row items-center gap-2 px-4"
        style={{ paddingTop: Math.max(insets.top, 12) + 8, paddingBottom: 8 }}
      >
        <HomePillSurface
          accessibilityLabel="Close"
          onPress={() => navigation.goBack()}
          style={{ paddingHorizontal: 20 }}
        >
          <Text className="text-base font-t3-medium text-foreground">Close</Text>
        </HomePillSurface>
        <Text className="flex-1 text-center text-lg font-t3-bold text-foreground" numberOfLines={1}>
          PR #{number}
        </Text>
        <HomePillIconButton
          accessibilityLabel="Open on the host"
          icon="arrow.up.right"
          onPress={openOnHost}
        />
      </View>

      {detail === null ? (
        <View className="flex-1 items-center justify-center gap-4 px-8">
          {detailQuery.error ? (
            <>
              <Text className="text-center text-base text-foreground-muted">
                {detailQuery.error}
              </Text>
              <HomePillSurface
                accessibilityLabel="Try again"
                onPress={() => void refreshFromHost()}
                style={{ paddingHorizontal: 20 }}
              >
                <Text className="text-base font-t3-medium text-foreground">Try again</Text>
              </HomePillSurface>
            </>
          ) : (
            <ActivityIndicator colorClassName="accent-icon-muted" />
          )}
        </View>
      ) : (
        <ScrollView
          className="flex-1"
          contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: footerHeight + 24 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => void refreshFromHost()} />
          }
        >
          <View className="flex-row items-center gap-2.5 pt-3">
            {stateChip ? (
              <View
                className={cn(
                  "flex-row items-center gap-1.5 rounded-full px-3 py-1",
                  stateChip.className,
                )}
              >
                <SymbolView
                  name="arrow.triangle.pull"
                  size={14}
                  tintColorClassName={stateChip.iconClassName}
                  type="monochrome"
                />
                <Text className={cn("text-sm font-t3-bold", stateChip.textClassName)}>
                  {stateChip.label}
                </Text>
              </View>
            ) : null}
            <Text className="shrink text-[15px] text-foreground-muted" numberOfLines={1}>
              {detail.repository}
            </Text>
          </View>

          <Text
            accessibilityRole="header"
            className="mt-3.5 text-[26px] font-t3-bold leading-[33px] text-foreground"
            selectable
          >
            {detail.title}
          </Text>

          {detail.author ? (
            <View className="mt-3 flex-row items-center gap-2.5">
              <AuthorAvatar login={detail.author.login} avatarUrl={detail.author.avatarUrl} />
              <Text className="text-[15px] font-t3-medium text-foreground">
                {detail.author.name ?? detail.author.login}
              </Text>
              <Text className="text-[15px] text-foreground-muted">
                {relativeTime(detail.createdAt)} ago
              </Text>
            </View>
          ) : null}

          {detail.labels.length > 0 ? (
            <View className="mt-3 flex-row flex-wrap gap-2">
              {detail.labels.map((label) => (
                <View
                  key={label.name}
                  className="flex-row items-center gap-1.5 rounded-full border border-border-subtle bg-card px-3 py-1"
                >
                  {label.color ? (
                    <View
                      className="size-2 rounded-full"
                      style={{ backgroundColor: `#${label.color.replace(/^#/, "")}` }}
                    />
                  ) : null}
                  <Text className="text-sm text-foreground">{label.name}</Text>
                </View>
              ))}
            </View>
          ) : null}

          <View className="mt-5 rounded-[22px] bg-grouped-card px-4 py-1.5">
            <InfoRow icon="arrow.triangle.branch" label="Branch">
              <Text className="font-mono text-[13px] text-foreground" numberOfLines={1}>
                {detail.headBranch} → {detail.baseBranch}
              </Text>
            </InfoRow>
            <InfoRow icon="doc.text" label="Changes">
              <Text className="text-[15px] text-foreground">
                <Text className="text-adaptive-emerald-700-300">+{detail.additions}</Text>{" "}
                <Text className="text-adaptive-rose-700-300">−{detail.deletions}</Text> ·{" "}
                {detail.changedFiles} {detail.changedFiles === 1 ? "file" : "files"}
              </Text>
            </InfoRow>
            {mergeSummary ? (
              <InfoRow icon="arrow.triangle.pull" label="Merge">
                <Text className={cn("text-[15px]", TONE_TEXT[mergeSummary.tone])}>
                  {mergeSummary.label}
                </Text>
              </InfoRow>
            ) : null}
            {checks ? (
              <InfoRow icon="checkmark.circle" label="Checks">
                <Text className={cn("text-[15px]", TONE_TEXT[checks.tone])}>{checks.label}</Text>
              </InfoRow>
            ) : null}
            <InfoRow icon="person.crop.circle" label="Reviews">
              <Text className="text-[15px] text-foreground" numberOfLines={1}>
                {detail.reviewers.length === 0
                  ? "No reviewers"
                  : detail.reviewers.map((reviewer) => reviewer.login).join(", ")}
              </Text>
            </InfoRow>
            {commentCount !== undefined ? (
              <InfoRow icon="text.bubble" label="Comments">
                <Text className="text-[15px] text-foreground">
                  {commentCount === 0
                    ? "No comments"
                    : `${commentCount} ${commentCount === 1 ? "comment" : "comments"}`}
                </Text>
              </InfoRow>
            ) : null}
          </View>

          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: descriptionOpen }}
            onPress={() => setDescriptionOpen((open) => !open)}
            className="mt-6 min-h-[44px] flex-row items-center gap-1.5"
          >
            <Text className="text-[19px] font-t3-bold text-foreground">Description</Text>
            <SymbolView
              name={descriptionOpen ? "chevron.down" : "chevron.right"}
              size={16}
              tintColorClassName="accent-foreground"
              type="monochrome"
            />
          </Pressable>
          {descriptionOpen ? (
            detail.body.trim() ? (
              <MarkdownText markdown={detail.body} />
            ) : (
              <Text className="text-base text-foreground-muted">No description.</Text>
            )
          ) : null}
        </ScrollView>
      )}

      {detail !== null && showMerge && mergeMethod !== null ? (
        <View
          className="absolute inset-x-0 bottom-0 flex-row gap-2.5 border-t border-border-subtle bg-screen px-4 pt-3"
          style={{ paddingBottom: Math.max(insets.bottom, 16) }}
        >
          <HomePillSurface
            accessibilityLabel="Open thread"
            onPress={() =>
              navigation.navigate("Thread", {
                environmentId: params.environmentId,
                threadId: params.threadId,
              })
            }
            style={{ height: 56 * scale, paddingHorizontal: 18, gap: 8 }}
          >
            <SymbolView name="text.bubble" size={18} tintColorClassName="accent-foreground" />
            <Text className="text-base font-t3-medium text-foreground">Thread</Text>
          </HomePillSurface>
          <View
            className={cn(
              "flex-1 flex-row overflow-hidden rounded-full bg-foreground",
              (mergeBlocked || merging) && "opacity-50",
            )}
            style={{ height: 56 * scale }}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={MERGE_METHOD_LABELS[mergeMethod]}
              accessibilityState={{ disabled: mergeBlocked || merging, busy: merging }}
              disabled={mergeBlocked || merging}
              onPress={merge}
              className="flex-1 flex-row items-center justify-center gap-2.5"
            >
              {merging ? (
                <ActivityIndicator colorClassName="accent-screen" />
              ) : (
                <SymbolView
                  name="arrow.triangle.pull"
                  size={20}
                  tintColorClassName="accent-screen"
                />
              )}
              <Text className="text-[17px] font-t3-bold text-screen" numberOfLines={1}>
                {MERGE_METHOD_LABELS[mergeMethod]}
              </Text>
            </Pressable>
            {mergeMethods.length > 1 ? (
              <>
                <View className="my-3.5 w-px bg-screen opacity-30" />
                <AndroidAnchoredMenu
                  actions={methodActions}
                  onPressAction={({ nativeEvent }) => {
                    const method = nativeEvent.event.slice("merge-method:".length);
                    const next = mergeMethods.find((candidate) => candidate === method);
                    if (next) setChosenMethod(next);
                  }}
                >
                  {(open) => (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Merge options"
                      disabled={merging}
                      onPress={open}
                      className="h-full w-[52px] items-center justify-center"
                    >
                      <SymbolView
                        name="chevron.down"
                        size={18}
                        tintColorClassName="accent-screen"
                        type="monochrome"
                      />
                    </Pressable>
                  )}
                </AndroidAnchoredMenu>
              </>
            ) : null}
          </View>
        </View>
      ) : null}
    </View>
  );
}
