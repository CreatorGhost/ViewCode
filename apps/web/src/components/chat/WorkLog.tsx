import type {
  WorkLogChip,
  WorkLogChipSet,
  WorkLogMarkerKind,
} from "@t3tools/client-runtime/work-log/thinking-log";
import { workLogLabelTone } from "@t3tools/client-runtime/work-log/thinking-log";
import { GlobeIcon, SearchIcon, XIcon } from "lucide-react";
import {
  createContext,
  use,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
} from "react";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PierreEntryIcon } from "./PierreEntryIcon";
import {
  advanceChipArrivals,
  BRANCH_OFFSET,
  initialChipArrivals,
  RAIL_X,
  workLogRailSegments,
  type WorkLogLane,
  type WorkLogRailEnds,
} from "./WorkLog.logic";

const GroupedRows = createContext(false);

const RailCtx = createContext<WorkLogRailEnds | null>(null);

/** Overrides the rail ends for rows that share one timeline item, such as an expanded group. */
export function WorkLogRail({ ends, children }: { ends: WorkLogRailEnds; children: ReactNode }) {
  return <RailCtx value={ends}>{children}</RailCtx>;
}

export function useWorkLogRailEnds(): WorkLogRailEnds {
  return use(RailCtx) ?? NO_RAIL;
}

const NO_RAIL: WorkLogRailEnds = { above: false, below: false };

/** Groups may span virtualized timeline items. Each part owns its trailing space. */
export function WorkLogBlock({
  layout = "standalone",
  continues = false,
  follows = false,
  children,
}: {
  layout?: "standalone" | "group-header" | "group-content";
  continues?: boolean | undefined;
  follows?: boolean | undefined;
  children: ReactNode;
}) {
  return (
    <div
      className={
        continues || layout === "group-header"
          ? "pb-0"
          : layout === "group-content"
            ? "pb-1"
            : "pb-2"
      }
    >
      <RailCtx
        value={{
          above: follows || layout === "group-content",
          below: continues || layout === "group-header",
        }}
      >
        {children}
      </RailCtx>
    </div>
  );
}

export function WorkLogList({ children }: { children: ReactNode }) {
  return (
    <GroupedRows value>
      <div className="flex min-w-0 flex-col">{children}</div>
    </GroupedRows>
  );
}

type RowContent = {
  /** The rail marker. Rows with a special state (an error, a warning) pass `icon` instead. */
  marker?: WorkLogMarkerKind | undefined;
  icon?: ReactNode;
  label: ReactNode;
  trailing?: ReactNode;
  wrapLabel?: boolean;
  /** Branch rows (subagents, dead ends) sit on a short lane off the main rail. */
  lane?: WorkLogLane | undefined;
  /** The step is running now. A row that mounts live softens in, and its label settles when it
   * finishes; history that mounts already finished (loading, scrolling) stays still. */
  live?: boolean | undefined;
};

function useLiveMotion(live: boolean) {
  const [arrived] = useState(live);
  const [motion, setMotion] = useState({ live, settles: 0 });
  if (motion.live !== live) {
    setMotion({ live, settles: live ? motion.settles : motion.settles + 1 });
  }
  return { arrived, settles: motion.settles };
}

/** Half the gap the rail leaves around each marker, so the line stops short of it. */
const MARKER_CLEARANCE: Record<WorkLogMarkerKind, number> = {
  dot: 6,
  search: 10,
  "dead-end": 8,
  live: 10,
  merged: 8,
  finish: 11,
};

function WorkLogRailLines(props: Parameters<typeof workLogRailSegments>[0]) {
  return workLogRailSegments(props).map((segment) => {
    const box = {
      left: segment.left,
      top: segment.top,
      ...(segment.height === null ? { bottom: 0 } : { height: segment.height }),
    };
    if (segment.shape === "curve") {
      const height = segment.height ?? 0;
      return (
        <svg
          key={segment.part}
          aria-hidden
          data-work-rail={segment.part}
          className="pointer-events-none absolute overflow-visible text-border"
          style={{ ...box, width: BRANCH_OFFSET + 1 }}
          viewBox={`0 0 ${BRANCH_OFFSET + 1} ${height}`}
          fill="none"
        >
          <path
            d={`M0.5 0C0.5 ${height * 0.55} ${BRANCH_OFFSET + 0.5} ${height * 0.35} ${BRANCH_OFFSET + 0.5} ${height}`}
            stroke="currentColor"
          />
        </svg>
      );
    }
    return (
      <span
        key={segment.part}
        aria-hidden
        data-work-rail={segment.part}
        className="pointer-events-none absolute w-px bg-border"
        style={box}
      />
    );
  });
}

const SPINNER_ARC = "M7.5 1.25a6.25 6.25 0 0 1 0 12.5";

/** The rail markers of the thinking log. Decorative: the row label carries the meaning. */
export function WorkLogMarker({
  kind,
  accent = true,
  fresh = false,
}: {
  kind: WorkLogMarkerKind;
  /** The finish dot is the accent only on the latest turn, so history stays quiet. */
  accent?: boolean;
  /** Finished just now: the dot pops, then its check draws in. */
  fresh?: boolean;
}) {
  switch (kind) {
    case "dot":
      return <span aria-hidden className="block size-1.5 rounded-full bg-icon-muted/55" />;
    case "search":
      return <SearchIcon aria-hidden className="size-3.5 text-icon-muted" strokeWidth={2} />;
    case "dead-end":
      return <XIcon aria-hidden className="size-3 text-icon-muted/70" strokeWidth={2} />;
    case "merged":
      return (
        <svg aria-hidden className="size-2.5 text-icon-muted" viewBox="0 0 10 10" fill="none">
          <circle cx="5" cy="5" r="4.25" stroke="currentColor" strokeWidth={1.5} />
        </svg>
      );
    case "live":
      return (
        <span aria-hidden className="relative block size-[15px] text-foreground">
          <span className="absolute inset-[4.5px] rounded-full bg-current" />
          <svg
            className="work-log-spinner absolute inset-0 size-[15px]"
            viewBox="0 0 15 15"
            fill="none"
          >
            <path d={SPINNER_ARC} stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
          </svg>
        </span>
      );
    case "finish":
      return (
        <span
          aria-hidden
          data-work-finish={fresh ? "" : undefined}
          className={cn(
            "flex size-[15px] items-center justify-center rounded-full ring-2 ring-background",
            accent ? "bg-info text-white" : "bg-icon-muted/45 text-background",
          )}
        >
          <svg className="size-[9px]" viewBox="0 0 10 10" fill="none">
            <path
              className="work-finish-check"
              d="M2 5.2 4.1 7.3 8 3"
              pathLength={1}
              stroke="currentColor"
              strokeWidth={1.6}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      );
  }
}

const LABEL_TONE_CLASS = {
  active: "text-foreground",
  done: "text-secondary-label",
  dim: "text-secondary-label/60",
} as const;

function WorkLogLine({
  marker,
  icon,
  label,
  trailing,
  wrapLabel,
  lane = "main",
  settles = 0,
}: Omit<RowContent, "live"> & { settles?: number }) {
  const tone = marker ? workLogLabelTone(marker) : "done";
  const branch = lane !== "main";
  const glyph = icon ?? (marker ? <WorkLogMarker kind={marker} /> : null);
  return (
    <div
      className={cn(
        "flex min-h-6 min-w-0 gap-2.5 text-sm leading-relaxed select-none [&_*]:select-none",
        wrapLabel ? "items-start" : "items-center",
      )}
    >
      <div className="flex min-w-0 flex-1 items-baseline gap-2.5">
        {glyph ? (
          <span className="relative w-6 shrink-0 leading-0">
            <span
              className={cn(
                "inline-block size-6 align-[calc(0.5cap_-_0.75rem)]",
                // A branch marker sits on its lane, past the slot's right half.
                branch ? "overflow-visible" : "overflow-hidden",
              )}
            >
              <span
                className={cn(
                  "flex size-full items-center justify-center",
                  branch && "translate-x-3",
                )}
              >
                {glyph}
              </span>
            </span>
          </span>
        ) : null}
        <div
          key={settles}
          className={cn(
            "min-w-0 flex-1",
            LABEL_TONE_CLASS[branch && tone === "done" ? "dim" : tone],
            !wrapLabel && "truncate [&_*]:whitespace-nowrap",
          )}
          data-work-label-settle={settles > 0 ? "" : undefined}
        >
          {label}
        </div>
      </div>
      {trailing}
    </div>
  );
}

const interactionClassName =
  "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70";

function useRowLayout(
  interactive: boolean,
  marker: WorkLogMarkerKind | undefined,
  lane: WorkLogLane,
) {
  const grouped = use(GroupedRows);
  const ends = useWorkLogRailEnds();
  return {
    className: cn(
      "group/timeline-row relative w-full min-w-0 rounded-md px-0.5 text-left transition-colors",
      grouped ? "py-0" : "py-0.5",
      interactive && interactionClassName,
    ),
    rail: (
      <WorkLogRailLines
        ends={ends}
        markerY={(grouped ? 0 : 2) + 12}
        clearance={marker ? MARKER_CLEARANCE[marker] : 10}
        lane={lane}
      />
    ),
  };
}

/** Div-based disclosure supports selectable detail and nested actions in an entry. */
export function WorkLogRow({
  marker,
  icon,
  label,
  trailing,
  wrapLabel = false,
  lane = "main",
  live = false,
  children,
  ...rowProps
}: RowContent & Omit<ComponentProps<"div">, "className" | "style">) {
  const { className, rail } = useRowLayout(rowProps.onClick !== undefined, marker, lane);
  const { arrived, settles } = useLiveMotion(live);
  return (
    <div {...rowProps} className={className} data-work-row-arrive={arrived ? "" : undefined}>
      {rail}
      <WorkLogLine
        marker={marker}
        icon={icon}
        label={label}
        trailing={trailing}
        wrapLabel={wrapLabel}
        lane={lane}
        settles={settles}
      />
      {children}
    </div>
  );
}

const CHIP_STAGGER_MS = 110;

/**
 * The files and pages a step touched. Chips that arrive while the step is live stagger in;
 * chips of finished steps mount still.
 */
export function WorkLogChips({
  chips: set,
  live = false,
  standalone = false,
  theme,
  onOpenFile,
}: {
  chips: WorkLogChipSet;
  live?: boolean | undefined;
  /** Rendered after a row rather than inside it, so the chips carry the rail and the row's
   * inset themselves. */
  standalone?: boolean | undefined;
  theme: "light" | "dark";
  onOpenFile?: ((path: string) => void) | undefined;
}) {
  const keys = set.chips.map((chip) => chip.key);
  const [arrivals, setArrivals] = useState(() => initialChipArrivals(keys, live));
  const nextArrivals = advanceChipArrivals(arrivals, keys, live);
  if (nextArrivals !== arrivals) setArrivals(nextArrivals);
  if (set.chips.length === 0) return null;
  return (
    <div className={cn("relative pt-0.5 pb-1.5", standalone ? "ps-9 pe-0.5" : "ps-8.5")}>
      {standalone ? <WorkLogRailThrough /> : null}
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {set.chips.map((chip) => (
          <WorkLogChipView
            key={chip.key}
            chip={chip}
            theme={theme}
            arriveIndex={nextArrivals.fresh.indexOf(chip.key)}
            onOpenFile={onOpenFile}
          />
        ))}
        {set.moreCount > 0 ? (
          <span className="px-1 text-xs text-muted-foreground tabular-nums">
            +{set.moreCount} more
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** The rail running past content that is not a step, such as chips or expanded cards. */
export function WorkLogRailThrough() {
  const ends = useWorkLogRailEnds();
  return ends.below ? (
    <span
      aria-hidden
      data-work-rail="below"
      className="pointer-events-none absolute inset-y-0 w-px bg-border"
      style={{ left: RAIL_X }}
    />
  ) : null;
}

const chipClassName =
  "inline-flex h-6 max-w-56 min-w-0 shrink-0 items-center gap-1.5 rounded-full bg-accent/55 px-2.5 text-xs text-secondary-label ring-1 ring-border/50 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70";

function WorkLogChipView({
  chip,
  theme,
  arriveIndex,
  onOpenFile,
}: {
  chip: WorkLogChip;
  theme: "light" | "dark";
  arriveIndex: number;
  onOpenFile?: ((path: string) => void) | undefined;
}) {
  const [arrive] = useState(arriveIndex);
  const motion =
    arrive >= 0
      ? {
          "data-work-chip-arrive": "",
          style: { "--work-chip-delay": `${arrive * CHIP_STAGGER_MS}ms` } as CSSProperties,
        }
      : {};
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
  const trigger =
    chip.kind === "web" ? (
      chip.url ? (
        <a
          {...motion}
          href={chip.url}
          target="_blank"
          rel="noreferrer"
          className={chipClassName}
          onClick={stop}
          onKeyDown={stop}
        />
      ) : (
        <span {...motion} className={chipClassName} />
      )
    ) : (
      <button
        {...motion}
        type="button"
        aria-label={`Open ${chip.path}`}
        disabled={onOpenFile === undefined}
        className={cn(chipClassName, "cursor-pointer disabled:cursor-default")}
        onClick={(event) => {
          event.stopPropagation();
          onOpenFile?.(chip.path);
        }}
        onKeyDown={stop}
      />
    );
  return (
    <Tooltip>
      <TooltipTrigger delay={300} render={trigger}>
        {chip.kind === "web" ? (
          <GlobeIcon aria-hidden className="size-3.5 shrink-0 text-icon-muted" />
        ) : (
          <PierreEntryIcon pathValue={chip.path} kind="file" theme={theme} className="size-3.5" />
        )}
        <span className="min-w-0 truncate">{chip.kind === "web" ? chip.label : chip.name}</span>
      </TooltipTrigger>
      <TooltipPopup>{chip.kind === "web" ? (chip.url ?? chip.label) : chip.path}</TooltipPopup>
    </Tooltip>
  );
}

const LIVE_EDGE_PX = 4;

export function WorkLogDetails({
  children,
  kind = "text",
  followLive = false,
}: {
  children: ReactNode;
  kind?: "text" | "panel" | "media";

  followLive?: boolean;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const atLiveEdgeRef = useRef(true);
  // No deps: each streamed chunk re-renders this, and pinning before paint
  // shows the new text without a visible jump.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (followLive && atLiveEdgeRef.current && scroller) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  });
  return (
    <div
      ref={scrollerRef}
      onScroll={(event) => {
        const { scrollHeight, scrollTop, clientHeight } = event.currentTarget;
        atLiveEdgeRef.current = scrollHeight - scrollTop - clientHeight <= LIVE_EDGE_PX;
      }}
      className={cn(
        "cursor-auto",
        // Details hang under the label, clear of the rail.
        kind === "text"
          ? "ms-8.5 flex max-h-96 flex-col gap-3 overflow-auto px-0.5 py-1 select-text"
          : kind === "panel"
            ? "ms-8.5 mt-0.5 mb-1.5 pb-2"
            : "ms-8.5 mt-1",
      )}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {children}
    </div>
  );
}
