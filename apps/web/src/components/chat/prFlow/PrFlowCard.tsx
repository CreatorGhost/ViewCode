import { ChevronDownIcon, ChevronUpIcon, MinusIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { createContext, type CSSProperties, type ReactNode, use, useEffect, useState } from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { useNowMinute } from "~/hooks/useNowMinute";
import { formatRelativeElapsed } from "~/timestampFormat";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";
import { cn } from "~/lib/utils";
import { GitHubIcon, GitLabIcon } from "../../Icons";
import { PullRequestGlyph } from "../../pullRequest/pullRequestIcons";
import { BlurSwap } from "../../ui/blur-swap";
import { Button } from "../../ui/button";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "../../ui/preview-card";
import { Spinner } from "../../ui/spinner";
import { ActivityShimmerOverlay } from "../ActivityShimmerOverlay";
import {
  GRAPH_WIDTH,
  type GraphNode,
  type GraphSegment,
  LANE_X,
  ROW_HEIGHT,
  layoutGraph,
} from "./prFlowGraph";
import {
  formatCheckDuration,
  type PrFlow,
  type PrFlowCheck,
  type PrFlowConflicts,
  type PrFlowRow,
  type PrFlowStatus,
  prFlowReached,
  prFlowStatus,
} from "./prFlowModel";

export interface PrFlowCardActions {
  readonly onResolveConflicts?: (() => void) | undefined;
  readonly onMerge?: (() => void) | undefined;
  /** Opens a URL: the pull request, or a check's details. */
  readonly onOpen?: ((url: string) => void) | undefined;
}

/**
 * Whether the card's live states shine. Only the thread's current pull request is live; an older
 * one the reader expanded shows the same states still.
 */
const PrFlowLiveContext = createContext(true);

/**
 * A pull request in the chat, from the first commit to merged: its commits on a small graph
 * against the base, its checks, and one footer line with what is happening and the next action.
 * `compact` keeps the header and the footer, for the Review panel and old merges.
 */
export function PrFlowCard({
  flow,
  compact = false,
  live = true,
  appear = false,
  onCollapse,
  onResolveConflicts,
  onMerge,
  onOpen,
}: {
  flow: PrFlow;
  compact?: boolean;
  live?: boolean;
  /**
   * The card is news: it opens in and its rows arrive one after another, as rows that come later
   * do. For a pull request the conversation just got, which otherwise mounted as a hard cut.
   */
  appear?: boolean;
  /** Folds the card to its one line (PrFlowCollapsedRow). */
  onCollapse?: (() => void) | undefined;
} & PrFlowCardActions) {
  const status = prFlowStatus(flow);
  const showChecks =
    !compact &&
    flow.checks !== null &&
    flow.checks.list.length > 0 &&
    prFlowReached(flow.phase, "testing");
  return (
    <PrFlowLiveContext value={live}>
      <div
        className={cn(
          "flex flex-col gap-1.5 rounded-xl border bg-card p-3 text-sm",
          appear && "pr-flow-appear",
        )}
      >
        <PrFlowHeader flow={flow} onCollapse={onCollapse} />
        {compact || flow.rows.length === 0 ? null : (
          <PrFlowRows flow={flow} status={status} appear={appear} />
        )}
        {showChecks && flow.checks ? (
          <PrFlowCheckChips checks={flow.checks.list} onOpen={onOpen} />
        ) : null}
        <PrFlowFooter
          flow={flow}
          status={status}
          onResolveConflicts={onResolveConflicts}
          onMerge={onMerge}
          onOpen={onOpen}
        />
      </div>
    </PrFlowLiveContext>
  );
}

function PrFlowHeader({
  flow,
  onCollapse,
}: {
  flow: PrFlow;
  onCollapse?: (() => void) | undefined;
}) {
  const state =
    flow.number === null
      ? null
      : flow.phase === "merged"
        ? "merged"
        : flow.draft
          ? "draft"
          : "open";
  return (
    <div className="flex items-baseline gap-2 px-0.5">
      <span className="min-w-0 truncate font-medium">
        {flow.title}
        {flow.number === null ? null : (
          <span className="font-normal text-muted-foreground"> #{flow.number}</span>
        )}
      </span>
      {state === null ? null : (
        <BlurSwap
          swapKey={state}
          render={
            <span
              className={cn(
                "ml-auto flex shrink-0 items-center gap-1.5 text-xs",
                state === "merged"
                  ? "text-branch"
                  : state === "draft"
                    ? "text-muted-foreground"
                    : "text-success-foreground",
              )}
            />
          }
        >
          <span
            aria-hidden
            className={cn(
              "size-1.5 rounded-full",
              state === "merged"
                ? "bg-branch"
                : state === "draft"
                  ? "bg-muted-foreground"
                  : "bg-success",
            )}
          />
          {state === "merged" ? "Merged" : state === "draft" ? "Draft" : "Open"}
        </BlurSwap>
      )}
      {onCollapse === undefined ? null : (
        <Button
          size="icon-micro"
          variant="ghost-muted"
          aria-label="Collapse the pull request card"
          className={state === null ? "ml-auto self-center" : "self-center"}
          onClick={onCollapse}
        >
          <ChevronUpIcon />
        </Button>
      )}
    </div>
  );
}

const LANE_TONE = {
  head: "text-info",
  base: "text-muted-foreground/45",
  side: "text-success",
} as const;

const REF_TONE = {
  head: "bg-info/10 text-info-foreground",
  base: "bg-muted text-muted-foreground",
  side: "bg-success/10 text-success-foreground",
} as const;

function PrFlowRows({
  flow,
  status,
  appear,
}: {
  flow: PrFlow;
  status: PrFlowStatus;
  appear: boolean;
}) {
  // Rows here when the card first drew stay still; rows that arrive later open in. A card that
  // is itself news treats every row as arriving.
  const [initialKeys] = useState(() => new Set(appear ? [] : flow.rows.map((row) => row.key)));
  const nowMs = Date.parse(useNowMinute());
  const merged = flow.phase === "merged";
  const conflictPhase = flow.phase === "conflicts" || flow.phase === "resolving";
  const headTip = flow.rows.find((row) => row.kind === "merging" || row.lane === "head");
  const baseTip = flow.rows.find((row) => row.kind === "commit" && row.lane === "base");
  const nodeSha = (row: PrFlowRow) => (row.kind === "merging" ? "merging" : row.sha);
  const nodes: ReadonlyArray<GraphNode> = [
    {
      key: "target",
      sha: null,
      lane: "base",
      parents: [headTip, baseTip].flatMap((row) => (row === undefined ? [] : [nodeSha(row)])),
      pending: !merged,
    },
    ...flow.rows.map((row): GraphNode => ({
      key: row.key,
      sha: nodeSha(row),
      lane: row.kind === "merging" ? "head" : row.lane,
      parents: row.parents,
      pending: row.kind === "merging",
    })),
  ];
  const segments = layoutGraph(nodes);
  const targetTone = merged
    ? "text-branch"
    : conflictPhase && status.tone !== "busy"
      ? "text-warning"
      : undefined;
  const segmentTone = (segment: GraphSegment) =>
    segment.target && targetTone !== undefined
      ? targetTone
      : merged && segment.lane === "head"
        ? "text-branch"
        : LANE_TONE[segment.lane];
  const base = flow.base ?? "base";

  return (
    <div className={cn("flex flex-col", merged && "pr-flow-wave")}>
      <PrFlowRowFrame
        index={0}
        segments={segments[0] ?? []}
        segmentTone={segmentTone}
        node={<TargetNode flow={flow} />}
      >
        <span className="min-w-0 truncate text-muted-foreground">
          {merged ? `Merged into ${base}` : `Merge into ${base}`}
        </span>
        <BlurSwap
          swapKey={status.target}
          render={
            <span
              className={cn(
                "ml-auto shrink-0 text-xs",
                status.tone === "warning"
                  ? "text-warning-foreground"
                  : status.tone === "merged"
                    ? "text-branch"
                    : status.target === "resolved" || status.tone === "success"
                      ? "text-success-foreground"
                      : "text-muted-foreground",
              )}
            />
          }
        >
          {status.target}
        </BlurSwap>
      </PrFlowRowFrame>
      {flow.rows.map((row, rowIndex) => (
        <PrFlowRowFrame
          key={row.key}
          index={rowIndex + 1}
          arriving={!initialKeys.has(row.key)}
          segments={segments[rowIndex + 1] ?? []}
          segmentTone={segmentTone}
          highlight={merged && row.kind === "commit" && row.lane === "head"}
          node={<RowNode row={row} flow={flow} />}
        >
          {row.kind === "merging" ? (
            <MergingRowContent row={row} head={flow.head} />
          ) : (
            <CommitRowContent row={row} flow={flow} nowMs={nowMs} />
          )}
        </PrFlowRowFrame>
      ))}
    </div>
  );
}

function PrFlowRowFrame({
  index,
  arriving = false,
  highlight = false,
  segments,
  segmentTone,
  node,
  children,
}: {
  index: number;
  arriving?: boolean;
  highlight?: boolean;
  segments: ReadonlyArray<GraphSegment>;
  segmentTone: (segment: GraphSegment) => string;
  node: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className={arriving ? "pr-flow-open" : undefined}
      style={{ "--pr-row": index } as CSSProperties}
    >
      <div>
        <div
          className={cn(
            "relative flex h-7 items-center gap-2 rounded-md pr-1",
            highlight && "bg-branch/10",
          )}
        >
          <svg
            aria-hidden
            width={GRAPH_WIDTH}
            height={ROW_HEIGHT}
            viewBox={`0 0 ${GRAPH_WIDTH} ${ROW_HEIGHT}`}
            className="shrink-0 overflow-visible"
            fill="none"
          >
            {segments.map((segment) => (
              <path
                key={`${segment.d}${segment.lane}`}
                d={segment.d}
                className={segmentTone(segment)}
                stroke="currentColor"
                strokeWidth={1.5}
                strokeDasharray={segment.dashed ? "2 3" : undefined}
              />
            ))}
            {node}
          </svg>
          {children}
        </div>
      </div>
    </div>
  );
}

const MID = ROW_HEIGHT / 2;

function TargetNode({ flow }: { flow: PrFlow }) {
  const x = LANE_X.base;
  if (flow.phase === "merged") {
    return <circle cx={x} cy={MID} r={5.5} className="fill-branch" />;
  }
  if (flow.phase === "conflicts") {
    return (
      <g className="text-warning">
        <circle cx={x} cy={MID} r={6} fill="currentColor" />
        <path
          d={`M${x} ${MID - 3}v3.4M${x} ${MID + 2.6}v.1`}
          className="stroke-background"
          strokeWidth={1.6}
          strokeLinecap="round"
        />
      </g>
    );
  }
  return (
    <circle
      cx={x}
      cy={MID}
      r={4.5}
      className="fill-card text-muted-foreground/60"
      stroke="currentColor"
      strokeWidth={1.5}
    />
  );
}

function RowNode({ row, flow }: { row: PrFlowRow; flow: PrFlow }) {
  if (row.kind === "merging") {
    const x = LANE_X.head;
    return (
      <g className="text-info">
        <circle
          cx={x}
          cy={MID}
          r={4.5}
          className="fill-card"
          stroke="currentColor"
          strokeWidth={1.5}
        />
        <circle cx={x} cy={MID} r={1.6} fill="currentColor" />
      </g>
    );
  }
  const conflicting =
    row.conflicts > 0 &&
    !row.resolved &&
    (flow.phase === "conflicts" || flow.phase === "resolving");
  const tone = conflicting
    ? "text-warning"
    : flow.phase === "merged" && row.lane === "head"
      ? "text-branch"
      : LANE_TONE[row.lane];
  return (
    <circle
      cx={LANE_X[row.lane]}
      cy={MID}
      r={row.lane === "head" ? 4 : 3.5}
      className={tone}
      fill="currentColor"
    />
  );
}

function CommitRowContent({
  row,
  flow,
  nowMs,
}: {
  row: Extract<PrFlowRow, { kind: "commit" }>;
  flow: PrFlow;
  nowMs: number;
}) {
  const conflictPhase = flow.phase === "conflicts" || flow.phase === "resolving";
  const conflicting = conflictPhase && row.conflicts > 0 && !row.resolved;
  const merged = flow.phase === "merged" && row.lane === "head";
  const live = use(PrFlowLiveContext);
  const age = formatRelativeElapsed(Math.max(0, nowMs - Date.parse(row.authoredAt)));
  return (
    <>
      <span
        className={cn(
          "min-w-0 truncate",
          conflicting
            ? "text-warning-foreground"
            : row.lane === "head"
              ? "text-foreground"
              : "text-muted-foreground",
        )}
      >
        {row.subject}
      </span>
      {row.refs.slice(0, 2).map((ref) => (
        <span
          key={ref}
          className={cn(
            "max-w-40 shrink-0 truncate rounded px-1.5 font-mono text-2xs leading-5",
            merged ? "bg-branch/10 text-branch" : REF_TONE[row.lane],
          )}
        >
          {ref}
        </span>
      ))}
      {conflicting ? (
        <span
          key="conflicts"
          ref={live ? observeVisibleAnimation : undefined}
          className={cn(
            live && "pr-flow-glow pr-flow-glow-badge",
            "blur-swap flex size-4.5 shrink-0 items-center justify-center rounded-full border border-warning/50 bg-warning-surface text-2xs text-warning-foreground tabular-nums",
          )}
        >
          {row.conflicts}
        </span>
      ) : row.resolved && conflictPhase ? (
        <DrawnCheck key="resolved" className="size-4.5 shrink-0 text-success" ring />
      ) : null}
      <span className="ml-auto shrink-0 pl-2 font-mono text-2xs text-muted-foreground">
        {row.sha.slice(0, 7)}
      </span>
      <span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground">
        {row.author} · {age.value === "just now" ? "now" : age.value}
      </span>
    </>
  );
}

function MergingRowContent({
  row,
  head,
}: {
  row: Extract<PrFlowRow, { kind: "merging" }>;
  head: string;
}) {
  const live = use(PrFlowLiveContext);
  return (
    <>
      <ShimmerLabel live={live} text={row.subject}>
        <span className="block truncate text-muted-foreground">{row.subject}</span>
      </ShimmerLabel>
      <span
        className={cn(
          "max-w-40 shrink-0 truncate rounded px-1.5 font-mono text-2xs leading-5",
          REF_TONE.head,
        )}
      >
        {head}
      </span>
      <BlurSwap
        swapKey={`${row.done}/${row.total}`}
        render={<span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums" />}
      >
        {row.done}/{row.total}
      </BlurSwap>
      <span
        aria-hidden
        className="absolute right-1 bottom-0 h-0.5 overflow-hidden rounded-full bg-muted"
        style={{ left: GRAPH_WIDTH + 8 }}
      >
        <span
          ref={live ? observeVisibleAnimation : undefined}
          className={cn(
            "pr-flow-progress block h-full origin-left bg-success",
            live && "pr-flow-bar-shine",
          )}
          style={{ transform: `scaleX(${row.total === 0 ? 0 : row.done / row.total})` }}
        />
      </span>
    </>
  );
}

/** A check that draws itself (DrawMark): the stroke runs from 1 to 0 dash offset. */
function DrawnCheck({ className, ring = false }: { className?: string; ring?: boolean }) {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className={className} fill="none">
      {ring ? (
        <circle
          cx="8"
          cy="8"
          r="7"
          className="pr-flow-fade-in"
          fill="currentColor"
          fillOpacity={0.14}
        />
      ) : null}
      <path
        className="pr-flow-draw"
        pathLength={1}
        d="M5 8.3l2 2 4-4.4"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckIcon({ check }: { check: PrFlowCheck }) {
  switch (check.state) {
    case "passed":
      return <DrawnCheck className="size-3.5 shrink-0 text-success" />;
    case "failed":
      return <XIcon aria-hidden className="size-3.5 shrink-0 text-destructive-foreground" />;
    case "skipped":
      return <MinusIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />;
    case "running":
      return <Spinner size="xs" tone="muted" />;
  }
}

function PrFlowCheckChips({
  checks,
  onOpen,
}: {
  checks: ReadonlyArray<PrFlowCheck>;
  onOpen?: ((url: string) => void) | undefined;
}) {
  return (
    <div className="flex flex-wrap gap-1.5 pt-1 pl-0.5">
      {checks.map((check, index) => (
        // Keyed by name: a check that finishes swaps its icon and word in place.
        <PreviewCard key={check.name}>
          <PreviewCardTrigger
            render={
              <span
                className={cn(
                  "blur-swap flex h-6 cursor-default items-center gap-1.5 rounded-full border px-2 text-xs",
                  check.state === "failed" && "border-destructive/40",
                )}
                style={{ animationDelay: `${index * 100}ms` }}
              />
            }
          >
            <CheckIcon key={check.state} check={check} />
            <ShimmerLabel live={check.state === "running"} text={check.name}>
              <span
                className={cn(
                  "block max-w-40 truncate",
                  check.state === "running" && "text-muted-foreground",
                )}
              >
                {check.name}
              </span>
            </ShimmerLabel>
            <BlurSwap
              swapKey={check.result}
              render={
                <span
                  className={
                    check.state === "failed"
                      ? "text-destructive-foreground"
                      : "text-muted-foreground"
                  }
                />
              }
            >
              {check.result}
            </BlurSwap>
          </PreviewCardTrigger>
          <PreviewCardPopup side="top" align="start">
            <div className="flex max-w-80 items-center gap-3 px-2.5 py-1.5 text-xs">
              <span className="min-w-0">
                {check.name}
                <span className="text-muted-foreground">
                  {" "}
                  · {check.description ?? check.result}
                </span>
              </span>
              {check.durationMs === null ? null : (
                <span className="shrink-0 text-muted-foreground tabular-nums">
                  {formatCheckDuration(check.durationMs)}
                </span>
              )}
              {check.url === null || onOpen === undefined ? null : (
                <Button size="micro" variant="ghost-muted" onClick={() => onOpen(check.url ?? "")}>
                  Details
                </Button>
              )}
            </div>
          </PreviewCardPopup>
        </PreviewCard>
      ))}
    </div>
  );
}

function ConflictLines({ conflicts, base }: { conflicts: PrFlowConflicts; base: string }) {
  const theirs = [...new Set(conflicts.files.flatMap((file) => file.theirsAuthor ?? []))];
  const shortName = (name: string | null) => name?.split(" ")[0] ?? "";
  return (
    <div className="flex max-h-96 w-96 max-w-full flex-col gap-2 overflow-y-auto p-3 text-xs">
      <p>
        {theirs.length === 1 ? <span className="font-medium">{theirs[0]}</span> : base}{" "}
        <span className="text-muted-foreground">
          changed the same lines{theirs.length === 1 ? ` on ${base}` : " since this branch left it"}
        </span>
      </p>
      {conflicts.files.map((file) =>
        file.hunks.length === 0 ? (
          <p key={file.path} className="border-t pt-2">
            <span className="font-medium">{file.path}</span>{" "}
            <span className="text-muted-foreground">
              {file.count} conflict{file.count === 1 ? "" : "s"}
            </span>
          </p>
        ) : (
          file.hunks.map((hunk) => (
            <div key={`${file.path}:${hunk.line}`} className="flex flex-col gap-1 border-t pt-2">
              <p>
                <span className="font-medium">{file.path}</span>{" "}
                <span className="text-muted-foreground">line {hunk.line}</span>
              </p>
              <HunkSide
                name={shortName(file.theirsAuthor) || base}
                lines={hunk.theirs}
                tone="theirs"
              />
              <HunkSide name={shortName(file.oursAuthor) || "You"} lines={hunk.ours} tone="ours" />
            </div>
          ))
        ),
      )}
    </div>
  );
}

function HunkSide({
  name,
  lines,
  tone,
}: {
  name: string;
  lines: ReadonlyArray<string>;
  tone: "ours" | "theirs";
}) {
  return (
    <div
      className={cn(
        "flex gap-3 border-l-2 py-0.5 pl-2",
        tone === "theirs" ? "border-warning/60" : "border-info/60",
      )}
    >
      <span className="w-10 shrink-0 truncate text-muted-foreground">{name}</span>
      <pre className="min-w-0 overflow-hidden font-mono text-2xs leading-4 whitespace-pre text-ellipsis">
        {lines.length === 0 ? "(removed)" : lines.join("\n")}
      </pre>
    </div>
  );
}

function PrFlowFooter({
  flow,
  status,
  onResolveConflicts,
  onMerge,
  onOpen,
}: { flow: PrFlow; status: PrFlowStatus } & PrFlowCardActions) {
  const base = flow.base ?? "the base";
  const checks = flow.checks;
  const conflicts = flow.conflicts;
  const label =
    flow.phase === "conflicts" && conflicts !== null && conflicts.files.length > 0 ? (
      <>
        <PreviewCard>
          <PreviewCardTrigger
            render={
              <span className="cursor-default text-warning-foreground underline decoration-warning/50 decoration-dotted underline-offset-4" />
            }
          >
            {status.short}
          </PreviewCardTrigger>
          <PreviewCardPopup side="top" align="start">
            <ConflictLines conflicts={conflicts} base={base} />
          </PreviewCardPopup>
        </PreviewCard>
        <span className="text-muted-foreground"> with {base}</span>
      </>
    ) : (
      status.label
    );
  // Open conflicts wait on the reader; the rest is work in flight. Both shine until they settle.
  const live = use(PrFlowLiveContext) && (status.tone === "busy" || flow.phase === "conflicts");
  const liveText =
    flow.phase === "conflicts" && conflicts !== null && conflicts.files.length > 0
      ? `${status.short} with ${base}`
      : status.label;
  return (
    <div className="flex min-h-8 items-center gap-2 px-0.5 pt-1">
      <FooterIcon flow={flow} status={status} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <ShimmerLabel
          live={live}
          glow={flow.phase === "conflicts"}
          text={liveText}
          band={flow.phase === "conflicts" ? "pr-flow-warning-band" : undefined}
        >
          <BlurSwap
            swapKey={status.label}
            render={
              <p
                className={cn(
                  "truncate",
                  status.tone === "busy" && "text-muted-foreground",
                  flow.phase === "conflicts" && "text-warning-foreground",
                )}
              />
            }
          >
            {label}
          </BlurSwap>
        </ShimmerLabel>
        {flow.phase === "testing" && checks !== null && checks.total > 0 ? (
          <span
            aria-hidden
            className="block h-0.5 w-56 max-w-full overflow-hidden rounded-full bg-muted"
          >
            <span
              ref={live ? observeVisibleAnimation : undefined}
              className={cn(
                "pr-flow-progress block h-full origin-left bg-success",
                live && "pr-flow-bar-shine",
              )}
              style={{ transform: `scaleX(${checks.done / checks.total})` }}
            />
          </span>
        ) : null}
      </div>
      <BlurSwap swapKey={flow.phase} className="shrink-0">
        <FooterAction
          flow={flow}
          onResolveConflicts={onResolveConflicts}
          onMerge={onMerge}
          onOpen={onOpen}
        />
      </BlurSwap>
    </div>
  );
}

/**
 * A label with the activity shimmer while `live`: the shared moving shine, running only while on
 * screen, and with `glow` a soft amber pulse behind it on the same beat. Settled, it is just the
 * label. `text` is what the shine draws, the label as plain text.
 */
function ShimmerLabel({
  live,
  glow = false,
  text,
  band,
  children,
}: {
  live: boolean;
  glow?: boolean;
  text: string;
  band?: string | undefined;
  children: ReactNode;
}) {
  const cardLive = use(PrFlowLiveContext);
  const shining = live && cardLive;
  return (
    <span
      ref={shining ? observeVisibleAnimation : undefined}
      className={cn("block w-fit max-w-full min-w-0", shining && glow && "pr-flow-glow")}
    >
      <span className="relative block overflow-hidden whitespace-nowrap">
        {children}
        {shining ? <ActivityShimmerOverlay className={band}>{text}</ActivityShimmerOverlay> : null}
      </span>
    </span>
  );
}

function FooterIcon({ flow, status }: { flow: PrFlow; status: PrFlowStatus }) {
  if (status.tone === "busy") return <Spinner size="sm" tone="muted" />;
  if (status.tone === "warning") {
    return <TriangleAlertIcon aria-hidden className="size-4 shrink-0 text-warning" />;
  }
  if (flow.phase === "merged")
    return <PullRequestGlyph.merged aria-hidden className="size-4 shrink-0 text-branch" />;
  return <DrawnCheck key={flow.phase} className="size-4 shrink-0 text-success" />;
}

function hostOf(url: string): { label: string; icon: ReactNode } {
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  })();
  if (host.includes("github")) return { label: "GitHub", icon: <GitHubIcon /> };
  if (host.includes("gitlab")) return { label: "GitLab", icon: <GitLabIcon /> };
  return { label: "Open", icon: null };
}

function FooterAction({
  flow,
  onResolveConflicts,
  onMerge,
  onOpen,
}: { flow: PrFlow } & PrFlowCardActions) {
  switch (flow.phase) {
    case "conflicts":
      return onResolveConflicts === undefined ? null : (
        <Button size="xs" variant="secondary" onClick={onResolveConflicts}>
          Resolve conflicts
        </Button>
      );
    case "resolving":
    case "merging":
      return (
        <Button size="xs" variant="secondary" disabled>
          <Spinner />
          {flow.phase === "resolving" ? "Resolving" : "Merging"}
        </Button>
      );
    case "ready":
      if (!flow.draft && (flow.checks?.failed ?? 0) === 0 && onMerge !== undefined) {
        return (
          <Button size="xs" onClick={onMerge}>
            Merge
          </Button>
        );
      }
      return <OpenButton flow={flow} onOpen={onOpen} />;
    case "merged":
      return <OpenButton flow={flow} onOpen={onOpen} />;
    default:
      return null;
  }
}

function OpenButton({
  flow,
  onOpen,
}: {
  flow: PrFlow;
  onOpen?: ((url: string) => void) | undefined;
}) {
  const url = flow.url;
  if (url === null || onOpen === undefined) return null;
  const host = hostOf(url);
  return (
    <Button size="xs" variant="outline" onClick={() => onOpen(url)}>
      {host.icon}
      {host.label}
    </Button>
  );
}

/**
 * A pull request folded to one line: merged, closed, or folded by the reader. Everything comes
 * from the thread's link snapshot, so it reads nothing and nothing in it moves.
 */
export function PrFlowCollapsedRow({
  number,
  state,
  title,
  base,
  additions,
  deletions,
  url,
  onOpen,
  onExpand,
}: {
  number: number;
  state: "open" | "merged" | "closed";
  title: string;
  base: string | null;
  additions: number | null;
  deletions: number | null;
  url: string;
  onOpen?: ((url: string) => void) | undefined;
  onExpand?: (() => void) | undefined;
}) {
  const presentation =
    state === "merged"
      ? {
          Icon: PullRequestGlyph.merged,
          tone: "text-branch",
          label: `Merged into ${base ?? "base"}`,
        }
      : state === "closed"
        ? { Icon: PullRequestGlyph.closed, tone: "text-muted-foreground", label: "Closed" }
        : { Icon: PullRequestGlyph.pullRequest, tone: "text-success-foreground", label: "Open" };
  const host = hostOf(url);
  return (
    <div className="flex h-10 items-center gap-2 rounded-xl border bg-card ps-3 pe-1.5 text-sm">
      <presentation.Icon aria-hidden className={cn("size-4 shrink-0", presentation.tone)} />
      <span className="shrink-0 font-medium">#{number}</span>
      <span className={cn("shrink-0", presentation.tone)}>{presentation.label}</span>
      <span className="min-w-0 truncate text-muted-foreground">{title}</span>
      {additions === null || deletions === null ? null : (
        <span className="ml-auto shrink-0 font-mono text-xs">
          <span className="text-diff-addition-foreground">+{additions}</span>{" "}
          <span className="text-diff-deletion-foreground">−{deletions}</span>
        </span>
      )}
      {onOpen === undefined ? null : (
        <Button
          size="xs"
          variant="ghost-muted"
          className={additions === null || deletions === null ? "ml-auto" : undefined}
          onClick={() => onOpen(url)}
        >
          {host.icon}
          {host.label}
        </Button>
      )}
      {onExpand === undefined ? null : (
        <Button
          size="icon-micro"
          variant="ghost-muted"
          aria-label="Expand the pull request card"
          onClick={onExpand}
        >
          <ChevronDownIcon />
        </Button>
      )}
    </div>
  );
}

/**
 * Swaps a pull request between its one line and its full card. Folding closes the card on grid
 * rows (1fr to 0fr, never height) and only then unmounts it, so its reads stop; unfolding opens
 * it the same way. A card that starts folded never mounts the full card at all.
 */
const FOLD_FALLBACK_MS = 600;
const afterFold = <T extends { readonly folded: boolean; readonly fullMounted: boolean }>(
  current: T,
): T => (current.folded ? { ...current, fullMounted: false } : current);

export function PrFlowFoldFrame({
  folded,
  collapsed,
  full,
}: {
  folded: boolean;
  collapsed: ReactNode;
  /** Mounted only while unfolded (or folding): an element, so a folded card costs nothing. */
  full: ReactNode;
}) {
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [view, setView] = useState({ folded, fullMounted: !folded, moved: false });
  if (view.folded !== folded) {
    setView({ folded, fullMounted: !folded || !reducedMotion, moved: true });
  }
  const unmountFull = () => setView(afterFold);
  // The fold's transition end unmounts the card; this catches a transition that never ran.
  const closing = view.folded && view.fullMounted;
  useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(() => setView(afterFold), FOLD_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [closing]);
  return (
    <div>
      {folded ? <div className={view.moved ? "blur-swap" : undefined}>{collapsed}</div> : null}
      {view.fullMounted ? (
        <div
          className={cn("pr-flow-fold", !folded && view.moved && "pr-flow-open")}
          data-open={!folded}
          onTransitionEnd={(event) => {
            if (event.target === event.currentTarget) unmountFull();
          }}
        >
          <div>{full}</div>
        </div>
      ) : null}
    </div>
  );
}
