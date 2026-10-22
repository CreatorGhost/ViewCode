import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { ChevronDownIcon, XIcon } from "lucide-react";
import { Menu, MenuItem, MenuItemLabel, MenuPopup, MenuTrigger } from "../ui/menu";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";

import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { environmentCatalog } from "../../connection/catalog";
import { isEditableFocused } from "../../lib/editableFocus";
import { isPreviewFocused } from "../../lib/previewFocus";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { primaryServerKeybindingsAtom, primaryServerProvidersAtom } from "../../state/server";
import { useViewCodeThreadShells as useThreadShells } from "../../state/viewcodeThreadShells";
import { environmentShell } from "../../state/shell";
import { resolveThreadRouteRef } from "../../threadRoutes";
import type { ViewCodeSidebarThread as ThreadShell } from "../../state/viewcodeThreadShells";
import { useThreadTabsStore } from "../../threadTabsStore";
import { useUiStateStore } from "../../uiStateStore";
import { PROVIDER_ICON_BY_PROVIDER } from "../chat/viewcodeProviderIcons";
import { isSidechat } from "@t3tools/client-runtime/state/sidechat";
import {
  hasUnseenCompletion,
  resolveSidebarThreadStatus,
  type SidebarThreadStatus,
} from "../Sidebar.logic";
import { threadStatusGlyph } from "../sidebar/ThreadStatusGlyph";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  adjacentThreadTab,
  closeThreadTab,
  projectThreadTabs,
  resolveThreadTabCommand,
  threadTabTitle,
  MAX_VISIBLE_THREAD_TABS,
  threadTabsThatFit,
  visibleThreadTabs,
} from "./threadTabs.logic";

function useActiveThreadRef(): ScopedThreadRef | null {
  return useParams({ strict: false, select: (params) => resolveThreadRouteRef(params) });
}

/**
 * Environments whose live thread list has arrived, newline-joined so the value
 * only changes when the set does (not on every shell update).
 */
const liveShellEnvironmentIdsAtom = Atom.make((get) => {
  const live: string[] = [];
  for (const environmentId of enabledEnvironmentIds(get(environmentCatalog.catalogValueAtom))) {
    if (get(environmentShell.stateValueAtom(environmentId)).status === "live") {
      live.push(environmentId);
    }
  }
  return live.join("\n");
}).pipe(Atom.withLabel("web-thread-tabs-live-environments"));

/** Records visits, keeps the tab list tidy, and owns the next/previous/close tab shortcuts. */
export function ThreadTabsHost() {
  const navigate = useNavigate();
  const active = useActiveThreadRef();
  const activeKey = active ? scopedThreadKey(active) : null;
  const shells = useThreadShells();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const liveEnvironmentIds = useAtomValue(liveShellEnvironmentIdsAtom);

  useEffect(() => {
    if (active) useThreadTabsStore.getState().open(active.environmentId, scopedThreadKey(active));
  }, [active]);

  // Tabs for threads that no longer exist or were archived (here or on another
  // device) quietly go away, once that environment's live thread list is in.
  const liveKeys = new Set(
    shells
      .filter((shell) => shell.archivedAt == null && !isSidechat(shell))
      .map((shell) => scopedThreadKey({ environmentId: shell.environmentId, threadId: shell.id })),
  );
  useEffect(() => {
    if (liveEnvironmentIds === "") return;
    useThreadTabsStore
      .getState()
      .prune(
        new Set(liveEnvironmentIds.split("\n")),
        (key) => key === activeKey || liveKeys.has(key),
      );
  }, [activeKey, liveEnvironmentIds, liveKeys]);

  const shellsRef = useRef(shells);
  useLayoutEffect(() => {
    shellsRef.current = shells;
  }, [shells]);
  useEffect(() => {
    const go = (key: string | null) => {
      const ref = key ? parseScopedThreadKey(key) : null;
      if (!ref) return;
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: ref.environmentId, threadId: ref.threadId },
      });
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !active) return;
      const command = resolveThreadTabCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          previewFocus: isPreviewFocused(),
          editableFocus: isEditableFocused(event.target),
        },
      });
      if (command === null) return;
      const store = useThreadTabsStore.getState();
      const byKey = new Map(
        shellsRef.current.map((shell) => [
          scopedThreadKey({ environmentId: shell.environmentId, threadId: shell.id }),
          shell,
        ]),
      );
      const tabs = projectThreadTabs(
        store.tabsByEnvironmentId[active.environmentId] ?? [],
        activeKey,
        byKey,
      );
      event.preventDefault();
      event.stopPropagation();
      if (command === "tab.close") {
        const key = scopedThreadKey(active);
        const next = closeThreadTab(tabs, key, key).nextActiveKey;
        store.close(active.environmentId, key, key);
        go(next);
        if (next === null) void navigate({ to: "/" });
        return;
      }
      go(adjacentThreadTab(tabs, activeKey, command === "tab.next" ? "next" : "previous"));
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [active, activeKey, keybindings, navigate]);

  return null;
}

export interface ActiveTabExtras {
  /** Replaces the provider glyph on the active tab (the project favicon). */
  readonly glyph?: React.ReactNode;
  /** Replaces the title while the thread is being renamed inline. */
  readonly renameField?: React.ReactNode;
  /** Present when the thread has an action menu: clicking the active tab or its chevron opens it. */
  readonly onClick?: (event: React.MouseEvent<HTMLElement>) => void;
  readonly onDoubleClick?: ((event: React.MouseEvent<HTMLElement>) => void) | undefined;
  readonly onBlur?: (() => void) | undefined;
  readonly onKeyActivate?: (anchor: HTMLElement) => void;
  /** Native parent breadcrumb already names the active tab's parent. */
  readonly hideLeadTitle?: boolean;
}

const TabItem = memo(function TabItem(props: {
  threadKey: string;
  title: string;
  /** A child agent's lead, named before the child's own title. */
  leadTitle: string | null;
  driverKind: string | null;
  status: SidebarThreadStatus;
  unread: boolean;
  /** The agent finished or is waiting on the user, and the tab hasn't been opened since. */
  attention?: boolean | undefined;
  active: boolean;
  onSelect: (key: string) => void;
  onClose: (key: string) => void;
  /** Header-supplied behaviour for the active tab: leading glyph, rename field, thread menu. */
  activeExtras?: ActiveTabExtras | undefined;
  closable?: boolean;
  /** The only tab in the header: it gives way to the header's actions and truncates its title. */
  alone?: boolean;
}) {
  const extras = props.active ? props.activeExtras : undefined;
  const title = threadTabTitle(props.title, extras?.hideLeadTitle ? null : props.leadTitle);
  const statusGlyph = threadStatusGlyph(props.status, "xs");
  const Icon = props.driverKind
    ? (PROVIDER_ICON_BY_PROVIDER as Record<string, React.ComponentType<{ className?: string }>>)[
        props.driverKind
      ]
    : undefined;
  return (
    <div
      role="tab"
      tabIndex={0}
      aria-selected={props.active}
      aria-haspopup={extras?.onClick ? "menu" : undefined}
      data-active={props.active}
      data-thread-tab=""
      data-attention={props.attention && !props.active ? "true" : undefined}
      onClick={(event) => {
        if (extras?.onClick) extras.onClick(event);
        else props.onSelect(props.threadKey);
      }}
      onDoubleClick={extras?.onDoubleClick}
      onBlur={extras?.onBlur}
      onKeyDown={(event) => {
        // Rename fields and the close button own their Enter/Space behavior.
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          if (extras?.onKeyActivate) extras.onKeyActivate(event.currentTarget);
          else props.onSelect(props.threadKey);
        }
      }}
      // Middle click closes, like a browser tab.
      onAuxClick={(event) => {
        if (event.button === 1) {
          event.preventDefault();
          props.onClose(props.threadKey);
        }
      }}
      onMouseDown={(event) => {
        if (event.button === 1) event.preventDefault();
      }}
      className={cn(
        "group/tab relative flex h-7 max-w-56 cursor-pointer items-center gap-1.5 rounded-lg pr-1 pl-2 text-xs outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        // Tabs give way to their minimum before the strip folds them.
        props.alone ? "min-w-0 shrink" : "min-w-24 shrink",
        props.active
          ? "bg-foreground/10 text-foreground"
          : "text-muted-foreground hover:bg-foreground/6 hover:text-foreground",
      )}
    >
      {extras?.glyph ?? (Icon ? <Icon className="size-3 shrink-0 opacity-70" /> : null)}
      {extras?.renameField ??
        (title.lead ? (
          // The lead gives way first, so the child's own name stays readable; hover shows both.
          <Tooltip>
            <TooltipTrigger render={<span className="flex min-w-0 flex-1" />}>
              <span className="min-w-0 shrink-[999] truncate">{title.lead}</span>
              <span className="shrink-0 px-1 opacity-60">›</span>
              <span className="min-w-0 truncate">{title.title}</span>
            </TooltipTrigger>
            <TooltipPopup side="bottom">{title.full}</TooltipPopup>
          </Tooltip>
        ) : (
          <span className="min-w-0 flex-1 truncate">{title.title}</span>
        ))}
      {extras?.onClick && !extras.renameField ? (
        <ChevronDownIcon
          aria-hidden
          data-thread-title-chevron
          className="size-3.5 shrink-0 text-muted-foreground"
        />
      ) : null}
      {statusGlyph ? (
        <span className="flex shrink-0">{statusGlyph}</span>
      ) : props.unread ? (
        <span aria-label="Unread" className="size-1.5 shrink-0 rounded-full bg-success" />
      ) : null}
      {props.closable === false ? null : (
        <button
          type="button"
          aria-label={`Close ${title.full}`}
          onDoubleClick={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            props.onClose(props.threadKey);
          }}
          className="flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 hover:bg-foreground/10 hover:text-foreground group-hover/tab:opacity-100 focus-visible:opacity-100 group-data-[active=true]/tab:opacity-100"
        >
          <XIcon className="size-3" />
        </button>
      )}
    </div>
  );
});

/**
 * The open-thread tabs, rendered on the left of each chat's single top bar. With one thread open
 * (or a draft) the strip is just the current thread as one tab, so the left side is never empty.
 * `activeRef` is the pane's own thread, so a split-view pane shows its own active tab.
 */
export const OpenThreadTabs = memo(function OpenThreadTabs(props: {
  activeRef: ScopedThreadRef;
  fallbackTitle: string;
  activeExtras?: ActiveTabExtras | undefined;
  /** Split-view pane: show only this pane's thread; the tab list belongs to a single chat. */
  paneOnly?: boolean | undefined;
}) {
  const navigate = useNavigate();
  const active = props.activeRef;
  const activeKey = active ? scopedThreadKey(active) : null;
  const tabs = useThreadTabsStore((state) =>
    active ? state.tabsByEnvironmentId[active.environmentId] : undefined,
  );
  const shells = useThreadShells();
  const visited = useUiStateStore((state) => state.threadLastVisitedAtById);
  const scroller = useRef<HTMLDivElement>(null);
  // How many tabs the strip has room for, from its container's width; the rest fold into
  // the "+N" menu instead of being cut at the strip's edge.
  const [fit, setFit] = useState(MAX_VISIBLE_THREAD_TABS);
  useLayoutEffect(() => {
    const container = scroller.current?.parentElement;
    if (!container) return;
    return observeResize(container, ([entry]) => {
      const next = threadTabsThatFit(entry?.contentRect.width ?? 0);
      setFit((current) => (current === next ? current : next));
    });
  }, []);
  // A custom instance id says nothing about its driver, so the glyph comes from the provider list.
  const providers = useAtomValue(primaryServerProvidersAtom);
  const driverByInstance = new Map(
    providers.map((provider) => [provider.instanceId as string, provider.driver as string]),
  );

  const byKey = new Map(
    shells.map((shell) => [
      scopedThreadKey({ environmentId: shell.environmentId, threadId: shell.id }),
      shell,
    ]),
  );
  // A child agent's lead lives in the same environment, so it is found the way the tab's own shell is.
  const leadTitleOf = (shell: ThreadShell) =>
    shell.parentThreadId
      ? (byKey.get(
          scopedThreadKey({ environmentId: shell.environmentId, threadId: shell.parentThreadId }),
        )?.title ?? null)
      : null;

  // Keep a newly selected/opened tab in view when the strip overflows.
  useEffect(() => {
    if (activeKey === null || !tabs?.includes(activeKey)) return;
    scroller.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeKey, tabs]);

  const projectTabs = projectThreadTabs(tabs ?? [], activeKey, byKey);
  const showList =
    !props.paneOnly &&
    fit > 0 &&
    projectTabs.length >= 2 &&
    activeKey !== null &&
    projectTabs.includes(activeKey);
  const { visible, overflow } = visibleThreadTabs(projectTabs, activeKey, fit);

  const select = (key: string) => {
    const ref = parseScopedThreadKey(key);
    if (ref) {
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: ref.environmentId, threadId: ref.threadId },
      });
    }
  };
  const environmentId = active.environmentId;
  const close = (key: string) => {
    // The neighbour comes from this project's tabs, so closing never lands on another project.
    const next = closeThreadTab(projectTabs, key, activeKey).nextActiveKey;
    useThreadTabsStore.getState().close(environmentId, key, activeKey);
    if (key !== activeKey) return;
    if (next) select(next);
    else void navigate({ to: "/" });
  };

  if (!showList) {
    const shell = activeKey ? byKey.get(activeKey) : undefined;
    return (
      <div
        role="tablist"
        aria-label="Open threads"
        ref={scroller}
        className="flex min-w-0 items-center overflow-hidden [-webkit-app-region:no-drag]"
      >
        <TabItem
          alone
          threadKey={activeKey ?? ""}
          title={props.fallbackTitle}
          leadTitle={shell ? leadTitleOf(shell) : null}
          driverKind={null}
          status={shell ? resolveSidebarThreadStatus(shell) : "ready"}
          unread={false}
          active
          onSelect={select}
          onClose={close}
          activeExtras={props.activeExtras}
          closable={false}
        />
      </div>
    );
  }

  return (
    <div
      role="tablist"
      aria-label="Open threads"
      ref={scroller}
      // Wheel scrolls the strip sideways; the scrollbar stays hidden.
      onWheel={(event) => {
        if (scroller.current && Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
          scroller.current.scrollLeft += event.deltaY;
        }
      }}
      className={cn(
        "flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] [-webkit-app-region:no-drag] [&::-webkit-scrollbar]:hidden",
      )}
    >
      {visible.map((key) => {
        const shell = byKey.get(key);
        if (!shell) return null;
        const status = resolveSidebarThreadStatus(shell);
        const unread = hasUnseenCompletion({ ...shell, lastVisitedAt: visited[key] });
        return (
          <TabItem
            key={key}
            threadKey={key}
            title={shell.title}
            leadTitle={leadTitleOf(shell)}
            driverKind={driverByInstance.get(shell.modelSelection.instanceId) ?? null}
            status={status}
            unread={unread}
            attention={unread || status === "approval" || status === "input"}
            active={key === activeKey}
            onSelect={select}
            onClose={close}
            activeExtras={key === activeKey ? props.activeExtras : undefined}
          />
        );
      })}
      {overflow.length > 0 ? (
        <OverflowTabsMenu tabs={overflow} byKey={byKey} visited={visited} onSelect={select} />
      ) : null}
    </div>
  );
});

/** The tabs past the strip's cap: a "+N" that lists them, attention first. */
function OverflowTabsMenu(props: {
  tabs: ReadonlyArray<string>;
  byKey: ReadonlyMap<string, ThreadShell>;
  visited: Record<string, string | undefined>;
  onSelect: (key: string) => void;
}) {
  const entries = props.tabs.flatMap((key) => {
    const shell = props.byKey.get(key);
    if (!shell) return [];
    const status = resolveSidebarThreadStatus(shell);
    const unread = hasUnseenCompletion({ ...shell, lastVisitedAt: props.visited[key] });
    const attention = unread || status === "approval" || status === "input";
    return [{ key, shell, status, unread, attention }];
  });
  const needsYou = entries.filter((entry) => entry.attention).length;
  return (
    <Menu>
      <MenuTrigger
        render={
          // Dressed like a tab, since it stands in the strip for the tabs it holds.
          <button
            type="button"
            aria-label={`${entries.length} more open threads`}
            data-thread-tab-overflow=""
            data-attention={needsYou > 0 ? "true" : undefined}
            className="flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground tabular-nums outline-none hover:bg-foreground/6 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-[popup-open]:bg-foreground/10 data-[popup-open]:text-foreground"
          />
        }
      >
        +{entries.length}
        {needsYou > 0 ? (
          <span aria-label={`${needsYou} need you`} className="size-1.5 rounded-full bg-warning" />
        ) : null}
      </MenuTrigger>
      <MenuPopup align="start">
        {entries.map(({ key, shell, status, unread }) => {
          const glyph = threadStatusGlyph(status, "xs");
          return (
            // Select only: a close control inside a menu item is unreachable by keyboard, and a
            // selected tab closes from the strip like any other.
            <MenuItem key={key} onClick={() => props.onSelect(key)}>
              <MenuItemLabel>
                <span className="block min-w-0 truncate">{shell.title}</span>
              </MenuItemLabel>
              {glyph ? (
                <span className="flex shrink-0">{glyph}</span>
              ) : unread ? (
                <span aria-label="Unread" className="size-1.5 shrink-0 rounded-full bg-success" />
              ) : null}
            </MenuItem>
          );
        })}
      </MenuPopup>
    </Menu>
  );
}
