import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ModelSelection, ProviderInstanceId, ScopedThreadRef } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { ExternalLinkIcon, MessageSquarePlusIcon, SquareIcon, XIcon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import {
  clampSidechatDockWidth,
  selectSidechatDock,
  SIDECHAT_DOCK_MAX_WIDTH_PX,
  SIDECHAT_DOCK_MIN_WIDTH_PX,
  useSidechatDockStore,
} from "../../sidechatDockStore";
import { useEnvironments } from "../../state/environments";
import { useThread, useThreadShells } from "../../state/entities";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProviderModelPicker } from "./ProviderModelPicker";
import {
  FRESH_SIDECHAT,
  isPinnedToBottom,
  resolveActiveSidechat,
  sidechatsOf,
} from "./sidechat.logic";
import { useSidechatActions } from "./useSidechatActions";

const EMPTY_PROMPT_HINT = "Ask a quick question about this thread";

function isRunning(status: string | undefined) {
  return status === "starting" || status === "running";
}

/**
 * The side chat beside a thread: a compact transcript and composer for quick
 * questions. The parent keeps working; nothing here writes to it.
 */
export const SidechatDock = memo(function SidechatDock(props: {
  parent: EnvironmentThreadShell;
  markdownCwd: string | undefined;
}) {
  const { parent } = props;
  const parentRef = useMemo(
    () => scopeThreadRef(parent.environmentId, parent.id),
    [parent.environmentId, parent.id],
  );
  const dock = useSidechatDockStore((state) => selectSidechatDock(state.byParentKey, parentRef));
  const widthPx = useSidechatDockStore((state) => state.widthPx);
  const shells = useThreadShells();
  const sidechats = useMemo(
    () =>
      sidechatsOf(
        shells.filter((shell) => shell.environmentId === parent.environmentId),
        parent.id,
      ),
    [parent.environmentId, parent.id, shells],
  );
  const active = resolveActiveSidechat(sidechats, dock.activeThreadId);
  const activeRef = useMemo<ScopedThreadRef | null>(
    () => (active ? scopeThreadRef(parent.environmentId, active.id) : null),
    [active, parent.environmentId],
  );
  const thread = useThread(activeRef);
  const { ask, reply, stop, promote } = useSidechatActions();

  // Providers and model choices for the dock's own picker.
  const settings = useEnvironmentSettings(parent.environmentId);
  const { environments } = useEnvironments();
  const providers =
    environments.find((environment) => environment.environmentId === parent.environmentId)
      ?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  const entries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ),
    [providers, settings],
  );
  // Same provider and model as the parent by default; the picker overrides it.
  const [picked, setPicked] = useState<ModelSelection | null>(null);
  const selection: ModelSelection = picked ?? thread?.modelSelection ?? parent.modelSelection;
  const modelOptions = useMemo(
    () =>
      getCustomModelOptionsByInstance(settings, providers, selection.instanceId, selection.model),
    [providers, selection.instanceId, selection.model, settings],
  );
  const activeEntry = entries.find((entry) => entry.instanceId === selection.instanceId);
  const onModelChange = useCallback((instanceId: ProviderInstanceId, model: string) => {
    setPicked(createModelSelection(instanceId, model));
  }, []);

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // A prefill (the selection action's quote) lands in the composer once, below any
  // unsent text rather than replacing it.
  useEffect(() => {
    const apply = () => {
      const prefill = useSidechatDockStore.getState().consumePrefill(parentRef);
      if (prefill === null) return;
      setDraft((current) =>
        current.trim().length > 0 ? `${current.trimEnd()}\n\n${prefill}` : prefill,
      );
      textareaRef.current?.focus({ preventScroll: true });
    };
    apply();
    return useSidechatDockStore.subscribe(apply);
  }, [parentRef]);

  const running = isRunning(thread?.session?.status);
  const messages = thread?.messages ?? [];
  const lastMessage = messages.at(-1);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  // Follow new output only while the reader is at the bottom; scrolling up to
  // reread is never yanked back by the next streamed token.
  const stickToBottomRef = useRef(true);
  useEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript && stickToBottomRef.current) transcript.scrollTop = transcript.scrollHeight;
  }, [messages.length, lastMessage?.text.length]);

  const submit = useCallback(async () => {
    const text = draft.trim();
    if (text.length === 0 || sending || running) return;
    setSending(true);
    setDraft("");
    stickToBottomRef.current = true;
    try {
      if (activeRef === null) {
        await ask({ parent, question: text, modelSelection: selection });
      } else {
        await reply({
          threadRef: activeRef,
          text,
          modelSelection: selection,
          runtimeMode: parent.runtimeMode,
        });
      }
    } finally {
      setSending(false);
    }
  }, [activeRef, ask, draft, parent, reply, running, selection, sending]);

  const startResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = widthPx;
      const move = (next: PointerEvent) =>
        useSidechatDockStore.getState().setWidth(startWidth + (startX - next.clientX));
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [widthPx],
  );

  return (
    <aside
      aria-label="Side chat"
      data-sidechat-dock
      className="relative flex h-full min-h-0 shrink-0 flex-col border-l border-border bg-background"
      style={{ width: clampSidechatDockWidth(widthPx) }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-valuemin={SIDECHAT_DOCK_MIN_WIDTH_PX}
        aria-valuemax={SIDECHAT_DOCK_MAX_WIDTH_PX}
        aria-valuenow={clampSidechatDockWidth(widthPx)}
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize"
        onPointerDown={startResize}
      />
      <header className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-3">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {active?.title ?? "Side chat"}
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost-muted"
                size="icon-xs"
                aria-label="New side chat"
                onClick={() => {
                  useSidechatDockStore.getState().setActive(parentRef, FRESH_SIDECHAT);
                  stickToBottomRef.current = true;
                  setPicked(null);
                  setDraft("");
                }}
              />
            }
          >
            <MessageSquarePlusIcon />
          </TooltipTrigger>
          <TooltipPopup>New side chat</TooltipPopup>
        </Tooltip>
        {activeRef !== null ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost-muted"
                  size="icon-xs"
                  aria-label="Open as full thread"
                  onClick={() => void promote(activeRef, parentRef)}
                />
              }
            >
              <ExternalLinkIcon />
            </TooltipTrigger>
            <TooltipPopup>Open as full thread</TooltipPopup>
          </Tooltip>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost-muted"
                size="icon-xs"
                aria-label="Close side chat"
                onClick={() => useSidechatDockStore.getState().close(parentRef)}
              />
            }
          >
            <XIcon />
          </TooltipTrigger>
          <TooltipPopup>Close (the side chat is kept)</TooltipPopup>
        </Tooltip>
      </header>

      <div
        ref={transcriptRef}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-3"
        onScroll={(event) => {
          stickToBottomRef.current = isPinnedToBottom(event.currentTarget);
        }}
      >
        {messages.length === 0 ? (
          <p className="px-1 pt-6 text-center text-sm text-muted-foreground">
            Ask anything about this thread without interrupting it. The side chat starts with what
            the main agent has done so far.
          </p>
        ) : (
          <ol className="flex flex-col gap-3">
            {messages.map((message) =>
              message.role === "user" ? (
                <li key={message.id} className="flex justify-end">
                  <div className="max-w-[92%] rounded-xl bg-secondary px-3 py-2 text-sm whitespace-pre-wrap text-secondary-foreground">
                    {message.text}
                  </div>
                </li>
              ) : message.role === "assistant" && message.text.trim().length > 0 ? (
                <li key={message.id} className="min-w-0 text-sm text-foreground">
                  <ChatMarkdown
                    text={message.text}
                    cwd={props.markdownCwd}
                    threadRef={activeRef ?? undefined}
                    isStreaming={message.streaming}
                    headingLevelOffset={3}
                  />
                </li>
              ) : null,
            )}
          </ol>
        )}
        {running && lastMessage?.role !== "assistant" ? (
          <p className="pt-3 text-xs text-muted-foreground">Working…</p>
        ) : null}
      </div>

      <footer className="shrink-0 border-t border-border p-3">
        <Textarea
          ref={textareaRef}
          size="sm"
          value={draft}
          placeholder={EMPTY_PROMPT_HINT}
          aria-label="Side chat message"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            void submit();
          }}
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="min-w-0">
            {activeEntry ? (
              <ProviderModelPicker
                activeInstanceId={selection.instanceId}
                model={selection.model}
                lockedProvider={null}
                instanceEntries={entries}
                modelOptionsByInstance={modelOptions}
                size="xs"
                disabled={running}
                onInstanceModelChange={onModelChange}
              />
            ) : null}
          </div>
          {running && activeRef !== null ? (
            <Button
              variant="outline"
              size="xs"
              aria-label="Stop side chat"
              onClick={() => void stop(activeRef)}
            >
              <SquareIcon /> Stop
            </Button>
          ) : (
            <Button size="xs" disabled={draft.trim().length === 0 || sending} onClick={submit}>
              Ask
            </Button>
          )}
        </div>
      </footer>
    </aside>
  );
});
