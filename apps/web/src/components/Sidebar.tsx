import { useSupportsMultiplePullRequests } from "~/hooks/useSupportsMultiplePullRequests";
import { resolveThreadCurrentPullRequestLink } from "@t3tools/shared/threadPullRequests";
import { useAtomValue } from "@effect/atom-react";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { closestCenter, DndContext, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import { planPinnedReorder, sortThreads } from "@t3tools/client-runtime/state/thread-sort";
import {
  threadSearchMatchKey,
  type EnvironmentThreadSearchMatch,
} from "@t3tools/client-runtime/state/thread-search";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  parseScopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import {
  resolveEnvironmentMachineKind,
  type EnvironmentMachineKind,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import {
  ArchiveIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  EllipsisIcon,
  EyeIcon,
  FolderIcon,
  FolderOpenIcon,
  GitBranchIcon,
  HandIcon,
  MessageSquareIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  SettingsIcon,
  SquarePenIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useParams, useRouter } from "@tanstack/react-router";

import { useRightPanelStore } from "../rightPanelStore";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { isElectron } from "../env";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  shouldShowThreadJumpHintsForModifiers,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../keybindings";
import { useShortcutModifierState } from "../shortcutModifierState";
import { useTerminalFocus } from "../hooks/useTerminalFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { isMacPlatform } from "~/lib/utils";
import { useOpenPrLink } from "../lib/openPullRequestLink";
import { releaseComposerDraftUploads } from "../lib/composerDraftUploads";
import { readLocalApi } from "../localApi";
import { useSidebarPendingFileDropStore } from "../sidebarPendingFileDropStore";
import { getProjectOrderKey, selectProjectGroupingSettings } from "../logicalProject";
import {
  buildSidebarProjectSnapshots,
  projectGroupsSpanEnvironments,
  type SidebarProjectSnapshot,
} from "../sidebarProjectGrouping";
import {
  legacyProjectCwdPreferenceKey,
  resolveProjectExpanded,
  useUiStateStore,
} from "../uiStateStore";
import {
  getThreadKeysToDeselectAfterDelete,
  useThreadSelectionStore,
} from "../threadSelectionStore";
import { useThreadActions } from "../hooks/useThreadActions";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { isCommandPaletteOpen, openCommandPalette } from "../commandPaletteBus";
import { startNewThreadFromContext } from "../lib/chatThreadActions";
import { useClientSettings } from "../hooks/useSettings";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { useNowMinute } from "../hooks/useNowMinute";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import {
  readThreadShell,
  useAllEnvironmentProjectSnapshotsReady,
  useProjects,
  useThreadShells,
} from "../state/entities";
import { environmentServerConfigsAtom, primaryServerKeybindingsAtom } from "../state/server";
import { vcsEnvironment } from "../state/vcs";
import { threadEnvironment } from "../state/threads";
import { useEnvironmentQuery } from "../state/query";
import { useThreadSearch } from "../state/queries";
import { useAtomCommand } from "../state/use-atom-command";
import {
  buildThreadRouteParams,
  resolveActiveThreadRouteRef,
  resolveThreadRouteTarget,
} from "../threadRoutes";
import { formatRelativeTimeLabel } from "../timestampFormat";
import type { SidebarThreadSummary } from "../types";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { cn } from "~/lib/utils";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { ProjectEnvironmentBadge } from "./ProjectEnvironmentBadge";
import { buildThreadActionMenuItems } from "./threadActionMenu.logic";
import {
  openImportSessionsDialog,
  openRemoveImportedSessionsDialog,
} from "./agentSessions/AgentSessionDialogsHost";
import {
  archiveSelectedThreadEntries,
  buildBulkTitleRegenerationContextMenuItem,
  buildBulkUnpinContextMenuItem,
  deleteSelectedThreadEntries,
  filterSidebarProjectScopeItems,
  hasUnseenCompletion,
  isSidebarNestedLinkClick,
  isTrailingDoubleClick,
  orderItemsByPreferredIds,
  reduceSidebarProjectScopeMenuState,
  resolveAdjacentThreadId,
  resolveSidebarThreadStatus,
  searchSidebarThreads,
  shouldCreateNewThreadInCurrentProject,
  sortLogicalProjectsForSidebar,
  sortPinnedThreadsForSidebar,
  useRetainedValue,
  useSidebarRowSubscriptionLease,
  useThreadJumpHintVisibility,
} from "./Sidebar.logic";
import { resolveLocalCheckoutBranchMismatch } from "./BranchToolbar.logic";
import { SidebarDragLifecycle, SidebarPointerSensor } from "./Sidebar.pointer";
import {
  buildSidebarThreadTree,
  collectVisibleSidebarThreadKeys,
  flattenSidebarThreadNode,
  sidebarThreadAncestorKeys,
  type SidebarThreadRowEntry,
  type SidebarThreadTreeNode,
} from "./sidebar/sidebarThreadTree";
import {
  ThreadPullRequestBadgeControl,
  ThreadPullRequestsMiniList,
  prStatusIndicator,
  resolveThreadPullRequestBadge,
  terminalStatusFromRunningIds,
  synchronizeTerminalPulse,
  type TerminalStatusIndicator,
  useLinkedThreadPullRequest,
} from "./ThreadStatusIndicators";
import { ProjectFavicon, type ProjectFaviconProject } from "./ProjectFavicon";
import { ThreadSearchMatchExcerpt } from "./ThreadSearchMatch";
import { makeWorkspaceFileDropHandlers } from "./chat/workspaceFileDrop";
import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";
import { getTriggerDisplayModelLabel } from "./chat/providerIconUtils";
import {
  deriveProviderEntriesByEnvironment,
  shouldShowInstanceBadge,
  type ProviderInstanceEntry,
} from "../providerInstances";
import { useThreadRunningTerminalIds } from "../state/terminalSessions";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Button, InlineButton } from "./ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxSearchInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
  useComboboxFilter,
} from "./ui/combobox";
import { SidebarContent, SidebarGroup, useSidebar } from "./ui/sidebar";
import { SidebarChromeFooter, SidebarChromeHeader } from "./sidebar/SidebarChrome";
import { SidebarHeaderIconButton, SidebarThreadHeader } from "./sidebar/SidebarThreadHeader";
import { Spinner } from "./ui/spinner";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { MiddleTruncate } from "./ui/middle-truncate";
import {
  composerDraftHasUserContent,
  DraftId,
  useComposerDraftStore,
  useThreadHasUnsentDraft,
  type ComposerThreadDraftState,
  type DraftSessionState,
} from "../composerDraftStore";

// Droppy-style geometry: a 20px icon slot after an 8px inset, so child-agent
// connectors run down the middle of their parent's slot (x = 18) and every
// nesting level shifts content by one slot.
const ROW_INSET_PX = 8;
const ICON_SLOT_PX = 20;
const CONNECTOR_CLASS_NAME =
  "pointer-events-none absolute border-dotted border-sidebar-foreground/30";

function connectorLeftPx(level: number): number {
  return ROW_INSET_PX + ICON_SLOT_PX / 2 + (level - 1) * ICON_SLOT_PX;
}

function compactSidebarTimeLabel(label: string): string {
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}

function threadTimeLabel(thread: SidebarThreadSummary): string {
  const timestamp = thread.latestUserMessageAt ?? thread.updatedAt;
  return compactSidebarTimeLabel(formatRelativeTimeLabel(timestamp));
}

function threadKeyOf(thread: Pick<EnvironmentThreadShell, "environmentId" | "id">): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

function physicalProjectKeyOf(thread: Pick<EnvironmentThreadShell, "environmentId" | "projectId">) {
  return `${thread.environmentId}:${thread.projectId}` as const;
}

// Child agents read in the order they were spawned.
function sortChildThreads(threads: readonly EnvironmentThreadShell[]) {
  return threads.toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
}

function projectExpansionPreferenceKeys(project: SidebarProjectSnapshot): string[] {
  return [
    project.projectKey,
    ...project.memberProjects.map((member) => member.physicalProjectKey),
    ...project.memberProjects.map((member) => legacyProjectCwdPreferenceKey(member.workspaceRoot)),
  ];
}

// Floats at the row's right edge while the jump modifier is held, so it never
// shifts the row's own content.
function JumpHintBadge(props: { label: string }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute right-1.5 top-1/2 z-10 inline-flex h-5 -translate-y-1/2 items-center rounded-full border border-border/80 bg-background/95 px-1.5 font-mono text-3xs font-medium tracking-tight text-foreground shadow-sm"
    >
      {props.label}
    </span>
  );
}

const EMPTY_PROVIDER_ENTRIES: ReadonlyMap<string, ProviderInstanceEntry> = new Map();

function terminalProcessLabel(count: number): string {
  return `${count} terminal ${count === 1 ? "process" : "processes"} running`;
}

function SidebarThreadTooltip({
  thread,
  project,
  projectDisplayName,
  environmentLabel,
  environmentMachine,
  providerEntry,
  showInstanceBadge,
  modelInstanceId,
  modelLabel,
  branchMismatch,
  terminalStatus,
  terminalProcessCount,
}: {
  thread: SidebarThreadSummary;
  project: ProjectFaviconProject | null;
  projectDisplayName: string | null;
  environmentLabel: string | null;
  environmentMachine: EnvironmentMachineKind;
  providerEntry: ProviderInstanceEntry | null;
  showInstanceBadge: boolean;
  modelInstanceId: string;
  modelLabel: string;
  branchMismatch: {
    threadBranch: string;
    currentBranch: string;
  } | null;
  terminalStatus: TerminalStatusIndicator | null;
  terminalProcessCount: number;
}) {
  const driverKind = providerEntry?.driverKind ?? null;
  const supportsMultiplePullRequests = useSupportsMultiplePullRequests(thread.environmentId);
  return (
    <TooltipPopup side="right" align="start" sideOffset={4} variant="glass">
      {/* The viewport's own inset (py-1 px-2) plus this one make the floating inset. */}
      <div className="flex min-w-0 max-w-80 flex-col gap-2 px-1 py-2">
        <div className="min-w-0 truncate text-xs leading-tight font-medium text-foreground">
          {thread.title}
        </div>
        <div className="grid gap-1.5 pl-0.5 text-xs text-muted-foreground">
          {projectDisplayName ? (
            <div className="flex min-w-0 items-center gap-2">
              {project ? <ProjectFavicon project={project} className="size-3 shrink-0" /> : null}
              <div className="min-w-0 truncate text-foreground/75">{projectDisplayName}</div>
            </div>
          ) : null}
          {environmentLabel ? (
            <div className="flex min-w-0 items-center gap-2">
              <EnvironmentMachineIcon
                kind={environmentMachine}
                className="size-3 shrink-0 stroke-muted-foreground"
              />
              <div className="min-w-0 truncate text-foreground/75">{environmentLabel}</div>
            </div>
          ) : null}
          {thread.branch ? (
            <div className="flex min-w-0 items-center gap-2 text-foreground/75">
              <GitBranchIcon className="size-3 shrink-0 stroke-muted-foreground" />
              <MiddleTruncate value={thread.branch} className="flex" />
            </div>
          ) : null}
          {branchMismatch ? (
            <div className="flex min-w-0 items-start gap-2 text-warning">
              <CircleAlertIcon aria-hidden className="mt-0.5 size-3 shrink-0 stroke-current" />
              <div className="min-w-0 flex-1 wrap-break-word leading-5">
                You're currently checked out on another branch.
              </div>
            </div>
          ) : null}
          {driverKind ? (
            <div className="flex min-w-0 items-center gap-2">
              <ProviderInstanceIcon
                driverKind={driverKind}
                displayName={
                  providerEntry?.displayName ?? thread.session?.providerName ?? modelInstanceId
                }
                accentColor={providerEntry?.accentColor}
                // Initials would swallow a size-3 glyph: accent dot, name in label.
                showBadge={showInstanceBadge && providerEntry?.accentColor !== undefined}
                badgeContent="none"
                badgeClassName="h-2 min-w-2 px-0"
                iconClassName="size-3 shrink-0 grayscale opacity-60"
              />
              <div className="min-w-0 truncate text-foreground/75">
                {showInstanceBadge && providerEntry
                  ? `${modelLabel} · ${providerEntry.displayName}`
                  : modelLabel}
              </div>
            </div>
          ) : null}
          {terminalStatus ? (
            <div className="flex min-w-0 items-center gap-2">
              <TerminalIcon
                aria-hidden
                className={cn("size-3 shrink-0", terminalStatus.colorClass)}
              />
              <div className="min-w-0 truncate text-foreground/75">
                {terminalProcessLabel(terminalProcessCount)}
              </div>
            </div>
          ) : null}
          {thread.session?.lastError ? (
            <div className="flex min-w-0 items-center gap-2 text-destructive-foreground">
              <CircleAlertIcon className="size-3 shrink-0 stroke-current" />
              <div className="min-w-0 truncate">Error occurred</div>
            </div>
          ) : null}
        </div>
        {supportsMultiplePullRequests && thread.pullRequests.length > 0 ? (
          <div className="border-t border-border/60 pt-2 pl-0.5 text-xs text-muted-foreground">
            <ThreadPullRequestsMiniList pullRequests={thread.pullRequests} />
          </div>
        ) : null}
      </div>
    </TooltipPopup>
  );
}

// Subset of useSortable applied to a pinned node. Listeners go on the node's
// top-level row (no dedicated handle): the pointer sensor's distance
// constraint keeps plain clicks working.
type SortableNodeBag = Pick<
  ReturnType<typeof useSortable>,
  "listeners" | "setNodeRef" | "transform" | "transition" | "isDragging"
>;

function SortablePinnedNode(props: {
  id: string;
  disabled: boolean;
  children: (bag: SortableNodeBag) => ReactNode;
}) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.id,
    disabled: { draggable: props.disabled },
  });
  // dnd-kit memoizes each field but not the bag, so memoized rows would
  // rerender on every shell update without this.
  const bag = useMemo(
    () => ({ listeners, setNodeRef, transform, transition, isDragging }),
    [listeners, setNodeRef, transform, transition, isDragging],
  );
  return props.children(bag);
}

// Unsent work shares one look: the new-thread draft rows and thread rows
// with unsent composer text both use this tint and pen so they read alike.
const draftSurfaceClassName = "bg-warning/4 hover:bg-warning/8";
const draftPenClassName = "size-3 shrink-0 text-warning-foreground";

const rowSurfaceBaseClassName =
  "group/sidebar-row relative flex w-full cursor-pointer items-center gap-1.5 rounded-md pr-2 text-left text-row outline-none select-none focus-visible:bg-sidebar-foreground/6";

// One unsent draft session the user has invested content in: the typed
// prompt and its project. Clicking is a plain navigation to /draft/$draftId.
// While the draft is open the row renders a frozen snapshot (see
// SidebarDraftBlock); memoized so per-keystroke block re-renders skip it.
const SidebarDraftRow = memo(function SidebarDraftRow(props: {
  draftId: DraftId;
  session: DraftSessionState;
  composer: ComposerThreadDraftState;
  projectDisplayName: string | null;
  isActive: boolean;
  onNavigate: (draftId: DraftId) => void;
  onDiscard: (draftId: DraftId) => void;
}) {
  const { composer, draftId, onDiscard, onNavigate } = props;
  const promptPreview =
    replaceComposerContextReferences(composer.prompt, (occurrence) => occurrence.label)
      .trim()
      .split("\n", 1)[0] ?? "";
  // images mirrors persistedAttachments once rehydration finishes; before
  // that only the persisted list is populated, hence max not sum.
  const attachmentCount =
    Math.max(composer.images.length, composer.persistedAttachments.length) +
    composer.files.length +
    composer.terminalContexts.length +
    composer.previewAnnotations.length +
    composer.reviewComments.length;
  const preview =
    promptPreview.length > 0
      ? promptPreview
      : `${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}`;
  const handleActivate = useCallback(() => onNavigate(draftId), [draftId, onNavigate]);
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      // Keys targeting the nested discard button belong to the button.
      if ((event.target as HTMLElement).closest("button")) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onNavigate(draftId);
      }
    },
    [draftId, onNavigate],
  );
  const handleDiscard = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onDiscard(draftId);
    },
    [draftId, onDiscard],
  );
  return (
    <li className="list-none">
      <div
        role="button"
        tabIndex={0}
        data-testid="sidebar-draft-row"
        className={cn(
          rowSurfaceBaseClassName,
          "h-7 pl-2 text-sidebar-foreground",
          props.isActive ? "bg-sidebar-foreground/12 font-medium" : draftSurfaceClassName,
        )}
        onClick={handleActivate}
        onKeyDown={handleKeyDown}
      >
        <span className="flex size-5 shrink-0 items-center justify-center">
          <SquarePenIcon aria-hidden className={draftPenClassName} />
        </span>
        <span className="min-w-0 flex-1 truncate">{preview}</span>
        {props.projectDisplayName ? (
          <span className="max-w-[40%] shrink-0 truncate text-xs text-sidebar-muted-foreground group-hover/sidebar-row:hidden">
            {props.projectDisplayName}
          </span>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Discard draft"
                onClick={handleDiscard}
                className="hidden size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:inline-flex group-hover/sidebar-row:inline-flex"
              >
                <XIcon className="size-3" />
              </button>
            }
          />
          <TooltipPopup side="top">Discard draft</TooltipPopup>
        </Tooltip>
      </div>
    </li>
  );
});

interface SidebarDraftRowData {
  draftId: DraftId;
  session: DraftSessionState;
  composer: ComposerThreadDraftState;
}

// Draft sessions with user content, surfaced above the thread tree so an
// interrupted "new thread" stays one click away. Self-contained (own store
// subscription + closing divider) so per-keystroke composer updates
// re-render only this block, never the whole sidebar. Vanishes at count 0.
const SidebarDraftBlock = memo(function SidebarDraftBlock(props: {
  projectDisplayNameByKey: ReadonlyMap<string, string>;
  scopedProjectKeys: ReadonlySet<string> | null;
  routeDraftId: string | null;
  onNavigateToDraft: (draftId: DraftId) => void;
}) {
  const draftThreadsByThreadKey = useComposerDraftStore((store) => store.draftThreadsByThreadKey);
  const draftsByThreadKey = useComposerDraftStore((store) => store.draftsByThreadKey);
  const clearDraftThread = useComposerDraftStore((store) => store.clearDraftThread);
  // The open draft's row is FROZEN at the moment the draft became the route:
  // it stays visible (like a thread row) but never repaints while the user
  // types. A draft that was never navigated away from has no snapshot to
  // freeze, so a fresh typing session shows no row at all. Captured
  // synchronously on route change so the row never flickers out for a frame.
  const [frozenActive, setFrozenActive] = useState<{
    routeDraftId: string | null;
    row: SidebarDraftRowData | null;
  }>({ routeDraftId: null, row: null });
  if (frozenActive.routeDraftId !== props.routeDraftId) {
    let row: SidebarDraftRowData | null = null;
    if (props.routeDraftId !== null) {
      const draftId = DraftId.make(props.routeDraftId);
      const store = useComposerDraftStore.getState();
      const session = store.getDraftSession(draftId);
      const composer = store.getComposerDraft(draftId);
      row =
        session && session.promotedTo == null && composer && composerDraftHasUserContent(composer)
          ? { draftId, session, composer }
          : null;
    }
    setFrozenActive({ routeDraftId: props.routeDraftId, row });
  }
  const drafts = useMemo(() => {
    const rows: SidebarDraftRowData[] = [];
    // Every non-promoted session with content gets a row, mapped or not:
    // new-thread surfaces mint fresh drafts and leave invested ones behind
    // unmapped, so the mapping only knows about the latest per project.
    for (const [draftKey, session] of Object.entries(draftThreadsByThreadKey)) {
      if (session.promotedTo != null) {
        continue;
      }
      if (
        props.scopedProjectKeys !== null &&
        !props.scopedProjectKeys.has(`${session.environmentId}:${session.projectId}`)
      ) {
        continue;
      }
      if (draftKey === props.routeDraftId) {
        // Open draft: render the frozen entry snapshot, or nothing for a
        // draft that has never been left. Gated on the LIVE session above so
        // send/discard still removes the row immediately.
        if (frozenActive.routeDraftId === draftKey && frozenActive.row !== null) {
          rows.push(frozenActive.row);
        }
        continue;
      }
      const composer = draftsByThreadKey[draftKey];
      if (!composer || !composerDraftHasUserContent(composer)) {
        continue;
      }
      rows.push({ draftId: DraftId.make(draftKey), session, composer });
    }
    rows.sort((left, right) => right.session.createdAt.localeCompare(left.session.createdAt));
    return rows;
  }, [
    draftThreadsByThreadKey,
    draftsByThreadKey,
    frozenActive,
    props.routeDraftId,
    props.scopedProjectKeys,
  ]);
  const handleDiscard = useCallback(
    (draftId: DraftId) => {
      // The /draft/$draftId route redirects home on its own when the draft
      // it renders disappears, so discarding the open draft needs no
      // special-casing here.
      releaseComposerDraftUploads(draftId);
      clearDraftThread(draftId);
    },
    [clearDraftThread],
  );
  if (drafts.length === 0) {
    return null;
  }
  return (
    <>
      {drafts.map(({ composer, draftId, session }) => (
        <SidebarDraftRow
          key={draftId}
          draftId={draftId}
          session={session}
          composer={composer}
          projectDisplayName={
            props.projectDisplayNameByKey.get(`${session.environmentId}:${session.projectId}`) ??
            null
          }
          isActive={draftId === props.routeDraftId}
          onNavigate={props.onNavigateToDraft}
          onDiscard={handleDiscard}
        />
      ))}
      <li
        aria-hidden
        data-testid="sidebar-draft-divider"
        className="mx-2 my-1 h-px list-none bg-sidebar-border/60"
      />
    </>
  );
});

/**
 * A hover action at a row's trailing edge. Stops pointer-down so pressing it
 * never starts a pinned-row drag, and double-click so it never starts a rename.
 */
function SidebarRowAction(props: {
  label: string;
  tooltip?: string;
  disabled?: boolean;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={props.label}
            disabled={props.disabled}
            onClick={props.onClick}
            onPointerDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-sidebar-muted-foreground hover:bg-sidebar-foreground/8 hover:text-sidebar-foreground disabled:cursor-default disabled:opacity-40"
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.tooltip ?? props.label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Dotted connectors for a child-agent row. `guides` carries one "1"/"0" per
 * ancestor level above the row's parent ("1": that level's line continues past
 * this row); the row's own level ends at its middle when it is the last child.
 */
function ChildAgentConnectors(props: { depth: number; isLastSibling: boolean; guides: string }) {
  const lines: ReactNode[] = [];
  for (let index = 0; index < props.guides.length; index += 1) {
    if (props.guides[index] !== "1") continue;
    lines.push(
      <span
        key={index}
        aria-hidden
        className={cn(CONNECTOR_CLASS_NAME, "inset-y-0 border-l")}
        style={{ left: connectorLeftPx(index + 1) }}
      />,
    );
  }
  const left = connectorLeftPx(props.depth);
  return (
    <>
      {lines}
      <span
        aria-hidden
        className={cn(
          CONNECTOR_CLASS_NAME,
          "top-0 border-l",
          props.isLastSibling ? "h-1/2" : "bottom-0",
        )}
        style={{ left }}
      />
      <span
        aria-hidden
        className={cn(CONNECTOR_CLASS_NAME, "top-1/2 w-1.5 border-t")}
        style={{ left }}
      />
    </>
  );
}

const SidebarThreadRow = memo(function SidebarThreadRow(props: {
  thread: SidebarThreadSummary;
  /** 0 for a top-level thread, 1+ for child agents. */
  depth: number;
  isLastSibling: boolean;
  guides: string;
  /** Child agents below this thread (all depths); 0 hides the disclosure. */
  descendantCount: number;
  childrenExpanded: boolean;
  onToggleChildren: (threadKey: string) => void;
  isPinned: boolean;
  pinningSupported: boolean;
  isActive: boolean;
  openPullRequestsInRightPanel: boolean;
  jumpLabel: string | null;
  currentEnvironmentId: string | null;
  environmentLabel: string | null;
  environmentMachine: EnvironmentMachineKind;
  project: EnvironmentProject | null;
  projectDisplayName: string | null;
  providerEntryByInstanceId: ReadonlyMap<string, ProviderInstanceEntry>;
  /** Re-renders the relative time label once a minute. */
  nowMinute: string;
  onThreadClick: (event: ReactMouseEvent, threadRef: ScopedThreadRef) => void;
  onThreadActivate: (threadRef: ScopedThreadRef) => void;
  onStartRename: (threadRef: ScopedThreadRef, title: string) => void;
  onRenameTitleChange: (title: string) => void;
  onCommitRename: (threadRef: ScopedThreadRef, title: string, originalTitle: string) => void;
  onCancelRename: () => void;
  isRenaming: boolean;
  renamingTitle: string;
  onContextMenu: (threadRef: ScopedThreadRef, position: { x: number; y: number }) => void;
  onPin: (threadRef: ScopedThreadRef) => void;
  onUnpin: (threadRef: ScopedThreadRef) => void;
  onArchive: (threadRef: ScopedThreadRef) => void;
  /**
   * External files dropped onto this row. The row highlights while the drag
   * is over it; the callback opens the thread and hands the files to its
   * composer.
   */
  onFileDropThreads: (threadRef: ScopedThreadRef, files: File[]) => void;
  /** Drag listeners for a reorderable pinned row. */
  dragListeners?: SortableNodeBag["listeners"] | undefined;
  isDragging?: boolean | undefined;
}) {
  const {
    isRenaming,
    onArchive,
    onCancelRename,
    onCommitRename,
    onContextMenu,
    onFileDropThreads,
    onPin,
    onRenameTitleChange,
    onStartRename,
    onThreadActivate,
    onThreadClick,
    onToggleChildren,
    onUnpin,
    openPullRequestsInRightPanel,
    renamingTitle,
    thread,
  } = props;
  void props.nowMinute;
  const threadRef = useMemo(
    () => scopeThreadRef(thread.environmentId, thread.id),
    [thread.environmentId, thread.id],
  );
  const threadKey = scopedThreadKey(threadRef);
  const isChild = props.depth > 0;
  const { leaseLiveStatus, rowRef } = useSidebarRowSubscriptionLease(props.isActive);
  const isRegeneratingTitle = thread.titleRegeneration != null;
  const lastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[threadKey]);
  const isSelected = useThreadSelectionStore((state) => state.selectedThreadKeys.has(threadKey));
  const openPrLink = useOpenPrLink();
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);
  const terminalProcessCount = runningTerminalIds.length;
  // Unsent composer text on this thread. The open thread shows its own
  // composer, so the marker only decorates rows you have navigated away from.
  const hasUnsentDraft = useThreadHasUnsentDraft(threadRef) && !props.isActive;
  const clearComposerContent = useComposerDraftStore((store) => store.clearComposerContent);
  const handleDiscardDraftClick = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      releaseComposerDraftUploads(threadRef);
      clearComposerContent(threadRef);
    },
    [clearComposerContent, threadRef],
  );

  const gitCwd = thread.worktreePath ?? props.project?.workspaceRoot ?? null;
  const linkedPullRequestStatus = useLinkedThreadPullRequest(
    thread.environmentId,
    thread.linkedPullRequest,
    leaseLiveStatus,
    thread.pullRequests,
    thread.branchPullRequest,
  );
  const gitStatus = useEnvironmentQuery(
    leaseLiveStatus && (thread.branch != null || thread.worktreePath !== null) && gitCwd !== null
      ? vcsEnvironment.status({
          environmentId: thread.environmentId,
          input: { cwd: gitCwd },
        })
      : null,
  );
  const visibleGitStatus = useRetainedValue(
    JSON.stringify([thread.environmentId, gitCwd]),
    gitStatus.data,
  );
  const pr = linkedPullRequestStatus?.pr ?? null;
  const supportsMultiplePullRequests = useSupportsMultiplePullRequests(thread.environmentId);
  const currentLinkedPr = supportsMultiplePullRequests
    ? resolveThreadCurrentPullRequestLink(thread.pullRequests)
    : null;

  // Never-visited counts as read, so switching sidebars does not light up
  // every historical thread as unread.
  const isUnread = hasUnseenCompletion({ ...thread, lastVisitedAt });
  const status = resolveSidebarThreadStatus(thread);
  const isRunning = thread.session?.status === "running" && thread.session.activeTurnId != null;

  const branchMismatch = resolveLocalCheckoutBranchMismatch({
    effectiveEnvMode: thread.worktreePath === null ? "local" : "worktree",
    activeWorktreePath: thread.worktreePath,
    activeThreadBranch: thread.branch,
    currentGitBranch: visibleGitStatus?.refName ?? null,
  });
  const prStatus = prStatusIndicator(pr, linkedPullRequestStatus?.sourceControlProvider);

  const modelInstanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
  const providerEntry = props.providerEntryByInstanceId.get(modelInstanceId) ?? null;
  const driverKind = providerEntry?.driverKind ?? null;
  const showInstanceBadge =
    providerEntry !== null &&
    shouldShowInstanceBadge(providerEntry, props.providerEntryByInstanceId.values());
  const selectedModel = providerEntry?.models.find(
    (model) => model.slug === thread.modelSelection.model,
  );
  const modelLabel = selectedModel
    ? getTriggerDisplayModelLabel(selectedModel)
    : thread.modelSelection.model;

  // The local environment is "this machine" and needs no marker; every other
  // one gets its machine glyph.
  const isRemote = thread.environmentId !== props.currentEnvironmentId;

  const handleClick = useCallback(
    (event: ReactMouseEvent) => {
      onThreadClick(event, threadRef);
    },
    [onThreadClick, threadRef],
  );
  const handleContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      onContextMenu(threadRef, { x: event.clientX, y: event.clientY });
    },
    [onContextMenu, threadRef],
  );
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === "ArrowRight" && props.descendantCount > 0 && !props.childrenExpanded) {
        event.preventDefault();
        onToggleChildren(threadKey);
        return;
      }
      if (event.key === "ArrowLeft" && props.descendantCount > 0 && props.childrenExpanded) {
        event.preventDefault();
        onToggleChildren(threadKey);
        return;
      }
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      onThreadActivate(threadRef);
    },
    [
      onThreadActivate,
      onToggleChildren,
      props.childrenExpanded,
      props.descendantCount,
      threadKey,
      threadRef,
    ],
  );
  const handleDoubleClick = useCallback(
    (event: ReactMouseEvent) => {
      if (isRenaming || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      if ((event.target as HTMLElement).closest("button, a, input")) return;
      event.preventDefault();
      onStartRename(threadRef, thread.title);
    },
    [isRenaming, onStartRename, thread.title, threadRef],
  );
  const handleToggleChildrenClick = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onToggleChildren(threadKey);
    },
    [onToggleChildren, threadKey],
  );
  const handlePinClick = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      (props.isPinned ? onUnpin : onPin)(threadRef);
    },
    [onPin, onUnpin, props.isPinned, threadRef],
  );
  const handleArchiveClick = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onArchive(threadRef);
    },
    [onArchive, threadRef],
  );
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const fileDropHandlers = useMemo(
    () =>
      makeWorkspaceFileDropHandlers({
        setDragActive: setIsFileDragOver,
        addFiles: (files) => {
          onFileDropThreads(threadRef, files);
        },
        addFolders: () => {},
      }),
    [onFileDropThreads, threadRef],
  );
  // A drop lands on a child or outside the window entirely, so dragend is
  // the reset of last resort for the row's highlight.
  useEffect(() => {
    if (!isFileDragOver) return;
    const clearFileDrag = () => setIsFileDragOver(false);
    window.addEventListener("dragend", clearFileDrag);
    return () => window.removeEventListener("dragend", clearFileDrag);
  }, [isFileDragOver]);
  const renameCommittedRef = useRef(false);
  useEffect(() => {
    if (isRenaming) renameCommittedRef.current = false;
  }, [isRenaming]);
  const handleRenameKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      event.stopPropagation();
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter") {
        event.preventDefault();
        renameCommittedRef.current = true;
        onCommitRename(threadRef, renamingTitle, thread.title);
      } else if (event.key === "Escape") {
        event.preventDefault();
        renameCommittedRef.current = true;
        onCancelRename();
      }
    },
    [onCancelRename, onCommitRename, renamingTitle, thread.title, threadRef],
  );
  const handleRenameBlur = useCallback(() => {
    if (!renameCommittedRef.current) {
      onCommitRename(threadRef, renamingTitle, thread.title);
    }
  }, [onCommitRename, renamingTitle, thread.title, threadRef]);
  const handlePrClick = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      const url = pr?.url ?? currentLinkedPr?.url;
      if (!url) return;
      const openedInRightPanel = openPrLink(
        event,
        url,
        openPullRequestsInRightPanel ? threadRef : undefined,
      );
      if (openedInRightPanel && openPullRequestsInRightPanel && !props.isActive) {
        onThreadActivate(threadRef);
      }
    },
    [
      onThreadActivate,
      openPrLink,
      openPullRequestsInRightPanel,
      pr,
      currentLinkedPr,
      props.isActive,
      threadRef,
    ],
  );
  const prBadgeShape = supportsMultiplePullRequests
    ? resolveThreadPullRequestBadge(thread.pullRequests)
    : null;
  const handlePrStackClick = useCallback(() => {
    useRightPanelStore.getState().open(threadRef, "pull-requests");
    if (!props.isActive) onThreadActivate(threadRef);
  }, [onThreadActivate, props.isActive, threadRef]);

  const prBadge =
    !isChild && (prBadgeShape?.kind === "stack" || pr || currentLinkedPr) ? (
      <ThreadPullRequestBadgeControl
        render={<InlineButton />}
        badge={prBadgeShape}
        number={pr?.number ?? currentLinkedPr?.number}
        url={pr?.url ?? currentLinkedPr?.url}
        status={prStatus}
        onOpenStack={handlePrStackClick}
        onOpenPullRequest={handlePrClick}
      />
    ) : null;
  const terminalStatusIcon = terminalStatus ? (
    <span
      role="img"
      aria-label={terminalProcessLabel(terminalProcessCount)}
      data-testid={`sidebar-terminal-status-${thread.id}`}
      className={cn("inline-flex shrink-0 items-center justify-center", terminalStatus.colorClass)}
    >
      <TerminalIcon
        className={cn("size-3", terminalStatus.pulse && "motion-safe:animate-status-pulse")}
        onAnimationStart={synchronizeTerminalPulse}
      />
    </span>
  ) : null;

  // Leading badge, one glyph by priority: needs-you (approval or input) >
  // working spinner > failure > pin > background monitoring > provider.
  const iconClassName = isChild ? "size-3" : "size-3.5";
  const leadingBadge =
    status === "approval" || status === "input" ? (
      <HandIcon
        role="img"
        aria-label={status === "approval" ? "Needs approval" : "Needs input"}
        className={cn(iconClassName, "text-warning")}
      />
    ) : status === "working" ? (
      <Spinner size={isChild ? "xs" : "sm"} tone="muted" aria-label="Working" />
    ) : status === "failed" ? (
      <CircleAlertIcon
        role="img"
        aria-label="Failed"
        className={cn(iconClassName, "text-destructive-foreground")}
      />
    ) : props.isPinned && !isChild ? (
      <PinIcon
        role="img"
        aria-label="Pinned"
        className={cn(iconClassName, "text-sidebar-muted-foreground")}
      />
    ) : status === "monitoring" ? (
      <EyeIcon
        role="img"
        aria-label="Monitoring"
        className={cn(iconClassName, "text-sidebar-muted-foreground")}
      />
    ) : driverKind ? (
      <ProviderInstanceIcon
        driverKind={driverKind}
        displayName={providerEntry?.displayName ?? thread.session?.providerName ?? modelInstanceId}
        accentColor={providerEntry?.accentColor}
        showBadge={showInstanceBadge}
        iconClassName={cn(iconClassName, "opacity-70")}
        badgeClassName="right-[-0.1875rem] bottom-[-0.1875rem] h-2.5 min-w-2.5 px-0.5 text-5xs"
      />
    ) : (
      <MessageSquareIcon
        aria-hidden
        className={cn(iconClassName, "text-sidebar-muted-foreground")}
      />
    );

  const title = isRenaming ? (
    <input
      autoFocus
      value={renamingTitle}
      aria-label="Thread title"
      onChange={(event) => onRenameTitleChange(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={handleRenameKeyDown}
      onBlur={handleRenameBlur}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      className="min-w-0 flex-1 rounded-sm border border-input bg-card px-1 text-row text-card-foreground outline-none focus:border-foreground"
    />
  ) : (
    <span
      className={cn(
        "min-w-0 flex-1 truncate",
        props.isActive || isUnread || status === "input" || status === "approval"
          ? "text-sidebar-foreground"
          : "text-sidebar-foreground/80",
        (props.isActive || isUnread) && "font-medium",
        isRegeneratingTitle && "opacity-55",
      )}
    >
      {thread.title}
    </span>
  );

  const draftIndicator = hasUnsentDraft ? (
    <SquarePenIcon
      role="img"
      aria-label="Unsent draft"
      data-testid={`sidebar-draft-indicator-${thread.id}`}
      className={draftPenClassName}
    />
  ) : null;

  const rowStyle: CSSProperties | undefined = isChild
    ? { paddingLeft: ROW_INSET_PX + props.depth * ICON_SLOT_PX }
    : undefined;

  return (
    <Tooltip disabled={props.isDragging === true}>
      <TooltipTrigger
        render={
          <div
            ref={rowRef}
            role="button"
            tabIndex={0}
            data-thread-item
            data-testid={isChild ? "sidebar-row-child" : "sidebar-row"}
            aria-current={props.isActive ? "page" : undefined}
            aria-expanded={props.descendantCount > 0 ? props.childrenExpanded : undefined}
            aria-busy={isRegeneratingTitle || undefined}
            style={rowStyle}
            className={cn(
              rowSurfaceBaseClassName,
              isChild ? "h-6 text-xs" : "h-7 pl-2",
              props.isActive
                ? "bg-sidebar-foreground/12 text-sidebar-foreground"
                : isSelected
                  ? "bg-sidebar-foreground/10 text-sidebar-foreground"
                  : hasUnsentDraft
                    ? cn(draftSurfaceClassName, "text-sidebar-foreground")
                    : "text-sidebar-foreground hover:bg-sidebar-foreground/6",
              isFileDragOver && "ring-1 ring-inset ring-primary/70",
              props.isDragging && "bg-sidebar shadow-lg ring-1 ring-sidebar-border",
            )}
            onClick={handleClick}
            onDoubleClick={handleDoubleClick}
            onKeyDown={handleKeyDown}
            onContextMenu={handleContextMenu}
            {...fileDropHandlers}
            {...(props.dragListeners ?? {})}
          />
        }
      >
        {isChild ? (
          <ChildAgentConnectors
            depth={props.depth}
            isLastSibling={props.isLastSibling}
            guides={props.guides}
          />
        ) : null}
        <span className="relative flex size-5 shrink-0 items-center justify-center">
          {leadingBadge}
        </span>
        {title}
        {draftIndicator}
        {isRegeneratingTitle ? (
          <span role="status" className="sr-only">
            Regenerating title
          </span>
        ) : null}
        {props.descendantCount > 0 ? (
          <button
            type="button"
            aria-label={props.childrenExpanded ? "Collapse child agents" : "Expand child agents"}
            onClick={handleToggleChildrenClick}
            onDoubleClick={(event) => event.stopPropagation()}
            className="inline-flex h-5 shrink-0 cursor-pointer items-center gap-0.5 rounded-sm px-0.5 text-2xs text-sidebar-muted-foreground hover:text-sidebar-foreground"
          >
            {props.childrenExpanded ? null : (
              <span className="tabular-nums">
                {props.descendantCount} {props.descendantCount === 1 ? "agent" : "agents"}
              </span>
            )}
            <ChevronRightIcon
              aria-hidden
              className={cn("size-3 transition-transform", props.childrenExpanded && "rotate-90")}
            />
          </button>
        ) : null}
        {terminalStatusIcon}
        {prBadge}
        {/* Resting state (unread dot, machine, time) yields to the row actions
            on hover or keyboard focus inside the row. */}
        <span className="flex shrink-0 items-center gap-1.5 group-hover/sidebar-row:hidden group-focus-visible/sidebar-row:hidden group-has-[:focus-visible]/sidebar-row:hidden">
          {isUnread ? (
            <span
              role="img"
              aria-label="Unread"
              className="size-[7px] shrink-0 rounded-full bg-primary"
            />
          ) : null}
          {isRemote ? (
            <EnvironmentMachineIcon
              aria-hidden
              kind={props.environmentMachine}
              className="size-3 text-sidebar-muted-foreground"
            />
          ) : null}
          {isChild ? null : (
            <span className="text-2xs text-sidebar-muted-foreground tabular-nums">
              {threadTimeLabel(thread)}
            </span>
          )}
        </span>
        <span className="hidden shrink-0 items-center gap-0.5 group-hover/sidebar-row:flex group-focus-visible/sidebar-row:flex group-has-[:focus-visible]/sidebar-row:flex">
          {hasUnsentDraft ? (
            <SidebarRowAction label="Discard draft" onClick={handleDiscardDraftClick}>
              <XIcon className="size-3" />
            </SidebarRowAction>
          ) : null}
          {props.pinningSupported && !isChild ? (
            <SidebarRowAction
              label={props.isPinned ? "Unpin thread" : "Pin thread"}
              onClick={handlePinClick}
            >
              {props.isPinned ? <PinOffIcon className="size-3" /> : <PinIcon className="size-3" />}
            </SidebarRowAction>
          ) : null}
          <SidebarRowAction
            label="Archive thread"
            disabled={isRunning}
            onClick={handleArchiveClick}
          >
            <ArchiveIcon className="size-3" />
          </SidebarRowAction>
        </span>
        {props.jumpLabel ? <JumpHintBadge label={props.jumpLabel} /> : null}
      </TooltipTrigger>
      <SidebarThreadTooltip
        thread={thread}
        project={props.project}
        projectDisplayName={props.projectDisplayName}
        environmentLabel={props.environmentLabel}
        environmentMachine={props.environmentMachine}
        providerEntry={providerEntry}
        showInstanceBadge={showInstanceBadge}
        modelInstanceId={modelInstanceId}
        modelLabel={modelLabel}
        branchMismatch={branchMismatch}
        terminalStatus={terminalStatus}
        terminalProcessCount={terminalProcessCount}
      />
    </Tooltip>
  );
});

/** Collapsible project header: folder, name, count while collapsed, hover actions. */
const SidebarProjectFolderRow = memo(function SidebarProjectFolderRow(props: {
  group: SidebarProjectSnapshot;
  expanded: boolean;
  threadCount: number;
  showEnvironment: boolean;
  primaryEnvironmentId: SidebarProjectSnapshot["environmentId"] | null;
  machineByEnvironmentId: ReadonlyMap<
    SidebarProjectSnapshot["environmentId"],
    EnvironmentMachineKind
  >;
  onToggle: (group: SidebarProjectSnapshot) => void;
  onNewThread: (group: SidebarProjectSnapshot) => void;
  onOpenMenu: (group: SidebarProjectSnapshot, position: { x: number; y: number }) => void;
}) {
  const { group, onNewThread, onOpenMenu, onToggle } = props;
  const handleToggle = useCallback(() => onToggle(group), [group, onToggle]);
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.target !== event.currentTarget) return;
      if (
        event.key === "Enter" ||
        event.key === " " ||
        (event.key === "ArrowRight" && !props.expanded) ||
        (event.key === "ArrowLeft" && props.expanded)
      ) {
        event.preventDefault();
        onToggle(group);
      }
    },
    [group, onToggle, props.expanded],
  );
  const handleContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      onOpenMenu(group, { x: event.clientX, y: event.clientY });
    },
    [group, onOpenMenu],
  );
  const handleNewThreadClick = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onNewThread(group);
    },
    [group, onNewThread],
  );
  const handleMenuClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const rect = event.currentTarget.getBoundingClientRect();
      onOpenMenu(group, { x: rect.left, y: rect.bottom + 4 });
    },
    [group, onOpenMenu],
  );
  const FolderGlyph = props.expanded ? FolderOpenIcon : FolderIcon;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={props.expanded}
      data-testid="sidebar-project-row"
      data-thread-selection-safe
      className={cn(
        rowSurfaceBaseClassName,
        "h-7 pl-2 font-medium text-sidebar-foreground/70 hover:bg-sidebar-foreground/6 hover:text-sidebar-foreground",
      )}
      onClick={handleToggle}
      onKeyDown={handleKeyDown}
      onContextMenu={handleContextMenu}
    >
      <span className="flex size-5 shrink-0 items-center justify-center">
        <FolderGlyph aria-hidden className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1 truncate">{group.displayName}</span>
      {props.showEnvironment ? (
        <ProjectEnvironmentBadge
          group={group}
          primaryEnvironmentId={props.primaryEnvironmentId}
          machineByEnvironmentId={props.machineByEnvironmentId}
        />
      ) : null}
      {!props.expanded && props.threadCount > 0 ? (
        <span className="shrink-0 text-2xs font-normal text-sidebar-muted-foreground tabular-nums group-hover/sidebar-row:hidden group-focus-visible/sidebar-row:hidden group-has-[:focus-visible]/sidebar-row:hidden">
          {props.threadCount}
        </span>
      ) : null}
      <span className="hidden shrink-0 items-center gap-0.5 group-hover/sidebar-row:flex group-focus-visible/sidebar-row:flex group-has-[:focus-visible]/sidebar-row:flex">
        <SidebarRowAction
          label={`New thread in ${group.displayName}`}
          tooltip="New thread"
          onClick={handleNewThreadClick}
        >
          <PlusIcon className="size-3.5" />
        </SidebarRowAction>
        <SidebarRowAction
          label={`${group.displayName} actions`}
          tooltip="More actions"
          onClick={handleMenuClick}
        >
          <EllipsisIcon className="size-3.5" />
        </SidebarRowAction>
      </span>
    </div>
  );
});

const SidebarSearchResultRow = memo(function SidebarSearchResultRow(props: {
  thread: SidebarThreadSummary;
  project: EnvironmentProject | null;
  projectDisplayName: string | null;
  environmentLabel: string | null;
  environmentMachine: EnvironmentMachineKind;
  providerEntryByInstanceId: ReadonlyMap<string, ProviderInstanceEntry>;
  isHighlighted: boolean;
  isRouteActive: boolean;
  resultId: string;
  searchMatch: EnvironmentThreadSearchMatch | null;
  searchQuery: string;
  onHighlight: () => void;
  onSelect: () => void;
  onFileDropThreads: (threadRef: ScopedThreadRef, files: File[]) => void;
}) {
  const { thread } = props;
  const threadRef = useMemo(
    () => scopeThreadRef(thread.environmentId, thread.id),
    [thread.environmentId, thread.id],
  );
  const { leaseLiveStatus, rowRef } = useSidebarRowSubscriptionLease(
    props.isHighlighted || props.isRouteActive,
  );
  // Same details tooltip as the regular rows: a search hit is still a thread,
  // and the hover card is how you disambiguate identically-titled results.
  const gitCwd = thread.worktreePath ?? props.project?.workspaceRoot ?? null;
  const gitStatus = useEnvironmentQuery(
    leaseLiveStatus && (thread.branch != null || thread.worktreePath !== null) && gitCwd !== null
      ? vcsEnvironment.status({
          environmentId: thread.environmentId,
          input: { cwd: gitCwd },
        })
      : null,
  );
  const visibleGitStatus = useRetainedValue(
    JSON.stringify([thread.environmentId, gitCwd]),
    gitStatus.data,
  );
  const branchMismatch = resolveLocalCheckoutBranchMismatch({
    effectiveEnvMode: thread.worktreePath === null ? "local" : "worktree",
    activeWorktreePath: thread.worktreePath,
    activeThreadBranch: thread.branch,
    currentGitBranch: visibleGitStatus?.refName ?? null,
  });
  const modelInstanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
  const providerEntry = props.providerEntryByInstanceId.get(modelInstanceId) ?? null;
  const showInstanceBadge =
    providerEntry !== null &&
    shouldShowInstanceBadge(providerEntry, props.providerEntryByInstanceId.values());
  const selectedModel = providerEntry?.models.find(
    (model) => model.slug === thread.modelSelection.model,
  );
  const modelLabel = selectedModel
    ? getTriggerDisplayModelLabel(selectedModel)
    : thread.modelSelection.model;
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const fileDropHandlers = useMemo(
    () =>
      makeWorkspaceFileDropHandlers({
        setDragActive: setIsFileDragOver,
        addFiles: (files) => {
          props.onFileDropThreads(threadRef, files);
        },
        addFolders: () => {},
      }),
    [props.onFileDropThreads, threadRef],
  );
  useEffect(() => {
    if (!isFileDragOver) return;
    const clearFileDrag = () => setIsFileDragOver(false);
    window.addEventListener("dragend", clearFileDrag);
    return () => window.removeEventListener("dragend", clearFileDrag);
  }, [isFileDragOver]);
  return (
    <li role="presentation" className="list-none" {...fileDropHandlers}>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              ref={rowRef}
              id={props.resultId}
              type="button"
              role="option"
              // aria-activedescendant options: focus stays on the search input,
              // which owns all keyboard interaction for the listbox.
              tabIndex={-1}
              aria-selected={props.isHighlighted}
              aria-current={props.isRouteActive ? "page" : undefined}
              aria-label={
                props.projectDisplayName
                  ? `${thread.title}, ${props.projectDisplayName}`
                  : thread.title
              }
              onMouseMove={props.onHighlight}
              onClick={props.onSelect}
              className={cn(
                "flex min-h-7 w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-left text-row outline-none",
                props.isHighlighted || props.isRouteActive
                  ? "bg-sidebar-foreground/12 text-sidebar-foreground"
                  : "text-sidebar-foreground/80 hover:bg-sidebar-foreground/6 hover:text-sidebar-foreground",
                isFileDragOver && "ring-1 ring-inset ring-primary/70",
              )}
            />
          }
        >
          <span className="flex size-5 shrink-0 items-center justify-center self-start">
            {props.project ? (
              <ProjectFavicon project={props.project} className="size-3.5" />
            ) : (
              <MessageSquareIcon aria-hidden className="size-3.5 text-sidebar-muted-foreground" />
            )}
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate">{thread.title}</span>
              <span className="shrink-0 text-2xs text-sidebar-muted-foreground tabular-nums">
                {threadTimeLabel(thread)}
              </span>
            </span>
            {props.searchMatch ? (
              <ThreadSearchMatchExcerpt
                match={{
                  source: props.searchMatch.source,
                  snippet: props.searchMatch.snippet,
                  query: props.searchQuery,
                }}
              />
            ) : null}
          </span>
        </TooltipTrigger>
        <SidebarThreadTooltip
          thread={thread}
          project={props.project}
          projectDisplayName={props.projectDisplayName}
          environmentLabel={props.environmentLabel}
          environmentMachine={props.environmentMachine}
          providerEntry={providerEntry}
          showInstanceBadge={showInstanceBadge}
          modelInstanceId={modelInstanceId}
          modelLabel={modelLabel}
          branchMismatch={branchMismatch}
          terminalStatus={terminalStatus}
          terminalProcessCount={runningTerminalIds.length}
        />
      </Tooltip>
    </li>
  );
});

type ProjectMenuAction =
  | "new-thread"
  | "copy-path"
  | "import-sessions"
  | "remove-imported-sessions"
  | "project-settings";

export default function Sidebar() {
  const projects = useProjects();
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const threads = useThreadShells();
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const confirmThreadDelete = useClientSettings((s) => s.confirmThreadDelete);
  const confirmThreadArchive = useClientSettings((s) => s.confirmThreadArchive);
  const sidebarProjectSortOrder = useClientSettings((s) => s.sidebarProjectSortOrder);
  const sidebarThreadSortOrder = useClientSettings((s) => s.sidebarThreadSortOrder);
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const { pinThread, confirmAndUnpinThread, reorderPinnedThread, archiveThread, deleteThread } =
    useThreadActions();
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: ({ path }) => {
      toastManager.add({
        type: "success",
        title: "Path copied",
        description: path,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy path",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
  const { copyToClipboard: copyBranchToClipboard } = useCopyToClipboard<{ branch: string }>({
    target: "branch name",
    onCopy: ({ branch }) => {
      toastManager.add({
        type: "success",
        title: "Branch copied",
        description: branch,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy branch",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{ threadId: ThreadId }>({
    onCopy: ({ threadId }) => {
      toastManager.add({
        type: "success",
        title: "Thread ID copied",
        description: threadId,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy thread ID",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
  const newThreadContext = useHandleNewThread();
  const openAddProjectCommandPalette = useCallback(
    () => openCommandPalette({ open: "add-project" }),
    [],
  );
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);
  const toggleThreadSelection = useThreadSelectionStore((s) => s.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((s) => s.rangeSelectTo);
  const removeFromSelection = useThreadSelectionStore((s) => s.removeFromSelection);
  const markThreadUnread = useUiStateStore((s) => s.markThreadUnread);
  const projectExpandedById = useUiStateStore((store) => store.projectExpandedById);
  const setProjectExpanded = useUiStateStore((store) => store.setProjectExpanded);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeDraftThread = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );
  const routeThreadRef = useMemo(
    () => resolveActiveThreadRouteRef(routeTarget, routeDraftThread),
    [routeDraftThread, routeTarget],
  );
  const routeThreadKey = routeThreadRef ? scopedThreadKey(routeThreadRef) : null;

  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  const environmentMachineById = useMemo(
    () =>
      new Map(
        environments.map(
          (environment) =>
            [
              environment.environmentId,
              resolveEnvironmentMachineKind(environment.serverConfig),
            ] as const,
        ),
      ),
    [environments],
  );
  const orderedProjects = useMemo(
    () =>
      orderItemsByPreferredIds({
        items: projects,
        preferredIds: projectOrder,
        getId: getProjectOrderKey,
        getPreferenceIds: (project) => [
          getProjectOrderKey(project),
          legacyProjectCwdPreferenceKey(project.workspaceRoot),
        ],
      }),
    [projectOrder, projects],
  );
  const unsortedProjectGroups = useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects: sidebarProjectSortOrder === "manual" ? orderedProjects : projects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: (environmentId) => environmentLabelById.get(environmentId) ?? null,
      }),
    [
      environmentLabelById,
      orderedProjects,
      primaryEnvironmentId,
      projectGroupingSettings,
      projects,
      sidebarProjectSortOrder,
    ],
  );
  const projectGroups = useMemo(
    () => sortLogicalProjectsForSidebar(unsortedProjectGroups, threads, sidebarProjectSortOrder),
    [sidebarProjectSortOrder, threads, unsortedProjectGroups],
  );
  const projectGroupsRef = useRef(projectGroups);
  projectGroupsRef.current = projectGroups;
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  // Threads on non-primary environments (T3 Connect, hosted) resolve their
  // provider entry from their own environment's config: default instance ids
  // are driver slugs, so a flat map would collide across environments.
  const providerEntriesByEnvironment = useMemo(
    () =>
      deriveProviderEntriesByEnvironment(
        [...serverConfigs].map(
          ([environmentId, config]) => [environmentId, config.providers] as const,
        ),
      ),
    [serverConfigs],
  );
  // Rows read the project record for its icon and cwd. Group labels can include
  // a repository owner or a different title, so they travel separately.
  const projectByKey = useMemo(
    () => new Map(projects.map((project) => [`${project.environmentId}:${project.id}`, project])),
    [projects],
  );
  const projectDisplayNameByKey = useMemo(
    () =>
      new Map(
        projectGroups.flatMap((group) =>
          group.memberProjects.map(
            (project) => [`${project.environmentId}:${project.id}`, group.displayName] as const,
          ),
        ),
      ),
    [projectGroups],
  );
  // Physical project (environment + id) to the logical folder it renders in.
  const folderKeyByPhysicalProjectKey = useMemo(
    () =>
      new Map(
        projectGroups.flatMap((group) =>
          group.memberProjectRefs.map(
            (projectRef) =>
              [`${projectRef.environmentId}:${projectRef.projectId}`, group.projectKey] as const,
          ),
        ),
      ),
    [projectGroups],
  );

  const nowMinute = useNowMinute();

  // Project scope: one menu above the list narrows the tree to one folder.
  // The selection lives in the persisted UI store, so routes that unmount the
  // sidebar (Settings) and app restarts keep it.
  const projectScopeKey = useUiStateStore((store) => store.sidebarProjectScopeKey);
  const setProjectScopeKey = useUiStateStore((store) => store.setSidebarProjectScopeKey);
  // {value, label} items let Base UI drive the combobox selection contract
  // while the popup search filters the same collection.
  const projectScopeItems = useMemo(
    () => [
      { value: "all", label: "All projects" },
      ...projectGroups.map((project) => ({
        value: project.projectKey,
        label: project.displayName,
      })),
    ],
    [projectGroups],
  );
  // Same-named projects on two machines are only told apart by where they
  // live, so folders on another machine carry its icon once the catalog spans
  // more than one environment.
  const showProjectEnvironments = useMemo(
    () => projectGroupsSpanEnvironments(projectGroups),
    [projectGroups],
  );
  const projectGroupByScopeKey = useMemo(
    () => new Map(projectGroups.map((project) => [project.projectKey, project] as const)),
    [projectGroups],
  );
  const selectedProjectScopeItem = useMemo(
    () =>
      projectScopeItems.find((item) => item.value === (projectScopeKey ?? "all")) ??
      projectScopeItems[0]!,
    [projectScopeItems, projectScopeKey],
  );
  const [projectScopeMenuState, dispatchProjectScopeMenu] = useReducer(
    reduceSidebarProjectScopeMenuState,
    { open: false, query: "" },
  );
  const projectScopeFilter = useComboboxFilter();
  // "All projects" heads the list while the query is empty and drops out
  // while filtering, so it can't outrank a project match under autoHighlight.
  const filteredProjectScopeItems = useMemo(
    () =>
      filterSidebarProjectScopeItems({
        items: projectScopeItems,
        query: projectScopeMenuState.query,
        matches: (item, query) =>
          projectScopeFilter.contains(item, query, (candidate) => candidate.label),
      }),
    [projectScopeFilter, projectScopeItems, projectScopeMenuState.query],
  );
  const scopedProjectGroup = useMemo(
    () =>
      projectScopeKey === null
        ? null
        : (projectGroups.find((project) => project.projectKey === projectScopeKey) ?? null),
    [projectGroups, projectScopeKey],
  );
  const scopedProjectKeys = useMemo(
    () =>
      scopedProjectGroup === null
        ? null
        : new Set(
            scopedProjectGroup.memberProjectRefs.map(
              (projectRef) => `${projectRef.environmentId}:${projectRef.projectId}`,
            ),
          ),
    [scopedProjectGroup],
  );
  // A persisted scope whose project is gone falls back to all projects, but
  // only after every catalog environment has a live project snapshot.
  const allProjectSnapshotsReady = useAllEnvironmentProjectSnapshotsReady();
  useEffect(() => {
    if (projectScopeKey !== null && allProjectSnapshotsReady && scopedProjectGroup === null) {
      setProjectScopeKey(null);
    }
  }, [allProjectSnapshotsReady, projectScopeKey, scopedProjectGroup, setProjectScopeKey]);
  // Count-only subscription: the parent needs "are there draft rows" for the
  // empty state, while SidebarDraftBlock owns the per-keystroke content
  // subscription.
  const routeDraftIdForRows = routeTarget?.kind === "draft" ? routeTarget.draftId : null;
  const visibleDraftSessionCount = useComposerDraftStore((store) => {
    let count = 0;
    for (const [draftKey, session] of Object.entries(store.draftThreadsByThreadKey)) {
      if (session.promotedTo != null) {
        continue;
      }
      if (!composerDraftHasUserContent(store.draftsByThreadKey[draftKey])) {
        continue;
      }
      if (
        scopedProjectKeys !== null &&
        !scopedProjectKeys.has(`${session.environmentId}:${session.projectId}`)
      ) {
        continue;
      }
      count += 1;
    }
    return count;
  });
  // Scope flips drop the selection: rows selected under the old scope may be
  // hidden now, and bulk actions must never count or touch invisible rows.
  useEffect(() => {
    clearSelection();
  }, [clearSelection, projectScopeKey]);

  const openProjectSettings = useCallback(
    (projectGroup: SidebarProjectSnapshot) => {
      if (isMobile) {
        setOpenMobile(false);
      }
      void router.navigate({
        to: "/projects/$projectKey",
        params: { projectKey: projectGroup.projectKey },
      });
    },
    [isMobile, router, setOpenMobile],
  );
  // Anchor for the scope popup: the header search field, not its icon trigger.
  const headerSearchRef = useRef<HTMLDivElement | null>(null);
  // Safari can send a click after Ctrl+click opens settings. Ignore that one
  // selection, then clear the guard when the picker opens again.
  const suppressNextScopeChangeRef = useRef(false);
  const highlightedProjectScopeKeyRef = useRef<string | null>(null);
  const handleProjectSettings = useCallback(
    (
      event: ReactMouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLInputElement>,
      projectGroup: SidebarProjectSnapshot,
    ) => {
      event.preventDefault();
      event.stopPropagation();
      suppressNextScopeChangeRef.current = true;
      dispatchProjectScopeMenu({ type: "project-settings-opened" });
      openProjectSettings(projectGroup);
    },
    [openProjectSettings],
  );

  // Every live thread in scope. Settled and snoozed threads are ordinary rows
  // here: the sidebar does not surface those lifecycles.
  const visibleThreads = useMemo(
    () =>
      threads.filter(
        (thread) =>
          thread.archivedAt === null &&
          (scopedProjectKeys === null || scopedProjectKeys.has(physicalProjectKeyOf(thread))),
      ),
    [scopedProjectKeys, threads],
  );
  const pinReorderableThreadKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const thread of visibleThreads) {
      const capabilities = serverConfigs.get(thread.environmentId)?.environment.capabilities;
      if (capabilities?.threadPinning === true && capabilities.threadPinReorder === true) {
        keys.add(threadKeyOf(thread));
      }
    }
    return keys;
  }, [serverConfigs, visibleThreads]);

  // A dropped pinned row stays at its destination until every order-key write
  // lands (or one fails), so the list never snaps back mid-write.
  const [optimisticPinnedOrder, setOptimisticPinnedOrder] = useState<{
    readonly order: readonly string[];
    readonly assignedKeys: ReadonlyMap<string, string>;
  } | null>(null);

  const tree = useMemo(
    () =>
      buildSidebarThreadTree({
        projects: scopedProjectGroup ? [scopedProjectGroup] : projectGroups,
        threads: visibleThreads,
        projectKeyOf: (group) => group.projectKey,
        threadKeyOf,
        parentKeyOf: (thread) =>
          thread.parentThreadId
            ? scopedThreadKey(scopeThreadRef(thread.environmentId, thread.parentThreadId))
            : null,
        folderKeyOf: (thread) =>
          folderKeyByPhysicalProjectKey.get(physicalProjectKeyOf(thread)) ?? "",
        isPinned: (thread) => thread.pinnedAt != null,
        sortPinned: (pinned) => {
          const sorted = sortPinnedThreadsForSidebar(pinned);
          return optimisticPinnedOrder === null
            ? sorted
            : orderItemsByPreferredIds({
                items: sorted,
                preferredIds: optimisticPinnedOrder.order,
                getId: threadKeyOf,
              });
        },
        sortRoots: (roots) => sortThreads(roots, sidebarThreadSortOrder),
        sortChildren: sortChildThreads,
      }),
    [
      folderKeyByPhysicalProjectKey,
      optimisticPinnedOrder,
      projectGroups,
      scopedProjectGroup,
      sidebarThreadSortOrder,
      visibleThreads,
    ],
  );

  // Folder expansion persists with the other project preferences; child-agent
  // disclosure is session-local and open by default.
  const folderExpandedByKey = useMemo(
    () =>
      new Map(
        tree.folders.map(
          (folder) =>
            [
              folder.key,
              resolveProjectExpanded(
                projectExpandedById,
                projectExpansionPreferenceKeys(folder.project),
              ),
            ] as const,
        ),
      ),
    [projectExpandedById, tree.folders],
  );
  const [collapsedThreadKeys, setCollapsedThreadKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const isThreadExpanded = useCallback(
    (threadKey: string) => !collapsedThreadKeys.has(threadKey),
    [collapsedThreadKeys],
  );
  const toggleThreadChildren = useCallback((threadKey: string) => {
    setCollapsedThreadKeys((current) => {
      const next = new Set(current);
      if (!next.delete(threadKey)) next.add(threadKey);
      return next;
    });
  }, []);
  const toggleProjectFolder = useCallback(
    (group: SidebarProjectSnapshot) => {
      const keys = projectExpansionPreferenceKeys(group);
      setProjectExpanded(
        keys,
        !resolveProjectExpanded(useUiStateStore.getState().projectExpandedById, keys),
      );
    },
    [setProjectExpanded],
  );

  const threadByKey = useMemo(
    () => new Map(visibleThreads.map((thread) => [threadKeyOf(thread), thread] as const)),
    [visibleThreads],
  );
  // Handlers read these through refs: depending on per-update Map identities
  // would give every row a fresh callback prop on each shell event and defeat
  // row memoization during streaming.
  const threadByKeyRef = useRef(threadByKey);
  threadByKeyRef.current = threadByKey;

  // Opening a thread reveals it once: its folder and any collapsed parent
  // agents open, after which the user is free to collapse them again.
  const revealedRouteThreadKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (routeThreadKey === null || revealedRouteThreadKeyRef.current === routeThreadKey) return;
    if (!threadByKey.has(routeThreadKey)) return;
    revealedRouteThreadKeyRef.current = routeThreadKey;
    const ancestors = sidebarThreadAncestorKeys(tree, routeThreadKey);
    if (ancestors.some((key) => collapsedThreadKeys.has(key))) {
      setCollapsedThreadKeys((current) => {
        const next = new Set(current);
        for (const key of ancestors) next.delete(key);
        return next;
      });
    }
    const folderKey = tree.folderKeyByThreadKey.get(routeThreadKey);
    const folder = folderKey === undefined ? undefined : projectGroupByScopeKey.get(folderKey);
    if (folder && folderExpandedByKey.get(folder.projectKey) === false) {
      setProjectExpanded(projectExpansionPreferenceKeys(folder), true);
    }
  }, [
    collapsedThreadKeys,
    folderExpandedByKey,
    projectGroupByScopeKey,
    routeThreadKey,
    setProjectExpanded,
    threadByKey,
    tree,
  ]);

  const threadSearchInputRef = useRef<HTMLInputElement>(null);
  const [threadSearchQuery, setThreadSearchQuery] = useState("");
  const [activeSearchResultIndex, setActiveSearchResultIndex] = useState(0);
  const isSearchingThreads = threadSearchQuery.trim().length > 0;
  const searchEnvironmentIds = useMemo(
    () =>
      environments
        .filter((environment) => environment.connection.phase === "connected")
        .map((environment) => environment.environmentId),
    [environments],
  );
  // useThreadSearch owns the debounce and the two-character floor.
  const threadSearch = useThreadSearch(searchEnvironmentIds, threadSearchQuery);
  const threadSearchMatchByKey = useMemo(
    () =>
      new Map(threadSearch.matches.map((match) => [threadSearchMatchKey(match), match] as const)),
    [threadSearch.matches],
  );
  const threadSearchResults = useMemo(
    () =>
      searchSidebarThreads(
        visibleThreads,
        threadSearchQuery,
        new Set(threadSearchMatchByKey.keys()),
      ),
    [visibleThreads, threadSearchQuery, threadSearchMatchByKey],
  );
  const threadSearchResultOrderKey = threadSearchResults.map(threadKeyOf).join("\0");

  useEffect(() => {
    setActiveSearchResultIndex(0);
  }, [threadSearchResultOrderKey]);

  useEffect(() => {
    if (!isSearchingThreads) return;
    document
      .getElementById(`sidebar-thread-search-result-${activeSearchResultIndex}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeSearchResultIndex, isSearchingThreads, threadSearchResultOrderKey]);

  // Rendered rows top to bottom: keyboard traversal, jump shortcuts, and
  // shift-range selection all follow what the user sees.
  const orderedThreadKeys = useMemo(
    () =>
      collectVisibleSidebarThreadKeys(
        tree,
        (folderKey) => folderExpandedByKey.get(folderKey) ?? true,
        isThreadExpanded,
      ),
    [folderExpandedByKey, isThreadExpanded, tree],
  );
  const orderedThreadKeysRef = useRef(orderedThreadKeys);
  orderedThreadKeysRef.current = orderedThreadKeys;
  // handleNewThread is inherently unstable (depends on the projects list).
  const handleNewThreadRef = useRef(newThreadContext.handleNewThread);
  handleNewThreadRef.current = newThreadContext.handleNewThread;

  const jumpLabelByKey = useMemo(() => {
    const mapping = new Map<string, string>();
    for (const [index, threadKey] of orderedThreadKeys.entries()) {
      const jumpCommand = threadJumpCommandForIndex(index);
      if (!jumpCommand) break;
      const label = shortcutLabelForCommand(keybindings, jumpCommand);
      if (label) mapping.set(threadKey, label);
    }
    return mapping;
  }, [keybindings, orderedThreadKeys]);
  const { showThreadJumpHints, updateThreadJumpHintsVisibility } = useThreadJumpHintVisibility();

  const navigateToThread = useCallback(
    (threadRef: ScopedThreadRef) => {
      if (useThreadSelectionStore.getState().selectedThreadKeys.size > 0) {
        clearSelection();
      }
      setSelectionAnchor(scopedThreadKey(threadRef));
      if (isMobile) {
        setOpenMobile(false);
      }
      return router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [clearSelection, isMobile, router, setOpenMobile, setSelectionAnchor],
  );

  // Dropping files on a row opens that thread and attaches the files there.
  // The composer only accepts drops for its OWN thread, so when the row is
  // not the open thread we stash the files and let ChatView hand them over
  // once the navigation actually lands; if the route bounced (thread gone),
  // nothing will consume them, so clear instead of surprising the user later.
  const queuePendingFileDrop = useSidebarPendingFileDropStore((s) => s.queuePendingFileDrop);
  const clearPendingFileDrop = useSidebarPendingFileDropStore((s) => s.clearPendingFileDrop);
  const handleThreadFileDrop = useCallback(
    async (threadRef: ScopedThreadRef, files: File[]) => {
      const dropId = queuePendingFileDrop({ threadRef, files });
      // Key match alone is not "already there": during draft promotion the
      // resolved route key is the server thread while the URL is still the
      // draft route, and its composer would swallow the drop then discard it.
      const landedBefore =
        router.buildLocation({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
        }).pathname === router.state.location.pathname;
      if (landedBefore) return;
      try {
        await navigateToThread(threadRef);
        const landed =
          router.buildLocation({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(threadRef),
          }).pathname === router.state.location.pathname;
        if (!landed) {
          clearPendingFileDrop(dropId);
        }
      } catch {
        clearPendingFileDrop(dropId);
      }
    },
    [clearPendingFileDrop, navigateToThread, queuePendingFileDrop, router],
  );

  const navigateToDraft = useCallback(
    (draftId: DraftId) => {
      // Unconditional: also drops a stale selection anchor left by plain-click
      // navigation, so a later shift-click starts fresh.
      clearSelection();
      if (isMobile) {
        setOpenMobile(false);
      }
      void router.navigate({ to: "/draft/$draftId", params: { draftId } });
    },
    [clearSelection, isMobile, router, setOpenMobile],
  );

  const clearThreadSearch = useCallback(() => {
    setThreadSearchQuery("");
    setActiveSearchResultIndex(0);
  }, []);
  const selectThreadSearchResult = useCallback(
    (thread: EnvironmentThreadShell) => {
      clearThreadSearch();
      navigateToThread(scopeThreadRef(thread.environmentId, thread.id));
    },
    [clearThreadSearch, navigateToThread],
  );
  const handleThreadSearchKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      // IME composition uses the same keys; committing a candidate must not
      // move the highlight or navigate away mid-compose.
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape" && isSearchingThreads) {
        event.preventDefault();
        event.stopPropagation();
        clearThreadSearch();
        return;
      }
      if (threadSearchResults.length === 0) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveSearchResultIndex((index) => (index + 1) % threadSearchResults.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveSearchResultIndex(
          (index) => (index - 1 + threadSearchResults.length) % threadSearchResults.length,
        );
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const result = threadSearchResults[activeSearchResultIndex];
        if (result) selectThreadSearchResult(result);
      }
    },
    [
      activeSearchResultIndex,
      clearThreadSearch,
      isSearchingThreads,
      selectThreadSearchResult,
      threadSearchResults,
    ],
  );

  const [renamingThreadKey, setRenamingThreadKey] = useState<string | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const startThreadRename = useCallback((threadRef: ScopedThreadRef, title: string) => {
    setRenamingThreadKey(scopedThreadKey(threadRef));
    setRenamingTitle(title);
  }, []);
  const cancelThreadRename = useCallback(() => setRenamingThreadKey(null), []);
  const commitThreadRename = useCallback(
    (threadRef: ScopedThreadRef, title: string, originalTitle: string) => {
      void (async () => {
        const trimmed = title.trim();
        setRenamingThreadKey(null);
        if (trimmed.length === 0) {
          toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
          return;
        }
        if (trimmed === originalTitle) return;
        const result = await updateThreadMetadata({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, title: trimmed },
        });
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to rename thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      })();
    },
    [updateThreadMetadata],
  );

  const handleThreadClick = useCallback(
    (event: ReactMouseEvent, threadRef: ScopedThreadRef) => {
      if (isSidebarNestedLinkClick(event.target)) return;
      const isMac = isMacPlatform(navigator.platform);
      const isModClick = isMac ? event.metaKey : event.ctrlKey;
      const threadKey = scopedThreadKey(threadRef);
      if (isModClick) {
        event.preventDefault();
        toggleThreadSelection(threadKey);
        return;
      }
      if (event.shiftKey) {
        event.preventDefault();
        rangeSelectTo(threadKey, orderedThreadKeysRef.current);
        return;
      }
      if (isTrailingDoubleClick(event.detail)) {
        return;
      }
      navigateToThread(threadRef);
    },
    [navigateToThread, rangeSelectTo, toggleThreadSelection],
  );

  const attemptPin = useCallback(
    (threadRef: ScopedThreadRef) => {
      void (async () => {
        // Fresh pins take the top of the arranged run.
        const result = await pinThread(threadRef);
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to pin thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      })();
    },
    [pinThread],
  );
  const attemptUnpin = useCallback(
    (threadRef: ScopedThreadRef) => {
      void (async () => {
        const result = await confirmAndUnpinThread(threadRef);
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to unpin thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      })();
    },
    [confirmAndUnpinThread],
  );
  const attemptArchive = useCallback(
    (threadRef: ScopedThreadRef) => {
      void (async () => {
        const thread = readThreadShell(threadRef);
        if (confirmThreadArchive) {
          const api = readLocalApi();
          if (!api) return;
          const confirmed = await settlePromise(() =>
            api.dialogs.confirm(`Archive thread "${thread?.title ?? "this thread"}"?`),
          );
          if (confirmed._tag === "Failure" || !confirmed.value) return;
        }
        let didArchive = false;
        const result = await archiveThread(threadRef, {
          onArchived: () => {
            didArchive = true;
          },
        });
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: didArchive
                ? "Thread archived, but navigation failed"
                : "Failed to archive thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      })();
    },
    [archiveThread, confirmThreadArchive],
  );

  // Pinned reorder: the only drag the sidebar offers. Rows on servers without
  // pin reordering render in place but cannot be picked up.
  const dragSensorRef = useRef<SidebarPointerSensor | null>(null);
  const finishPinnedDrag = useCallback(() => {
    dragSensorRef.current = null;
  }, []);
  const attachDragSensor = useCallback((sensor: SidebarPointerSensor) => {
    dragSensorRef.current = sensor;
  }, []);
  const cancelPinnedDrag = useCallback(() => {
    dragSensorRef.current?.cancel();
  }, []);
  const dndSensors = useSensors(
    useSensor(SidebarPointerSensor, {
      distance: 6,
      onAttach: attachDragSensor,
      onFinish: finishPinnedDrag,
    }),
  );
  const pinnedKeys = useMemo(() => tree.pinned.map((node) => node.key), [tree.pinned]);
  // Hidden and filtered threads keep their keys: reserve those slots without
  // writing to them.
  const pinOrderKeysById = useMemo(
    () => new Map(threads.map((thread) => [threadKeyOf(thread), thread.pinOrderKey ?? null])),
    [threads],
  );
  useEffect(() => {
    if (optimisticPinnedOrder === null) return;
    const settled = [...optimisticPinnedOrder.assignedKeys].every(([threadKey, orderKey]) => {
      const thread = threadByKey.get(threadKey);
      // A thread that left the pinned list releases the hold as well.
      return thread === undefined || thread.pinnedAt == null || thread.pinOrderKey === orderKey;
    });
    if (settled) setOptimisticPinnedOrder(null);
  }, [optimisticPinnedOrder, threadByKey]);
  const handlePinnedDragEnd = useCallback(
    (event: DragEndEvent) => {
      const movedId = String(event.active.id);
      const overId = event.over === null ? null : String(event.over.id);
      if (overId === null || overId === movedId) return;
      const from = pinnedKeys.indexOf(movedId);
      const to = pinnedKeys.indexOf(overId);
      if (from === -1 || to === -1) return;
      const nextOrder = arrayMove([...pinnedKeys], from, to);
      const assignments = planPinnedReorder({
        orderedIds: nextOrder.filter((key) => pinReorderableThreadKeys.has(key)),
        keysById: pinOrderKeysById,
        movedId,
      });
      if (assignments.length === 0) return;
      const hold = {
        order: nextOrder,
        assignedKeys: new Map(assignments.map(({ id, orderKey }) => [id, orderKey])),
      };
      setOptimisticPinnedOrder(hold);
      void (async () => {
        // Stop on failure; each successful key write remains a valid placement.
        for (const assignment of assignments) {
          const threadRef = parseScopedThreadKey(assignment.id);
          if (threadRef === null) continue;
          const result = await reorderPinnedThread(threadRef, assignment.orderKey);
          if (result._tag === "Success") continue;
          setOptimisticPinnedOrder((current) => (current === hold ? null : current));
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to reorder pinned threads",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
          return;
        }
      })();
    },
    [pinOrderKeysById, pinReorderableThreadKeys, pinnedKeys, reorderPinnedThread],
  );

  const handleMultiSelectContextMenu = useCallback(
    async (position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      // Only keys whose rows are rendered right now: selections can outlive
      // their rows, and the labels must count only what the actions touch.
      const renderedKeys = new Set(orderedThreadKeysRef.current);
      const selectedThreadKeys = [...useThreadSelectionStore.getState().selectedThreadKeys];
      const threadKeys = selectedThreadKeys.filter((threadKey) => renderedKeys.has(threadKey));
      if (threadKeys.length === 0) return;
      const count = threadKeys.length;
      const selectedThreads = threadKeys.flatMap((threadKey) => {
        const thread = threadByKeyRef.current.get(threadKey);
        return thread ? [thread] : [];
      });
      const titleRegenerationThreads = selectedThreads.filter(
        (thread) =>
          serverConfigs.get(thread.environmentId)?.environment.capabilities
            .threadTitleRegeneration === true,
      );
      const regeneratableTitleThreads = titleRegenerationThreads.filter(
        (thread) => thread.titleRegeneration == null,
      );
      const titleRegenerationMenuItem = buildBulkTitleRegenerationContextMenuItem({
        supportedCount: titleRegenerationThreads.length,
        actionableCount: regeneratableTitleThreads.length,
      });
      // Unpin (k) counts only the pinned rows in pin-capable environments.
      const pinnedSelectedThreads = selectedThreads.filter(
        (thread) =>
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadPinning ===
            true && thread.pinnedAt != null,
      );
      const unpinMenuItem = buildBulkUnpinContextMenuItem({
        pinnedCount: pinnedSelectedThreads.length,
      });
      const hasRunningThread = selectedThreads.some(
        (thread) => thread.session?.status === "running" && thread.session.activeTurnId != null,
      );
      const clicked = await settlePromise(() =>
        api.contextMenu.show(
          [
            ...(unpinMenuItem ? [unpinMenuItem] : []),
            ...(titleRegenerationMenuItem ? [titleRegenerationMenuItem] : []),
            { id: "mark-unread", label: `Mark unread (${count})` },
            { id: "archive", label: `Archive (${count})`, disabled: hasRunningThread },
            { id: "delete", label: `Delete (${count})`, destructive: true },
          ],
          position,
        ),
      );
      if (clicked._tag === "Failure") return;
      if (clicked.value === "unpin") {
        // Each unpin reports its own failure, like the single-row action.
        for (const thread of pinnedSelectedThreads) {
          attemptUnpin(scopeThreadRef(thread.environmentId, thread.id));
        }
        clearSelection();
        return;
      }
      if (clicked.value === "regenerate-title") {
        for (const thread of regeneratableTitleThreads) {
          const result = await updateThreadMetadata({
            environmentId: thread.environmentId,
            input: { threadId: thread.id, regenerateTitle: true },
          });
          if (result._tag === "Success") continue;
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to regenerate thread titles",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
          return;
        }
        clearSelection();
        return;
      }
      if (clicked.value === "mark-unread") {
        for (const threadKey of threadKeys) {
          const thread = threadByKeyRef.current.get(threadKey);
          markThreadUnread(threadKey, thread?.latestTurn?.completedAt);
        }
        clearSelection();
        return;
      }
      if (clicked.value === "archive") {
        if (confirmThreadArchive) {
          const confirmed = await settlePromise(() =>
            api.dialogs.confirm(`Archive ${count} thread${count === 1 ? "" : "s"}?`),
          );
          if (confirmed._tag === "Failure" || !confirmed.value) return;
        }
        const archiveOutcome = await archiveSelectedThreadEntries({
          entries: selectedThreads.map((thread) => ({
            threadKey: threadKeyOf(thread),
            threadRef: scopeThreadRef(thread.environmentId, thread.id),
          })),
          archive: ({ threadRef }, onArchived) => archiveThread(threadRef, { onArchived }),
        });
        const failure = archiveOutcome.mutationFailure ?? archiveOutcome.followupFailures[0];
        if (failure && !isAtomCommandInterrupted(failure)) {
          const error = squashAtomCommandFailure(failure);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: archiveOutcome.mutationFailure
                ? "Failed to archive threads"
                : "Threads archived, but navigation failed",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        removeFromSelection(archiveOutcome.archivedThreadKeys);
        return;
      }
      if (clicked.value !== "delete") return;
      if (confirmThreadDelete) {
        const confirmed = await settlePromise(() =>
          api.dialogs.confirm(
            [
              `Delete ${count} thread${count === 1 ? "" : "s"}?`,
              "This permanently clears conversation history for these threads.",
            ].join("\n"),
            { variant: "destructive" },
          ),
        );
        if (confirmed._tag === "Failure" || !confirmed.value) return;
      }
      const { deletedThreadKeys, firstFailure } = await deleteSelectedThreadEntries({
        entries: threadKeys.map((threadKey) => ({ threadKey })),
        delete: async ({ threadKey }, deletedThreadKeys) => {
          const thread = threadByKeyRef.current.get(threadKey);
          if (!thread) return null;
          return deleteThread(scopeThreadRef(thread.environmentId, thread.id), {
            deletedThreadKeys,
          });
        },
      });
      if (firstFailure !== null) {
        const firstError = squashAtomCommandFailure(firstFailure);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to delete threads",
            description: firstError instanceof Error ? firstError.message : "An error occurred.",
          }),
        );
      }
      removeFromSelection(
        getThreadKeysToDeselectAfterDelete(selectedThreadKeys, deletedThreadKeys, (threadKey) => {
          const threadRef = parseScopedThreadKey(threadKey);
          return threadRef !== null && readThreadShell(threadRef) !== null;
        }),
      );
    },
    [
      archiveThread,
      attemptUnpin,
      clearSelection,
      confirmThreadArchive,
      confirmThreadDelete,
      deleteThread,
      markThreadUnread,
      removeFromSelection,
      serverConfigs,
      updateThreadMetadata,
    ],
  );

  const handleThreadContextMenu = useCallback(
    (threadRef: ScopedThreadRef, position: { x: number; y: number }) => {
      void (async () => {
        const api = readLocalApi();
        if (!api) return;
        const threadKey = scopedThreadKey(threadRef);
        const selectionState = useThreadSelectionStore.getState();
        if (selectionState.hasSelection() && selectionState.selectedThreadKeys.has(threadKey)) {
          await handleMultiSelectContextMenu(position);
          return;
        }
        const thread = threadByKeyRef.current.get(threadKey);
        if (!thread) return;
        const threadWorkspacePath =
          thread.worktreePath ??
          projectByKey.get(physicalProjectKeyOf(thread))?.workspaceRoot ??
          null;
        const capabilities = serverConfigs.get(thread.environmentId)?.environment.capabilities;
        const isRegeneratingTitle = thread.titleRegeneration != null;
        const threadProjectGroup =
          projectGroupsRef.current.find((project) =>
            project.memberProjectRefs.some(
              (projectRef) =>
                projectRef.environmentId === thread.environmentId &&
                projectRef.projectId === thread.projectId,
            ),
          ) ?? null;
        const clicked = await settlePromise(() =>
          api.contextMenu.show(
            // Settlement, snooze and auto-settle stay server features; the
            // sidebar no longer offers them, so the menu reports no support.
            buildThreadActionMenuItems({
              branch: thread.branch ?? null,
              projectFilter: threadProjectGroup
                ? {
                    label: threadProjectGroup.displayName,
                    isActive: projectScopeKey === threadProjectGroup.projectKey,
                  }
                : null,
              isPinned: thread.pinnedAt != null,
              isSettled: false,
              autoSettleEnabled: true,
              isSnoozed: false,
              canSnoozeNow: false,
              isRegeneratingTitle,
              isRunning:
                thread.session?.status === "running" && thread.session.activeTurnId != null,
              supports: {
                settlement: false,
                autoSettleOptOut: false,
                snooze: false,
                pinning: capabilities?.threadPinning === true,
                titleRegeneration: capabilities?.threadTitleRegeneration === true,
              },
              snoozePresets: [],
            }),
            position,
          ),
        );
        if (clicked._tag === "Failure") return;
        switch (clicked.value) {
          case "filter-by-project":
            // Picking the already-scoped project again returns to all projects.
            if (threadProjectGroup) {
              setProjectScopeKey(
                projectScopeKey === threadProjectGroup.projectKey
                  ? null
                  : threadProjectGroup.projectKey,
              );
            }
            return;
          case "project-settings":
            if (threadProjectGroup) openProjectSettings(threadProjectGroup);
            return;
          case "new-thread-on-branch": {
            // Explicit branch carry-over: reuse the thread's worktree when it
            // has one, otherwise its branch on the local checkout.
            const result = await settlePromise(() =>
              handleNewThreadRef.current(scopeProjectRef(thread.environmentId, thread.projectId), {
                branch: thread.branch,
                worktreePath: thread.worktreePath,
                envMode: thread.worktreePath ? "worktree" : "local",
                startFromOrigin: false,
              }),
            );
            if (result._tag === "Failure") {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Could not create thread",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
            }
            return;
          }
          case "pin":
            attemptPin(threadRef);
            return;
          case "unpin":
            attemptUnpin(threadRef);
            return;
          case "rename":
            startThreadRename(threadRef, thread.title);
            return;
          case "regenerate-title": {
            if (isRegeneratingTitle) return;
            const result = await updateThreadMetadata({
              environmentId: threadRef.environmentId,
              input: { threadId: threadRef.threadId, regenerateTitle: true },
            });
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Failed to regenerate thread title",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
            }
            return;
          }
          case "mark-unread":
            markThreadUnread(threadKey, thread.latestTurn?.completedAt);
            return;
          case "copy-path":
            if (!threadWorkspacePath) {
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Path unavailable",
                  description: "This thread does not have a workspace path to copy.",
                }),
              );
              return;
            }
            copyPathToClipboard(threadWorkspacePath, { path: threadWorkspacePath });
            return;
          case "copy-branch":
            if (thread.branch) {
              copyBranchToClipboard(thread.branch, { branch: thread.branch });
            }
            return;
          case "copy-thread-id":
            copyThreadIdToClipboard(thread.id, { threadId: thread.id });
            return;
          case "archive":
            attemptArchive(threadRef);
            return;
          case "delete": {
            if (confirmThreadDelete) {
              const confirmed = await settlePromise(() =>
                api.dialogs.confirm(
                  [
                    `Delete thread "${thread.title}"?`,
                    "This permanently clears conversation history for this thread.",
                  ].join("\n"),
                  { variant: "destructive" },
                ),
              );
              if (confirmed._tag === "Failure" || !confirmed.value) return;
            }
            const result = await deleteThread(threadRef);
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Failed to delete thread",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
            }
            return;
          }
          default:
            return;
        }
      })();
    },
    [
      attemptArchive,
      attemptPin,
      attemptUnpin,
      confirmThreadDelete,
      copyBranchToClipboard,
      copyPathToClipboard,
      copyThreadIdToClipboard,
      deleteThread,
      handleMultiSelectContextMenu,
      markThreadUnread,
      openProjectSettings,
      projectScopeKey,
      projectByKey,
      serverConfigs,
      setProjectScopeKey,
      startThreadRename,
      updateThreadMetadata,
    ],
  );

  // New thread in a folder targets the member on this machine when the group
  // spans environments, otherwise its first member.
  const createThreadInProject = useCallback(
    (group: SidebarProjectSnapshot) => {
      const member =
        group.memberProjects.find(
          (candidate) => candidate.environmentId === primaryEnvironmentId,
        ) ?? group.memberProjects[0];
      if (!member) return;
      if (isMobile) setOpenMobile(false);
      void (async () => {
        // No options: branch, worktree, and env mode come from the user's
        // configured defaults, never from the currently viewed thread.
        const result = await settlePromise(() =>
          handleNewThreadRef.current(scopeProjectRef(member.environmentId, member.id)),
        );
        if (result._tag === "Failure") {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not create thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      })();
    },
    [isMobile, primaryEnvironmentId, setOpenMobile],
  );
  const handleProjectMenu = useCallback(
    (group: SidebarProjectSnapshot, position: { x: number; y: number }) => {
      void (async () => {
        const api = readLocalApi();
        if (!api) return;
        const clicked = await settlePromise(() =>
          api.contextMenu.show<ProjectMenuAction>(
            [
              { id: "new-thread", label: "New thread", icon: "message-square-plus" },
              { id: "copy-path", label: "Copy path" },
              {
                id: "import-sessions",
                label: "Import past sessions…",
                icon: "clock",
                separatorBefore: true,
              },
              {
                id: "remove-imported-sessions",
                label: "Remove imported sessions…",
                icon: "archive",
              },
              {
                id: "project-settings",
                label: "Project settings",
                icon: "settings",
                separatorBefore: true,
              },
            ],
            position,
          ),
        );
        if (clicked._tag === "Failure") return;
        switch (clicked.value) {
          case "new-thread":
            createThreadInProject(group);
            return;
          case "copy-path":
            copyPathToClipboard(group.workspaceRoot, { path: group.workspaceRoot });
            return;
          case "import-sessions":
            openImportSessionsDialog({
              environmentId: group.environmentId,
              projectId: group.id,
              workspaceRoot: group.workspaceRoot,
              title: group.displayName,
            });
            return;
          case "remove-imported-sessions":
            openRemoveImportedSessionsDialog({
              title: group.displayName,
              projectRefs: group.memberProjectRefs,
            });
            return;
          case "project-settings":
            openProjectSettings(group);
            return;
          default:
            return;
        }
      })();
    },
    [copyPathToClipboard, createThreadInProject, openProjectSettings],
  );

  // Thread jump (cmd+1..9) and prev/next traversal follow the rendered rows.
  const routeTerminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || isCommandPaletteOpen() || isModelPickerOpen()) {
        return;
      }
      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen: routeTerminalOpen,
          modelPickerOpen: isModelPickerOpen(),
        },
      });
      const navigateToThreadKey = (targetThreadKey: string | null) => {
        if (!targetThreadKey) return false;
        const targetThread = threadByKey.get(targetThreadKey);
        if (!targetThread) return false;
        event.preventDefault();
        event.stopPropagation();
        navigateToThread(scopeThreadRef(targetThread.environmentId, targetThread.id));
        return true;
      };
      const traversalDirection = threadTraversalDirectionFromCommand(command);
      if (traversalDirection !== null) {
        navigateToThreadKey(
          resolveAdjacentThreadId({
            threadIds: orderedThreadKeys,
            currentThreadId: routeThreadKey,
            direction: traversalDirection,
          }),
        );
        return;
      }
      const jumpIndex = threadJumpIndexFromCommand(command ?? "");
      if (jumpIndex === null) return;
      navigateToThreadKey(orderedThreadKeys[jumpIndex] ?? null);
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [
    keybindings,
    navigateToThread,
    orderedThreadKeys,
    routeTerminalOpen,
    routeThreadKey,
    threadByKey,
  ]);

  // Hints show only while the held modifiers exactly match a thread-jump
  // binding.
  const shortcutModifiers = useShortcutModifierState();
  const terminalFocused = useTerminalFocus();
  const shouldShowJumpHintsNow = shouldShowThreadJumpHintsForModifiers(
    shortcutModifiers,
    keybindings,
    {
      platform: navigator.platform,
      context: {
        terminalFocus: terminalFocused,
        terminalOpen: routeTerminalOpen,
        modelPickerOpen: isModelPickerOpen(),
      },
    },
  );
  useEffect(() => {
    updateThreadJumpHintsVisibility(shouldShowJumpHintsNow);
  }, [shouldShowJumpHintsNow, updateThreadJumpHintsVisibility]);

  // New thread defaults to the project you're in (active thread's project,
  // falling back to the top project) — same resolution the command palette
  // uses.
  const handleNewThreadClick = useCallback(
    (event?: ReactMouseEvent) => {
      // One project: nothing to pick, create immediately. Shift+click creates
      // directly in the current project even with several projects.
      if (shouldCreateNewThreadInCurrentProject(event?.shiftKey ?? false, projectGroups.length)) {
        if (isMobile) setOpenMobile(false);
        void startNewThreadFromContext({
          activeDraftThread: newThreadContext.activeDraftThread,
          activeThread: newThreadContext.activeThread ?? undefined,
          defaultProjectRef: newThreadContext.defaultProjectRef,
          handleNewThread: newThreadContext.handleNewThread,
        });
        return;
      }
      if (isMobile) setOpenMobile(false);
      openCommandPalette({ open: "new-thread-in" });
    },
    [isMobile, newThreadContext, projectGroups.length, setOpenMobile],
  );

  // The button mirrors chat.new: in multi-project setups both route through
  // the command palette's "New thread in..." picker, and in single-project
  // setups both create immediately.
  const newThreadShortcutLabel =
    shortcutLabelForCommand(keybindings, "chat.new") ??
    (projectGroups.length <= 1 ? shortcutLabelForCommand(keybindings, "chat.newLocal") : undefined);
  const newThreadInProjectShortcutLabel = shortcutLabelForCommand(keybindings, "chat.newLocal");

  const renderThreadRow = (
    entry: SidebarThreadRowEntry<EnvironmentThreadShell>,
    sortable?: SortableNodeBag,
  ) => {
    const { node } = entry;
    const thread = node.thread;
    const threadKey = node.key;
    return (
      <SidebarThreadRow
        key={threadKey}
        thread={thread}
        depth={entry.depth}
        isLastSibling={entry.isLastSibling}
        guides={entry.guides.map((continues) => (continues ? "1" : "0")).join("")}
        descendantCount={node.descendantCount}
        childrenExpanded={!collapsedThreadKeys.has(threadKey)}
        onToggleChildren={toggleThreadChildren}
        isPinned={thread.pinnedAt != null}
        pinningSupported={
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadPinning === true
        }
        isActive={routeThreadKey === threadKey}
        openPullRequestsInRightPanel={routeThreadRef !== null}
        jumpLabel={showThreadJumpHints ? (jumpLabelByKey.get(threadKey) ?? null) : null}
        currentEnvironmentId={primaryEnvironmentId}
        environmentLabel={environmentLabelById.get(thread.environmentId) ?? null}
        environmentMachine={environmentMachineById.get(thread.environmentId) ?? "server"}
        project={projectByKey.get(physicalProjectKeyOf(thread)) ?? null}
        projectDisplayName={projectDisplayNameByKey.get(physicalProjectKeyOf(thread)) ?? null}
        providerEntryByInstanceId={
          providerEntriesByEnvironment.get(thread.environmentId) ?? EMPTY_PROVIDER_ENTRIES
        }
        nowMinute={nowMinute}
        onThreadClick={handleThreadClick}
        onThreadActivate={navigateToThread}
        onStartRename={startThreadRename}
        onRenameTitleChange={setRenamingTitle}
        onCommitRename={commitThreadRename}
        onCancelRename={cancelThreadRename}
        isRenaming={renamingThreadKey === threadKey}
        renamingTitle={renamingThreadKey === threadKey ? renamingTitle : ""}
        onContextMenu={handleThreadContextMenu}
        onPin={attemptPin}
        onUnpin={attemptUnpin}
        onArchive={attemptArchive}
        onFileDropThreads={handleThreadFileDrop}
        dragListeners={entry.depth === 0 ? sortable?.listeners : undefined}
        isDragging={entry.depth === 0 ? sortable?.isDragging : undefined}
      />
    );
  };
  // A top-level thread and its expanded child agents travel as one list item,
  // so dragging a pinned parent carries its children with it.
  const renderThreadNode = (
    node: SidebarThreadTreeNode<EnvironmentThreadShell>,
    sortable?: SortableNodeBag,
  ) => {
    const rows = flattenSidebarThreadNode(node, isThreadExpanded);
    return (
      <li
        key={node.key}
        ref={sortable?.setNodeRef}
        className={cn("list-none", sortable?.isDragging && "relative z-20")}
        style={
          sortable
            ? {
                transform: CSS.Translate.toString(sortable.transform),
                transition: sortable.transition,
              }
            : undefined
        }
      >
        {/* Always a nested list, so expanding child agents never remounts the parent row. */}
        <ul role="group" className="flex flex-col">
          {rows.map((entry) => (
            <li key={entry.node.key} className="list-none">
              {renderThreadRow(entry, sortable)}
            </li>
          ))}
        </ul>
      </li>
    );
  };

  // Every project renders a folder, so the list is only empty without projects.
  const hasAnyRows =
    tree.folders.length > 0 || tree.pinned.length > 0 || visibleDraftSessionCount > 0;

  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent
        className="min-h-full"
        fixedHeader={
          <SidebarGroup className="z-[1]">
            <SidebarThreadHeader
              searchFieldRef={headerSearchRef}
              hasProjects={projectGroups.length > 0}
              projectScope={
                <Combobox
                  items={projectScopeItems}
                  filteredItems={filteredProjectScopeItems}
                  autoHighlight
                  itemToStringLabel={(item) => item.label}
                  isItemEqualToValue={(a, b) => a.value === b.value}
                  open={projectScopeMenuState.open}
                  onOpenChange={(open) => {
                    if (open) suppressNextScopeChangeRef.current = false;
                    dispatchProjectScopeMenu({ type: "open-changed", open });
                  }}
                  onItemHighlighted={(item) => {
                    highlightedProjectScopeKeyRef.current = item?.value ?? null;
                  }}
                  value={selectedProjectScopeItem}
                  onValueChange={(item) => {
                    if (suppressNextScopeChangeRef.current) {
                      suppressNextScopeChangeRef.current = false;
                      return;
                    }
                    if (!item) return;
                    setProjectScopeKey(item.value === "all" ? null : item.value);
                  }}
                >
                  <ComboboxTrigger
                    render={
                      <SidebarHeaderIconButton
                        label={
                          scopedProjectGroup
                            ? `Filter threads by project: ${scopedProjectGroup.displayName}`
                            : "Filter threads by project"
                        }
                      />
                    }
                  >
                    {scopedProjectGroup ? (
                      // Wrapped so the button's direct-child svg color rule cannot override
                      // a project's own icon color.
                      <span className="flex shrink-0">
                        <ProjectFavicon project={scopedProjectGroup} className="size-4" />
                      </span>
                    ) : (
                      <FolderIcon className="size-4" />
                    )}
                  </ComboboxTrigger>
                  <ComboboxPopup
                    align="start"
                    // Anchored to the search field, not the 28px trigger.
                    anchor={headerSearchRef}
                    className="max-w-[min(18rem,var(--available-width))] overflow-hidden"
                  >
                    <ComboboxSearchInput
                      aria-label="Search projects"
                      placeholder="Search projects..."
                      value={projectScopeMenuState.query}
                      onKeyDown={(event) => {
                        if (
                          event.defaultPrevented ||
                          event.nativeEvent.isComposing ||
                          event.ctrlKey ||
                          event.altKey ||
                          event.metaKey ||
                          (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))
                        ) {
                          return;
                        }
                        // Combobox items use virtual focus: keyboard events
                        // stay on this input, not on the highlighted option.
                        const scopeKey = highlightedProjectScopeKeyRef.current;
                        const project = scopeKey ? projectGroupByScopeKey.get(scopeKey) : null;
                        if (project) handleProjectSettings(event, project);
                      }}
                      onChange={(event) =>
                        dispatchProjectScopeMenu({
                          type: "query-changed",
                          query: event.target.value,
                        })
                      }
                    />
                    <ComboboxEmpty>No matching projects.</ComboboxEmpty>
                    <ComboboxList>
                      {(item: (typeof projectScopeItems)[number]) => {
                        const project = projectGroupByScopeKey.get(item.value) ?? null;
                        return (
                          <ComboboxItem
                            key={item.value}
                            hideIndicator
                            value={item}
                            onContextMenu={(event) => {
                              if (project) handleProjectSettings(event, project);
                            }}
                          >
                            {project ? (
                              <ProjectFavicon project={project} className="size-4 shrink-0" />
                            ) : (
                              <FolderIcon className="size-4 shrink-0" />
                            )}
                            <span className="min-w-0 flex-1 truncate text-sm">{item.label}</span>
                            {project && showProjectEnvironments ? (
                              <ProjectEnvironmentBadge
                                group={project}
                                primaryEnvironmentId={primaryEnvironmentId}
                                machineByEnvironmentId={environmentMachineById}
                              />
                            ) : null}
                            {project ? (
                              <Button
                                size="icon-xs"
                                variant="ghost-muted"
                                tabIndex={-1}
                                aria-hidden="true"
                                title={`Project settings for ${project.displayName}`}
                                className="ml-auto"
                                onPointerDown={(event) => event.stopPropagation()}
                                onClick={(event) => {
                                  void handleProjectSettings(event, project);
                                }}
                              >
                                <SettingsIcon className="size-3.5" />
                              </Button>
                            ) : null}
                          </ComboboxItem>
                        );
                      }}
                    </ComboboxList>
                  </ComboboxPopup>
                </Combobox>
              }
              onNewProject={openAddProjectCommandPalette}
              onNewThread={handleNewThreadClick}
              newThreadDisabled={projects.length === 0}
              newThreadShortcutLabel={newThreadShortcutLabel}
              newThreadInProjectShortcutLabel={newThreadInProjectShortcutLabel}
              showNewThreadInProjectHint={projectGroups.length > 1}
              searchInputRef={threadSearchInputRef}
              searchQuery={threadSearchQuery}
              onSearchQueryChange={(value) => {
                setThreadSearchQuery(value);
                setActiveSearchResultIndex(0);
              }}
              onSearchKeyDown={handleThreadSearchKeyDown}
              isSearching={isSearchingThreads}
              searchResultCount={threadSearchResults.length}
              activeSearchResultIndex={activeSearchResultIndex}
              onClearSearch={clearThreadSearch}
            />
          </SidebarGroup>
        }
      >
        <SidebarGroup className="flex-1">
          {isSearchingThreads ? (
            threadSearchResults.length > 0 ? (
              <TooltipProvider
                key="sidebar-thread-search-tooltips-150"
                delay={150}
                closeDelay={0}
                timeout={400}
              >
                <ul
                  id="sidebar-thread-search-results"
                  role="listbox"
                  aria-label="Thread search results"
                  className="flex flex-col gap-px"
                >
                  {threadSearchResults.map((thread, index) => {
                    const threadKey = threadKeyOf(thread);
                    return (
                      <SidebarSearchResultRow
                        key={threadKey}
                        thread={thread}
                        project={projectByKey.get(physicalProjectKeyOf(thread)) ?? null}
                        projectDisplayName={
                          projectDisplayNameByKey.get(physicalProjectKeyOf(thread)) ?? null
                        }
                        environmentLabel={environmentLabelById.get(thread.environmentId) ?? null}
                        environmentMachine={
                          environmentMachineById.get(thread.environmentId) ?? "server"
                        }
                        providerEntryByInstanceId={
                          providerEntriesByEnvironment.get(thread.environmentId) ??
                          EMPTY_PROVIDER_ENTRIES
                        }
                        isHighlighted={activeSearchResultIndex === index}
                        isRouteActive={routeThreadKey === threadKey}
                        resultId={`sidebar-thread-search-result-${index}`}
                        searchMatch={
                          threadSearchMatchByKey.get(
                            threadSearchMatchKey({
                              environmentId: thread.environmentId,
                              threadId: thread.id,
                            }),
                          ) ?? null
                        }
                        searchQuery={threadSearchQuery}
                        onHighlight={() => setActiveSearchResultIndex(index)}
                        onSelect={() => selectThreadSearchResult(thread)}
                        onFileDropThreads={handleThreadFileDrop}
                      />
                    );
                  })}
                </ul>
              </TooltipProvider>
            ) : (
              <p
                role="status"
                className="px-2 py-6 text-center text-xs text-sidebar-muted-foreground"
              >
                {threadSearch.isPending ? "Searching thread messages…" : "No threads found"}
              </p>
            )
          ) : (
            <TooltipProvider
              key="sidebar-thread-tooltips-150"
              delay={150}
              closeDelay={0}
              timeout={400}
            >
              <ul role="list" aria-label="Threads" className="flex flex-col gap-px">
                <SidebarDraftBlock
                  key="draft-sessions"
                  projectDisplayNameByKey={projectDisplayNameByKey}
                  scopedProjectKeys={scopedProjectKeys}
                  routeDraftId={routeDraftIdForRows}
                  onNavigateToDraft={navigateToDraft}
                />
                {tree.pinned.length > 0 ? (
                  <>
                    <DndContext
                      sensors={dndSensors}
                      collisionDetection={closestCenter}
                      modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
                      onDragEnd={handlePinnedDragEnd}
                    >
                      <SidebarDragLifecycle onUnmount={cancelPinnedDrag} />
                      <SortableContext items={pinnedKeys} strategy={verticalListSortingStrategy}>
                        {tree.pinned.map((node) => (
                          <SortablePinnedNode
                            key={node.key}
                            id={node.key}
                            disabled={
                              renamingThreadKey === node.key ||
                              !pinReorderableThreadKeys.has(node.key) ||
                              optimisticPinnedOrder !== null
                            }
                          >
                            {(bag) => renderThreadNode(node, bag)}
                          </SortablePinnedNode>
                        ))}
                      </SortableContext>
                    </DndContext>
                    <li
                      aria-hidden
                      data-testid="sidebar-pinned-divider"
                      className="mx-2 my-1 h-px list-none bg-sidebar-border/60"
                    />
                  </>
                ) : null}
                {tree.folders.map((folder) => {
                  const expanded = folderExpandedByKey.get(folder.key) ?? true;
                  return (
                    <li key={folder.key} className="list-none">
                      <SidebarProjectFolderRow
                        group={folder.project}
                        expanded={expanded}
                        threadCount={folder.nodes.length}
                        showEnvironment={showProjectEnvironments}
                        primaryEnvironmentId={primaryEnvironmentId}
                        machineByEnvironmentId={environmentMachineById}
                        onToggle={toggleProjectFolder}
                        onNewThread={createThreadInProject}
                        onOpenMenu={handleProjectMenu}
                      />
                      {expanded && folder.nodes.length > 0 ? (
                        <ul role="group" className="flex flex-col gap-px pb-1">
                          {folder.nodes.map((node) => renderThreadNode(node))}
                        </ul>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </TooltipProvider>
          )}
          {!isSearchingThreads && !hasAnyRows ? (
            <div className="flex flex-col items-center gap-2 px-2 py-6 text-center text-xs text-muted-foreground/60">
              {projects.length === 0 ? (
                <>
                  <span>No projects yet</span>
                  <button
                    type="button"
                    onClick={openAddProjectCommandPalette}
                    className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-sidebar-border px-2.5 py-1 text-2xs font-medium text-sidebar-muted-foreground transition-colors hover:bg-sidebar-foreground/6 hover:text-sidebar-foreground"
                  >
                    <PlusIcon className="-mx-0.5 size-3" />
                    Add project
                  </button>
                </>
              ) : (
                "No threads yet"
              )}
            </div>
          ) : null}
        </SidebarGroup>
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}
