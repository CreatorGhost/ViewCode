import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
  type ThreadGoal,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  memo,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { isTrailingDoubleClick } from "../Sidebar.logic";
import { toastManager } from "../ui/toast";
import { useThreadActionMenu } from "~/hooks/useThreadActionMenu";
import { readLocalApi } from "~/localApi";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { ProjectFavicon } from "../ProjectFavicon";
import { OpenThreadTabs, type ActiveTabExtras } from "../tabs/OpenThreadTabs";
import { useSplitPaneActions } from "../../splitView/SplitPaneContext";
import { SplitPaneControls } from "../../splitView/SplitPaneControls";
import { ThreadGoalChip } from "./ThreadGoalChip";
import { cn } from "~/lib/utils";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  activeThreadTitle: string;
  threadGoal?: ThreadGoal | null;
  onEditThreadGoal?: () => void;
  isServerThread: boolean;
  activeProject: EnvironmentProject | null;
  parentThreadLink: { threadId: ThreadId; title: string } | null;
  onOpenThread: (threadId: ThreadId) => void;
  rightPanelOpen: boolean;
  actions?: ReactNode;
  /** Each header control occupies a 36px button plus its 8px gap. */
  toolbarControlCount?: number;
  onNewThreadInProject: () => void;
  onOpenProjectSettings?: (() => void) | undefined;
}

export function resolveRenameCommit(input: {
  readonly title: string;
  readonly originalTitle: string;
}): { action: "commit"; title: string } | { action: "reject-empty" } | { action: "noop" } {
  const trimmed = input.title.trim();
  if (trimmed.length === 0) return { action: "reject-empty" };
  if (trimmed === input.originalTitle) return { action: "noop" };
  return { action: "commit", title: trimmed };
}

// How long a click on the thread title waits before opening the action menu, so
// a double-click-to-rename can cancel it first. Only the native desktop menu
// needs this: it swallows input while open, so the wait must cover the OS
// double-click interval.
const TITLE_MENU_OPEN_DELAY_MS = 500;
export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadId,
  activeThreadTitle,
  threadGoal,
  onEditThreadGoal,
  isServerThread,
  activeProject,
  rightPanelOpen,
  actions,
  toolbarControlCount,
  onOpenProjectSettings,
}: ChatHeaderProps) {
  const splitPane = useSplitPaneActions();
  const activeProjectCwd = activeProject?.workspaceRoot ?? null;
  const activeThreadRef = scopeThreadRef(activeThreadEnvironmentId, activeThreadId);
  const canOperateThread = useEnvironmentScope(
    activeThreadEnvironmentId,
    AuthOrchestrationOperateScope,
  );
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const [renaming, setRenaming] = useState<{
    threadId: ThreadId;
    environmentId: EnvironmentId;
    title: string;
  } | null>(null);
  if (
    renaming !== null &&
    (renaming.threadId !== activeThreadId ||
      renaming.environmentId !== activeThreadEnvironmentId ||
      !canOperateThread)
  ) {
    setRenaming(null);
  }
  const renamingTitle =
    canOperateThread &&
    renaming?.threadId === activeThreadId &&
    renaming.environmentId === activeThreadEnvironmentId
      ? renaming.title
      : null;
  const renameCommittedRef = useRef(false);
  const startRename = () => {
    if (
      !isServerThread ||
      !readEnvironmentScope(activeThreadEnvironmentId, AuthOrchestrationOperateScope)
    )
      return;
    renameCommittedRef.current = false;
    setRenaming({
      environmentId: activeThreadEnvironmentId,
      threadId: activeThreadId,
      title: activeThreadTitle,
    });
  };
  const commitRename = (title: string) => {
    setRenaming(null);
    if (!readEnvironmentScope(activeThreadEnvironmentId, AuthOrchestrationOperateScope)) return;
    const resolution = resolveRenameCommit({ title, originalTitle: activeThreadTitle });
    if (resolution.action === "reject-empty") {
      toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
      return;
    }
    if (resolution.action === "noop") return;
    void updateThreadMetadata({
      environmentId: activeThreadEnvironmentId,
      input: { threadId: activeThreadId, title: resolution.title },
    }).then((result) => {
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Failed to rename thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    });
  };
  const { openMenu, closeMenu } = useThreadActionMenu({
    threadRef: isServerThread ? activeThreadRef : null,
    projectCwd: activeProjectCwd,
    onStartRename: startRename,
  });
  const titleMenuAnchorRef = useRef<HTMLElement | null>(null);
  const titleMenuTimerRef = useRef<number | null>(null);
  const cancelPendingTitleMenu = () => {
    if (titleMenuTimerRef.current === null) return;
    clearTimeout(titleMenuTimerRef.current);
    titleMenuTimerRef.current = null;
  };
  useEffect(
    () => () => {
      if (titleMenuTimerRef.current === null) return;
      clearTimeout(titleMenuTimerRef.current);
      titleMenuTimerRef.current = null;
    },
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A pending title menu belongs to the thread that was clicked, so switching threads drops it.
    [activeThreadEnvironmentId, activeThreadId],
  );
  const openTitleMenuNow = () => {
    cancelPendingTitleMenu();
    const rect = titleMenuAnchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    openMenu({ x: rect.left, y: rect.bottom + 4 });
  };
  const openMenuFromTitle = (event: ReactMouseEvent<HTMLElement>) => {
    if (isTrailingDoubleClick(event.detail)) return;
    titleMenuAnchorRef.current = event.currentTarget;
    const clickedChevron =
      (event.target as HTMLElement).closest("[data-thread-title-chevron]") !== null;
    if (event.detail === 0 || clickedChevron || window.desktopBridge === undefined) {
      openTitleMenuNow();
      return;
    }
    cancelPendingTitleMenu();
    titleMenuTimerRef.current = window.setTimeout(() => {
      titleMenuTimerRef.current = null;
      openTitleMenuNow();
    }, TITLE_MENU_OPEN_DELAY_MS);
  };
  const handleTitleDoubleClick = (event: ReactMouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if ((event.target as HTMLElement).closest("[data-thread-title-chevron]") !== null) return;
    cancelPendingTitleMenu();
    closeMenu();
    startRename();
  };
  const handleHeaderContextMenu = (event: ReactMouseEvent) => {
    if (renamingTitle !== null) return;
    const target = event.target as HTMLElement;
    if (target.closest("[data-chat-header-actions]")) return;
    const tab = target.closest("[data-thread-tab]");
    if (tab && tab.getAttribute("data-active") !== "true") return;
    if (!isServerThread && onOpenProjectSettings === undefined) return;
    cancelPendingTitleMenu();
    event.preventDefault();
    if (!isServerThread) {
      const api = readLocalApi();
      if (!api) return;
      void api.contextMenu
        .show([{ id: "project-settings", label: "Project settings", icon: "settings" }], {
          x: event.clientX,
          y: event.clientY,
        })
        .then((action) => {
          if (action === "project-settings") onOpenProjectSettings?.();
        });
      return;
    }
    openMenu({ x: event.clientX, y: event.clientY });
  };
  const handleRenameKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      renameCommittedRef.current = true;
      commitRename(event.currentTarget.value);
    } else if (event.key === "Escape") {
      renameCommittedRef.current = true;
      setRenaming(null);
    }
  };
  const activeTabExtras: ActiveTabExtras = {
    ...(activeProject
      ? { glyph: <ProjectFavicon project={activeProject} className="size-3.5 shrink-0" /> }
      : {}),
    ...(renamingTitle === null
      ? {}
      : {
          renameField: (
            <input
              autoFocus
              aria-label="Thread title"
              className="min-w-0 flex-1 rounded-sm bg-transparent text-xs font-medium text-foreground outline-none ring-1 ring-inset ring-ring/50 focus:ring-ring"
              defaultValue={renamingTitle}
              onClick={(event) => event.stopPropagation()}
              onBlur={(event) => {
                if (renameCommittedRef.current) return;
                if (
                  event.relatedTarget instanceof HTMLElement &&
                  event.relatedTarget.closest("button")
                ) {
                  setRenaming(null);
                  return;
                }
                commitRename(event.currentTarget.value);
              }}
              onFocus={(event) => event.currentTarget.select()}
              onKeyDown={handleRenameKeyDown}
            />
          ),
        }),
    ...(isServerThread
      ? {
          onClick: openMenuFromTitle,
          onDoubleClick: canOperateThread ? handleTitleDoubleClick : undefined,
          onBlur: cancelPendingTitleMenu,
          onKeyActivate: (anchor: HTMLElement) => {
            titleMenuAnchorRef.current = anchor;
            openTitleMenuNow();
          },
        }
      : {}),
  };
  return (
    <div
      className={cn(
        "@container/header-actions flex min-w-0 flex-1 items-center gap-2 sm:gap-3",
        rightPanelOpen ? "pr-10" : "pr-24",
      )}
      style={
        toolbarControlCount === undefined
          ? undefined
          : { paddingRight: `calc(${toolbarControlCount} * 2.75rem)` }
      }
      onContextMenu={handleHeaderContextMenu}
    >
      <div className="min-w-0 flex-1" aria-label="Thread" role="group">
        <OpenThreadTabs
          activeRef={activeThreadRef}
          fallbackTitle={activeThreadTitle}
          paneOnly={splitPane !== null}
          activeExtras={activeTabExtras}
        />
      </div>
      {splitPane ? (
        <div data-chat-header-actions>
          <SplitPaneControls {...splitPane} />
        </div>
      ) : null}
      {threadGoal && onEditThreadGoal ? (
        <ThreadGoalChip goal={threadGoal} onEdit={onEditThreadGoal} disabled={!canOperateThread} />
      ) : null}
      {actions}
    </div>
  );
});
