import {
  Activity,
  memo,
  useContext,
  useInsertionEffect,
  useLayoutEffect,
  useState,
  type ComponentProps,
  type ContextType,
  type RefObject,
} from "react";
import { MessagesTimeline } from "./MessagesTimeline";
import { ChatCanvasContext } from "./ChatCanvasContext";
import { ThreadFindTimelineContext } from "./ThreadFindProvider";
import { DismissPopupsOnSuspendContext } from "../ui/use-dismiss-on-suspend";
import { observeResize } from "../../lib/observeResize";

type Props = ComponentProps<typeof MessagesTimeline>;
type Find = ContextType<typeof ThreadFindTimelineContext>;
type Canvas = ContextType<typeof ChatCanvasContext>;
type List = NonNullable<Props["listRef"]["current"]>;
type Restore = NonNullable<NonNullable<Props["cancelPositionRestoreRef"]>["current"]>;
type Reader = NonNullable<NonNullable<Props["findPositionReaderRef"]>["current"]>;
type Lease = object;
type Authority = ReturnType<typeof createAuthority>;
function createAuthority() {
  let current: Lease | null = null;
  let canvasOwner: Lease | null = null;
  return {
    owns: (lease: Lease) => current === lease,
    canClear: (lease: Lease) => current === lease || current === null,
    activate(lease: Lease) {
      current = lease;
    },
    revoke(lease: Lease) {
      if (current === lease) current = null;
    },
    publishCanvas(lease: Lease, canvas: Canvas, node: HTMLElement | null) {
      if (!canvas) return;
      if (
        node !== null
          ? current !== lease
          : (current !== null && current !== lease) || canvasOwner !== lease
      )
        return;
      canvasOwner = node === null ? null : lease;
      canvas.registerTimeline(node);
    },
  };
}
type Snapshot = { props: Props; find: Find; canvas: Canvas };
type Entry = Snapshot & { key: string; lease: Lease };
const MAX_PANES = 3;
function canRetain(entry: Entry) {
  // These components own iframe sessions or controlled operations that require ordinary unmount.
  return !entry.props.timelineEntries.some(
    (item) =>
      item.kind === "proposed-plan" || item.kind === "mcp-app" || item.kind === "html-render",
  );
}

type CallbackKey = {
  [Key in keyof Props]-?: Extract<Props[Key], (...args: never[]) => unknown> extends never
    ? never
    : Key;
}[keyof Props];
// Require every function-valued prop, including optional/mixed unions. Optional
// callbacks are exposed only when present; a guard must not invent a capability.
const callbackKeys = Object.keys({
  onCiteAssistantText: true,
  onCancelWorktreeSetup: true,
  onRetryWorkspacePreparation: true,
  onWorktreeSetupWorkLocally: true,
  onOpenWorktreeSetupTerminal: true,
  onOpenTurnDiff: true,
  onOpenThread: true,
  onForkFromRun: true,
  onRollbackCheckpoint: true,
  onRevertToTurnCount: true,
  onUseArtifactTemplate: true,
  onSendAppMessage: true,
  onRunShellCommand: true,
  onImageExpand: true,
  onFileOpen: true,
  onFileDownload: true,
  onAnchorReady: true,
  onAnchorSizeChanged: true,
  onIsAtEndChange: true,
  onContentOverflowChange: true,
  onToolOutputCollapsedAtEnd: true,
  onManualNavigation: true,
} satisfies Record<CallbackKey, true>) as CallbackKey[];
function inactiveResult(key: CallbackKey) {
  if (key === "onForkFromRun" || key === "onSendAppMessage") return Promise.resolve();
  if (key === "onCiteAssistantText") return false;
  return undefined;
}

function makeCallbacks(owns: () => boolean, read: () => Props): Partial<Props> {
  const guarded: Record<string, unknown> = {};
  for (const key of callbackKeys)
    guarded[key] = (...args: unknown[]) => {
      const callback = read()[key];
      if (!owns() || typeof callback !== "function") return inactiveResult(key);
      // Runtime gating preserves the original call signature at this one boundary.
      return (callback as (...values: unknown[]) => unknown)(...args);
    };
  return guarded as Partial<Props>;
}
function withCallbacks(props: Props, callbacks: Partial<Props>): Props {
  const next: Props = { ...props };
  const fields = next as unknown as Record<string, unknown>;
  for (const key of callbackKeys)
    if (typeof props[key] === "function") fields[key] = callbacks[key];
  return next;
}
function ownedRef<T>(
  local: RefObject<T | null>,
  outer: () => RefObject<T | null> | undefined,
  owns: () => boolean,
  canClear: () => boolean,
): RefObject<T | null> {
  return {
    get current() {
      return local.current;
    },
    set current(value) {
      const previous = local.current;
      local.current = value;
      const target = outer();
      // Inactive/late cleanup cannot clear a different pane's published handle.
      if (target && (value !== null ? owns() : canClear() && target.current === previous))
        target.current = value;
    },
  };
}

function createPaneHandles(
  lease: Lease,
  authority: Authority,
  readEntry: () => Entry,
  list: RefObject<List | null>,
  restore: RefObject<Restore | null>,
  reader: RefObject<Reader | null>,
  canvasNode: RefObject<HTMLElement | null>,
) {
  const owns = () => authority.owns(lease);
  const canClear = () => authority.canClear(lease);
  const read = () => readEntry().props;
  const outerReader = () => readEntry().find?.findPositionReaderRef ?? read().findPositionReaderRef;
  const publishCanvas = (node: HTMLElement | null) => {
    canvasNode.current = node;
    authority.publishCanvas(lease, readEntry().canvas, node);
  };
  return {
    lease,
    owns,
    callbacks: makeCallbacks(owns, read),
    list: ownedRef(list, () => read().listRef, owns, canClear),
    restore: ownedRef(restore, () => read().cancelPositionRestoreRef, owns, canClear),
    reader: ownedRef(reader, outerReader, owns, canClear),
    publishCanvas,
    publish() {
      if (!owns()) return;
      read().listRef.current = list.current;
      const targetRestore = read().cancelPositionRestoreRef;
      if (targetRestore) targetRestore.current = restore.current;
      const targetReader = outerReader();
      if (targetReader) targetReader.current = reader.current;
      publishCanvas(canvasNode.current);
    },
    clear() {
      if (!canClear()) return;
      const targetList = read().listRef;
      if (targetList.current === list.current) targetList.current = null;
      const targetRestore = read().cancelPositionRestoreRef;
      if (targetRestore?.current === restore.current) targetRestore.current = null;
      const targetReader = outerReader();
      if (targetReader?.current === reader.current) targetReader.current = null;
      publishCanvas(null);
    },
  };
}

function createPaneOwner(initial: Entry, authority: Authority) {
  let latest = initial;
  const list: RefObject<List | null> = { current: null };
  const restore: RefObject<Restore | null> = { current: null };
  const reader: RefObject<Reader | null> = { current: null };
  const canvasNode: RefObject<HTMLElement | null> = { current: null };
  return {
    update(entry: Entry) {
      latest = entry;
    },
    forLease: (lease: Lease) =>
      createPaneHandles(lease, authority, () => latest, list, restore, reader, canvasNode),
  };
}
function usePaneHandles(entry: Entry, authority: Authority) {
  const [owner] = useState(() => createPaneOwner(entry, authority));
  useInsertionEffect(() => {
    owner.update(entry);
  }, [owner, entry]);
  const [handles, setHandles] = useState(() => owner.forLease(entry.lease));
  if (handles.lease !== entry.lease) {
    const next = owner.forLease(entry.lease);
    setHandles(next);
    return next;
  }
  return handles;
}

const RecentTimelinePane = memo(function RecentTimelinePane({
  entry,
  authority,
}: {
  entry: Entry;
  authority: Authority;
}) {
  const handles = usePaneHandles(entry, authority);
  useLayoutEffect(() => {
    handles.publish();
    return handles.clear;
  }, [handles]);
  const scopedFind: Find = entry.find
    ? { ...entry.find, findPositionReaderRef: handles.reader }
    : null;
  const canvas: Canvas = entry.canvas
    ? {
        ...entry.canvas,
        registerTimeline: handles.publishCanvas,
        reportPreview: (...args) => {
          if (handles.owns()) entry.canvas?.reportPreview(...args);
        },
        clearPreview: (...args) => {
          if (handles.owns()) entry.canvas?.clearPreview(...args);
        },
        reportDetailsCard: (...args) => {
          if (handles.owns()) entry.canvas?.reportDetailsCard(...args);
        },
      }
    : null;
  const props = withCallbacks(entry.props, handles.callbacks);
  return (
    <DismissPopupsOnSuspendContext value>
      <ChatCanvasContext value={canvas}>
        <ThreadFindTimelineContext value={scopedFind}>
          <div className="flex h-full min-h-0 flex-1 flex-col">
            <MessagesTimeline
              {...props}
              activationKey={entry.lease}
              listRef={handles.list}
              cancelPositionRestoreRef={handles.restore}
              findPositionReaderRef={handles.reader}
              {...(props.historyControls
                ? {
                    historyControls: {
                      ...props.historyControls,
                      onLoadEarlier: (...args) => {
                        if (handles.owns()) props.historyControls?.onLoadEarlier(...args);
                      },
                    },
                  }
                : {})}
              {...(props.loadEarlier
                ? {
                    loadEarlier: {
                      ...props.loadEarlier,
                      onLoadEarlier: () => {
                        if (handles.owns()) props.loadEarlier?.onLoadEarlier();
                      },
                    },
                  }
                : {})}
            />
          </div>
        </ThreadFindTimelineContext>
      </ChatCanvasContext>
    </DismissPopupsOnSuspendContext>
  );
});

function createWidthWatcher(invalidate: () => void) {
  let width: number | null = null;
  return (element: HTMLDivElement | null) => {
    if (!element) return;
    return observeResize(element, ([entry]) => {
      if (!entry) return;
      const next = entry.borderBoxSize[0]?.inlineSize ?? entry.contentRect.width;
      if (width === next) return;
      width = next;
      // Hidden virtualized layouts cannot reconcile a new width until ordinary mount.
      invalidate();
    });
  };
}

/** Current + two recent timelines. ChatView itself, its composer and its commands stay single. */
export function RecentMessagesTimelines(props: Props) {
  const find = useContext(ThreadFindTimelineContext);
  const canvas = useContext(ChatCanvasContext);
  const key = props.displayThreadKey ?? props.routeThreadKey;
  const [authority] = useState(createAuthority);
  const [state, setState] = useState(() => ({
    active: key,
    props,
    find,
    canvas,
    panes: [{ key, lease: {}, props, find, canvas }] as Entry[],
  }));
  const [watchWidth] = useState(() =>
    createWidthWatcher(() => {
      setState((previous) => {
        if (previous.panes.length < 2) return previous;
        return {
          ...previous,
          panes: previous.panes.filter((pane) => pane.key === previous.active),
        };
      });
    }),
  );
  let current = state;
  if (
    state.props !== props ||
    state.find !== find ||
    state.canvas !== canvas ||
    state.active !== key
  ) {
    const previous = state.panes.find((pane) => pane.key === key);
    const selected: Entry = {
      key,
      props,
      find,
      canvas,
      // A new activation revokes old async callbacks, including A→B→A.
      lease: state.active === key && previous ? previous.lease : {},
    };
    current = {
      active: key,
      props,
      find,
      canvas,
      panes: [...state.panes.filter((pane) => pane.key !== key && canRetain(pane)), selected].slice(
        -MAX_PANES,
      ),
    };
    setState(current);
  }
  const selected = current.panes.find((pane) => pane.key === key)!;
  // Commit ownership before child layout effects/ref publication, without mutating refs in render.
  useInsertionEffect(() => {
    authority.activate(selected.lease);
    return () => {
      authority.revoke(selected.lease);
    };
  }, [authority, selected.lease]);
  return (
    <div
      ref={watchWidth}
      className="flex h-full min-h-0 flex-1 flex-col"
      data-recent-timelines-host
    >
      {current.panes.map((entry) => (
        <div
          key={entry.key}
          data-recent-timeline-pane={entry.key}
          hidden={entry.key !== key}
          inert={entry.key !== key}
          aria-hidden={entry.key !== key}
          className={entry.key === key ? "contents" : "hidden"}
        >
          <Activity mode={entry.key === key ? "visible" : "hidden"}>
            <RecentTimelinePane entry={entry} authority={authority} />
          </Activity>
        </div>
      ))}
    </div>
  );
}
