import type { LegendListRef } from "@legendapp/list/react-native";
import { useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { derivePendingRequests } from "@t3tools/client-runtime/pending-requests";
import { isChildAgentRunning } from "@t3tools/client-runtime/state/child-agents";
import {
  FRESH_SIDECHAT,
  resolveActiveSidechat,
  sidechatsOf,
  type SidechatPreference,
} from "@t3tools/client-runtime/state/sidechat";
import {
  requestOlderThreadTurns,
  threadHasOlderTurns,
} from "@t3tools/client-runtime/state/threads";
import { EnvironmentId, type MessageId, type ModelSelection, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ComposerActionButton, ComposerToolbarRow } from "../../components/ComposerToolbar";
import { buildThreadFeed } from "../../lib/threadActivity";
import { relativeTime } from "../../lib/time";
import { useProject, useThreadShell, useThreadShells } from "../../state/entities";
import { useEnvironmentPresentation } from "../../state/presentation";
import { environmentServerConfigsAtom } from "../../state/server";
import { useEnvironmentThread } from "../../state/threads";
import { ThreadFeed } from "../threads/ThreadFeed";
import { projectThreadContentPresentation } from "../threads/threadContentPresentation";
import { useSidechatActions } from "./useSidechatActions";
import { SidechatModelPicker } from "./SidechatModelPicker";
import { resolveSidechatModelSelection, resolveSidechatWhileCreating } from "./sidechatModel";

type SideChatSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly parentThreadId: string;
  readonly sideChatThreadId?: string;
}>;

/** A quick conversation over the parent, without changing the workspace's selected thread. */
export function SideChatSheet({ route }: SideChatSheetProps) {
  return (
    <SideChatContent
      key={`${route.params.environmentId}:${route.params.parentThreadId}`}
      route={route}
    />
  );
}

function SideChatContent({ route }: SideChatSheetProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const parentThreadId = ThreadId.make(route.params.parentThreadId);
  const parentRef = useMemo(
    () => scopeThreadRef(environmentId, parentThreadId),
    [environmentId, parentThreadId],
  );
  const parent = useThreadShell(parentRef);
  const projectRef = useMemo(
    () => (parent ? { environmentId, projectId: parent.projectId } : null),
    [environmentId, parent],
  );
  const project = useProject(projectRef);
  const shells = useThreadShells();
  const sidechats = useMemo(
    () =>
      sidechatsOf(
        shells.filter((thread) => thread.environmentId === environmentId),
        parentThreadId,
      ),
    [environmentId, parentThreadId, shells],
  );
  const [preferred, setPreferred] = useState<SidechatPreference>(() =>
    route.params.sideChatThreadId ? ThreadId.make(route.params.sideChatThreadId) : null,
  );
  const [createdThreadId, setCreatedThreadId] = useState<ThreadId | null>(null);
  const active = resolveSidechatWhileCreating(
    resolveActiveSidechat(sidechats, preferred),
    createdThreadId,
  );
  const awaitingCreatedShell = createdThreadId !== null && active === null;
  if (createdThreadId !== null && active?.id === createdThreadId) {
    setCreatedThreadId(null);
  }
  const [showList, setShowList] = useState(false);
  const [picked, setPicked] = useState<ModelSelection | null>(null);
  const selection = resolveSidechatModelSelection({
    picked,
    sidechatSelection: active?.modelSelection ?? null,
    parentSelection: parent?.modelSelection ?? null,
  });
  const configs = useAtomValue(environmentServerConfigsAtom);
  const serverConfig = configs.get(environmentId) ?? null;
  const detailState = useEnvironmentThread(environmentId, active?.id ?? createdThreadId);
  const detail = Option.getOrNull(detailState.data);
  const { presentation } = useEnvironmentPresentation(environmentId);
  const connectionPhase = presentation?.connection.phase ?? "offline";
  const connected = connectionPhase === "connected";
  const working = active !== null && isChildAgentRunning(active);
  const requests = useMemo(
    () => derivePendingRequests(detail?.activities ?? []),
    [detail?.activities],
  );
  const needsAnswer =
    active !== null &&
    (active.hasPendingApprovals ||
      active.hasPendingUserInput ||
      requests.approvals.length > 0 ||
      requests.userInputs.length > 0);
  const { send, stop, pending, error, clearError } = useSidechatActions();
  // Claude settles to "ready" after a failed turn but keeps lastError, so any
  // retained error shows once the side chat is idle, whatever its status.
  const displayedError =
    error ?? (!pending && !working ? (active?.session?.lastError ?? null) : null);
  const [question, setQuestion] = useState("");
  const [submittedMessageId, setSubmittedMessageId] = useState<MessageId | null>(null);
  const listRef = useRef<LegendListRef | null>(null);
  const freeze = useSharedValue(false);
  const contentInsetEndAdjustment = useSharedValue(0);
  const feed = useMemo(
    () =>
      detail
        ? buildThreadFeed({
            messages: detail.messages.filter(
              (message) => message.role === "user" || message.role === "assistant",
            ),
            activities: [],
          })
        : [],
    [detail],
  );
  const contentPresentation = projectThreadContentPresentation({
    hasDetail: detail !== null,
    detailError: Option.getOrNull(detailState.error),
    detailDeleted: detailState.status === "deleted",
    connectionState: connectionPhase,
  });
  const unavailable = parent === null || parent.archivedAt != null || parent.kind === "sidechat";
  const canSend =
    connected &&
    !unavailable &&
    !pending &&
    !working &&
    !needsAnswer &&
    !awaitingCreatedShell &&
    selection !== null &&
    question.trim().length > 0 &&
    !showList;

  const changeSelection = (preference: SidechatPreference) => {
    setPreferred(preference);
    setCreatedThreadId(null);
    setShowList(false);
    setPicked(null);
    setQuestion("");
    setSubmittedMessageId(null);
    clearError();
  };
  const openAsThread = () => {
    if (active === null) return;
    navigation.dispatch(StackActions.replace("Thread", { environmentId, threadId: active.id }));
  };
  const sendQuestion = async () => {
    if (!canSend || parent === null || selection === null) return;
    const messageId = await send({
      parent,
      sidechat: active,
      question: question.trim(),
      modelSelection: selection,
      onCreated: (threadId) => {
        setCreatedThreadId(threadId);
        setPreferred(threadId);
      },
    });
    if (messageId !== null) {
      setQuestion("");
      setSubmittedMessageId(messageId);
    }
  };

  return (
    <KeyboardAvoidingView automaticOffset behavior="padding" className="flex-1 bg-sheet">
      <View className="flex-row items-center gap-2 px-4 py-3">
        {showList ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back to side chat"
            disabled={pending}
            onPress={() => setShowList(false)}
            className="size-11 items-center justify-center rounded-full bg-card disabled:opacity-50"
          >
            <SymbolView name="chevron.left" size={18} tintColorClassName="accent-icon" />
          </Pressable>
        ) : null}
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-lg font-t3-bold">Side chat</Text>
          <Text className="text-xs text-foreground-secondary" numberOfLines={1}>
            {parent?.title ?? "Thread unavailable"}
          </Text>
        </View>
        {!showList && sidechats.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="See all side chats"
            disabled={pending}
            onPress={() => setShowList(true)}
            className="size-11 items-center justify-center rounded-full bg-card active:opacity-70 disabled:opacity-50"
          >
            <SymbolView name="text.bubble" size={18} tintColorClassName="accent-icon" />
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New side chat"
          disabled={pending || unavailable}
          onPress={() => changeSelection(FRESH_SIDECHAT)}
          className="size-11 items-center justify-center rounded-full bg-card active:opacity-70 disabled:opacity-50"
        >
          <SymbolView name="square.and.pencil" size={18} tintColorClassName="accent-icon" />
        </Pressable>
        {active !== null ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open as thread"
            onPress={openAsThread}
            className="size-11 items-center justify-center rounded-full bg-card"
          >
            <SymbolView name="arrow.up.right" size={18} tintColorClassName="accent-icon" />
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close side chat"
          onPress={() => navigation.goBack()}
          className="size-11 items-center justify-center rounded-full bg-card"
        >
          <SymbolView name="xmark" size={18} tintColorClassName="accent-icon" />
        </Pressable>
      </View>

      {showList ? (
        <ScrollView
          className="flex-1"
          keyboardShouldPersistTaps="handled"
          contentContainerClassName="gap-3 p-4"
        >
          <Text className="text-sm text-foreground-secondary">
            Ask a quick question while the agent keeps working.
          </Text>
          {sidechats.map((thread) => (
            <Pressable
              key={thread.id}
              accessibilityRole="button"
              accessibilityLabel={`Reopen side chat: ${thread.title}`}
              disabled={pending}
              onPress={() => changeSelection(thread.id)}
              className="flex-row items-center gap-3 rounded-3xl border border-border-subtle bg-card p-4 active:opacity-70 disabled:opacity-50"
            >
              <SymbolView name="text.bubble" size={18} tintColorClassName="accent-icon" />
              <View className="min-w-0 flex-1 gap-1">
                <Text className="text-sm font-t3-medium" numberOfLines={2}>
                  {thread.title}
                </Text>
                <Text className="text-xs text-foreground-muted">
                  {relativeTime(thread.updatedAt)} ago
                  {isChildAgentRunning(thread) ? " · Working" : ""}
                </Text>
              </View>
              <SymbolView name="chevron.right" size={14} tintColorClassName="accent-icon-subtle" />
            </Pressable>
          ))}
        </ScrollView>
      ) : active !== null ? (
        <View className="flex-1">
          <ThreadFeed
            key={active.id}
            environmentId={environmentId}
            threadId={active.id}
            workspaceRoot={active.worktreePath ?? project?.workspaceRoot ?? null}
            feed={feed}
            contentPresentation={contentPresentation}
            agentLabel="Assistant"
            latestTurn={detail?.latestTurn ?? active.latestTurn}
            activeWorkStartedAt={null}
            queuedMessages={[]}
            dispatchingMessageId={null}
            onEditPendingMessage={() => {}}
            listRef={listRef}
            freeze={freeze}
            anchorMessageId={null}
            submittedMessageId={submittedMessageId}
            contentInsetEndAdjustment={contentInsetEndAdjustment}
            contentTopInset={0}
            contentBottomInset={12}
            usesAutomaticContentInsets={false}
            loadEarlier={
              threadHasOlderTurns(detailState)
                ? {
                    loading: Option.isSome(detailState.page) && detailState.page.value.loadingOlder,
                    onLoadEarlier: () => requestOlderThreadTurns(environmentId, active.id),
                  }
                : null
            }
          />
        </View>
      ) : (
        <View className="flex-1 items-center justify-center p-4">
          <Text className="text-sm text-foreground-secondary">
            {pending || awaitingCreatedShell
              ? "Opening side chat…"
              : "Ask anything about this thread without interrupting it. The side chat starts with what the main agent has done so far."}
          </Text>
        </View>
      )}

      {!showList ? (
        <View className="gap-2 px-3 pt-2" style={{ paddingBottom: Math.max(insets.bottom, 12) }}>
          {needsAnswer ? (
            <View className="gap-2">
              <Text accessibilityLiveRegion="polite" className="text-xs text-foreground-secondary">
                Needs your answer. Open the thread to respond.
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Open as thread"
                onPress={openAsThread}
                className="min-h-11 flex-row items-center justify-center gap-2 rounded-full bg-card px-3"
              >
                <SymbolView name="arrow.up.right" size={16} tintColorClassName="accent-icon" />
                <Text className="text-xs font-t3-medium">Open as thread</Text>
              </Pressable>
            </View>
          ) : working ? (
            // An even 4dp inset keeps the Stop pill concentric with the status pill.
            <View className="flex-row items-center justify-between gap-3 rounded-full bg-card py-1 pl-4 pr-1">
              <Text accessibilityLiveRegion="polite" className="text-xs text-foreground-secondary">
                Working…
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Stop side chat"
                disabled={!connected}
                hitSlop={4}
                onPress={() => active && void stop(active)}
                className="h-9 flex-row items-center gap-1.5 rounded-full bg-subtle px-3 active:opacity-70 disabled:opacity-50"
              >
                <SymbolView name="stop.fill" size={12} tintColorClassName="accent-icon" />
                <Text className="text-xs font-t3-medium">Stop</Text>
              </Pressable>
            </View>
          ) : null}
          {!connected || unavailable ? (
            <Text accessibilityLiveRegion="polite" className="text-xs text-foreground-secondary">
              {!connected
                ? "Connect to this environment to send a question."
                : "The parent thread is unavailable."}
            </Text>
          ) : working && !needsAnswer ? (
            <Text className="text-xs text-foreground-secondary">
              Wait for the reply or stop to send a follow-up.
            </Text>
          ) : null}
          {displayedError ? (
            <Text accessibilityRole="alert" className="text-xs text-danger-foreground">
              {displayedError}
            </Text>
          ) : null}
          <View className="overflow-hidden rounded-3xl border border-border-subtle bg-card px-2 pt-1">
            <TextInput
              accessibilityLabel={active === null ? "Ask about this thread" : "Side chat follow-up"}
              placeholder={active === null ? "Ask about this thread…" : "Ask a follow-up…"}
              multiline
              editable={!pending && !unavailable}
              value={question}
              onChangeText={setQuestion}
              className="max-h-32 min-h-12 rounded-none border-0 bg-transparent px-2 py-3 text-base"
            />
            <ComposerToolbarRow paddingHorizontal={0} paddingTop={0} paddingBottom={2}>
              <View className="min-w-0 flex-1">
                {selection && parent ? (
                  <SidechatModelPicker
                    environmentId={environmentId}
                    serverConfig={serverConfig}
                    selection={selection}
                    runtimeMode={active?.runtimeMode ?? parent.runtimeMode}
                    sessionInstanceId={active?.session?.providerInstanceId ?? null}
                    disabled={pending || working || unavailable}
                    onChange={setPicked}
                  />
                ) : null}
              </View>
              <ComposerActionButton
                accessibilityLabel="Send side chat question"
                disabled={!canSend}
                onPress={() => void sendQuestion()}
                icon="arrow.up"
              />
            </ComposerToolbarRow>
          </View>
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}
