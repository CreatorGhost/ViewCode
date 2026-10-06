import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import { memo, useEffect, useMemo, useRef } from "react";

import { cn } from "~/lib/utils";
import { resolveShortcutCommand } from "../../keybindings";
import { primaryServerKeybindingsAtom, primaryServerProvidersAtom } from "../../state/server";
import { useThreadShells } from "../../state/entities";
import { resolveThreadRouteRef } from "../../threadRoutes";
import { useThreadTabsStore } from "../../threadTabsStore";
import { useUiStateStore } from "../../uiStateStore";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { PROVIDER_ICON_BY_PROVIDER } from "../chat/providerIconUtils";
import { hasUnseenCompletion, resolveSidebarThreadStatus } from "../Sidebar.logic";
import { adjacentThreadTab } from "./threadTabs.logic";

function useActiveThreadRef(): ScopedThreadRef | null {
  return useParams({ strict: false, select: (params) => resolveThreadRouteRef(params) });
}

/** Records visits, keeps the tab list tidy, and owns the next/previous/close tab shortcuts. */
export function ThreadTabsHost() {
  const navigate = useNavigate();
  const active = useActiveThreadRef();
  const activeKey = active ? scopedThreadKey(active) : null;
  const shells = useThreadShells();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);

  useEffect(() => {
    if (active) useThreadTabsStore.getState().open(active.environmentId, scopedThreadKey(active));
  }, [active]);

  // Tabs for threads that no longer exist (archived on another device, deleted) quietly go away.
  const liveKeys = useMemo(
    () =>
      new Set(
        shells.map((shell) =>
          scopedThreadKey({ environmentId: shell.environmentId, threadId: shell.id }),
        ),
      ),
    [shells],
  );
  useEffect(() => {
    if (shells.length === 0) return;
    const store = useThreadTabsStore.getState();
    for (const environmentId of Object.keys(store.tabsByEnvironmentId)) {
      store.prune(environmentId, (key) => liveKeys.has(key));
    }
  }, [liveKeys, shells.length]);

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
      const command = resolveShortcutCommand(event, keybindings);
      if (command !== "tab.next" && command !== "tab.previous" && command !== "tab.close") return;
      const store = useThreadTabsStore.getState();
      const tabs = store.tabsByEnvironmentId[active.environmentId] ?? [];
      event.preventDefault();
      event.stopPropagation();
      if (command === "tab.close") {
        const key = scopedThreadKey(active);
        const next = store.close(active.environmentId, key, key);
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

const TabItem = memo(function TabItem(props: {
  threadKey: string;
  title: string;
  driverKind: string | null;
  running: boolean;
  unread: boolean;
  active: boolean;
  onSelect: (key: string) => void;
  onClose: (key: string) => void;
}) {
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
      data-active={props.active}
      data-thread-tab=""
      onClick={() => props.onSelect(props.threadKey)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          props.onSelect(props.threadKey);
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
        "group/tab relative flex h-7 min-w-24 max-w-48 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg pr-1 pl-2 text-xs outline-none select-none focus-visible:ring-2 focus-visible:ring-ring",
        props.active
          ? "bg-foreground/10 text-foreground"
          : "text-muted-foreground hover:bg-foreground/6 hover:text-foreground",
      )}
    >
      {Icon ? <Icon className="size-3 shrink-0 opacity-70" /> : null}
      <span className="min-w-0 flex-1 truncate">{props.title}</span>
      {props.running ? (
        <span aria-label="Running" className="size-1.5 shrink-0 rounded-full bg-primary" />
      ) : props.unread ? (
        <span aria-label="Unread" className="size-1.5 shrink-0 rounded-full bg-success" />
      ) : null}
      <button
        type="button"
        aria-label={`Close ${props.title}`}
        onClick={(event) => {
          event.stopPropagation();
          props.onClose(props.threadKey);
        }}
        className="flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 hover:bg-foreground/10 hover:text-foreground group-hover/tab:opacity-100 focus-visible:opacity-100 group-data-[active=true]/tab:opacity-100"
      >
        <XIcon className="size-3" />
      </button>
    </div>
  );
});

/** The open-thread strip above the chat. Hidden until a second thread has been opened. */
export const OpenThreadTabs = memo(function OpenThreadTabs() {
  const navigate = useNavigate();
  const active = useActiveThreadRef();
  const activeKey = active ? scopedThreadKey(active) : null;
  const tabs = useThreadTabsStore((state) =>
    active ? state.tabsByEnvironmentId[active.environmentId] : undefined,
  );
  const shells = useThreadShells();
  const visited = useUiStateStore((state) => state.threadLastVisitedAtById);
  const scroller = useRef<HTMLDivElement>(null);
  // A custom instance id says nothing about its driver, so the glyph comes from the provider list.
  const providers = useAtomValue(primaryServerProvidersAtom);
  const driverByInstance = useMemo(
    () =>
      new Map(
        providers.map((provider) => [provider.instanceId as string, provider.driver as string]),
      ),
    [providers],
  );

  const byKey = useMemo(
    () =>
      new Map(
        shells.map((shell) => [
          scopedThreadKey({ environmentId: shell.environmentId, threadId: shell.id }),
          shell,
        ]),
      ),
    [shells],
  );

  // Keep the active tab in view when the strip overflows; the deps are the triggers, not reads.
  useEffect(() => {
    scroller.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeKey, tabs]);

  if (!active || !tabs || tabs.length < 2) return null;

  const select = (key: string) => {
    const ref = parseScopedThreadKey(key);
    if (ref) {
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: ref.environmentId, threadId: ref.threadId },
      });
    }
  };
  const close = (key: string) => {
    const next = useThreadTabsStore.getState().close(active.environmentId, key, activeKey);
    if (key !== activeKey) return;
    if (next) select(next);
    else void navigate({ to: "/" });
  };

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
        "flex h-9 shrink-0 items-center gap-1 overflow-x-auto bg-background px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
      )}
    >
      {tabs.map((key) => {
        const shell = byKey.get(key);
        if (!shell) return null;
        const status = resolveSidebarThreadStatus(shell);
        return (
          <TabItem
            key={key}
            threadKey={key}
            title={shell.title}
            driverKind={driverByInstance.get(shell.modelSelection.instanceId) ?? null}
            running={status === "working"}
            unread={hasUnseenCompletion({ ...shell, lastVisitedAt: visited[key] })}
            active={key === activeKey}
            onSelect={select}
            onClose={close}
          />
        );
      })}
    </div>
  );
});
