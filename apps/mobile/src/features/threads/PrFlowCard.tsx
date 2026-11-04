import {
  formatCheckDuration,
  type PrFlow,
  type PrFlowCheck,
  type PrFlowConflictFile,
  type PrFlowRow,
  prFlowFooterAction,
  prFlowStatus,
} from "@t3tools/client-runtime/pr-flow";
import {
  GRAPH_WIDTH,
  type GraphSegment,
  LANE_X,
  layoutPrFlowGraph,
  type PrFlowEdgeTone,
  ROW_HEIGHT,
} from "@t3tools/client-runtime/pr-flow-graph";
import { useEffect, useState, type ReactNode } from "react";
import { Alert, Modal, Platform, Pressable, ScrollView, View } from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedProps,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Circle, G, Path } from "react-native-svg";
import { useResolveClassNames } from "uniwind";

import { type AppSymbolName, SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { useControlTheme } from "../../components/ui/useControlTheme";
import { cn } from "../../lib/cn";
import { themeColorToNativeColor, themeColorWithAlpha } from "../../lib/mobileTheme";
import { relativeTime } from "../../lib/time";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";
import { REVIEW_MONO_FONT_FAMILY } from "../review/reviewDiffRendering";

/**
 * Web's PR card (apps/web chat/prFlow/PrFlowCard.tsx) on the phone: the same flow, graph layout
 * and states, drawn natively. Hover becomes a tap: a commit's conflict count and the footer's
 * count open the clashing lines in a sheet, a check opens its details.
 */
export function PrFlowCard(props: {
  readonly flow: PrFlow;
  /** The thread's current pull request: only it plays the conflict node's ripple. */
  readonly live: boolean;
  readonly onCollapse: () => void;
  readonly onOpen: (url: string) => void;
  readonly onMerge: () => void;
  readonly onResolveConflicts: () => void;
}) {
  const { flow } = props;
  const [sheet, setSheet] = useState<ConflictSheetContent | null>(null);
  const showChecks = flow.checks !== null && flow.checks.list.length > 0 && flow.phase !== "merged";
  const base = flow.base ?? "the base";
  return (
    <View className="mb-4 gap-1.5 rounded-lg border border-border bg-card px-3 py-3">
      <PrFlowHeader flow={flow} onOpen={props.onOpen} onCollapse={props.onCollapse} />
      {flow.rows.length === 0 ? null : (
        <PrFlowGraphRows
          flow={flow}
          live={props.live}
          onShowConflicts={(row) =>
            setSheet({
              heading: { strong: row.subject, rest: "clashes with your changes" },
              files: flow.conflicts?.files.filter((file) => file.commit === row.sha) ?? [],
              base,
            })
          }
        />
      )}
      {showChecks && flow.checks ? (
        <PrFlowCheckChips checks={flow.checks.list} onOpen={props.onOpen} />
      ) : null}
      <PrFlowFooter
        flow={flow}
        onShowConflicts={() =>
          setSheet({ heading: null, files: flow.conflicts?.files ?? [], base })
        }
        onOpen={props.onOpen}
        onMerge={props.onMerge}
        onResolveConflicts={props.onResolveConflicts}
      />
      {sheet === null ? null : <ConflictSheet content={sheet} onClose={() => setSheet(null)} />}
    </View>
  );
}

function PrFlowHeader(props: {
  readonly flow: PrFlow;
  readonly onOpen: (url: string) => void;
  readonly onCollapse: () => void;
}) {
  const { flow } = props;
  const state =
    flow.number === null
      ? null
      : flow.phase === "merged"
        ? "merged"
        : flow.draft
          ? "draft"
          : "open";
  const url = flow.url;
  return (
    <View className="flex-row items-center gap-2">
      <Pressable
        accessibilityRole="button"
        accessibilityHint="Opens the pull request."
        disabled={url === null}
        onPress={() => (url === null ? undefined : props.onOpen(url))}
        className="min-w-0 flex-1 active:opacity-70"
      >
        <Text className="text-sm font-t3-medium text-foreground" numberOfLines={1}>
          {flow.title}
          {flow.number === null ? null : (
            <Text className="font-t3-regular text-foreground-muted"> #{flow.number}</Text>
          )}
        </Text>
      </Pressable>
      {state === null ? null : (
        <View className="shrink-0 flex-row items-center gap-1.5">
          <View
            className={cn(
              "size-1.5 rounded-full",
              state === "merged"
                ? "bg-adaptive-violet-600-400"
                : state === "draft"
                  ? "bg-foreground-muted"
                  : "bg-adaptive-emerald-600-400",
            )}
          />
          <Text
            className={cn(
              "text-xs",
              state === "merged"
                ? "text-adaptive-violet-600-400"
                : state === "draft"
                  ? "text-foreground-muted"
                  : "text-adaptive-emerald-600-400",
            )}
          >
            {state === "merged" ? "Merged" : state === "draft" ? "Draft" : "Open"}
          </Text>
        </View>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Fold the pull request card"
        onPress={props.onCollapse}
        hitSlop={8}
        className="min-h-6 justify-center pl-1 active:opacity-70"
      >
        <SymbolView name="chevron.up" size={12} tintColorClassName="accent-icon-muted" />
      </Pressable>
    </View>
  );
}

/** The graph's colours as SVG takes them: React Native does not parse OKLCH. */
function usePrFlowColors() {
  const { colors } = useControlTheme();
  const color = (name: keyof typeof colors) => themeColorToNativeColor(colors[name]);
  // The adaptive palette is stylesheet-only, so it is read through its utility classes.
  const emerald = useResolveClassNames("bg-adaptive-emerald-600-400").backgroundColor;
  const violet = useResolveClassNames("bg-adaptive-violet-600-400").backgroundColor;
  const muted = color("--color-foreground-muted");
  const success = typeof emerald === "string" ? themeColorToNativeColor(emerald) : muted;
  const edges: Record<PrFlowEdgeTone, string> = {
    head: color("--color-primary"),
    base: themeColorWithAlpha(muted, 0.45),
    side: success,
    warning: color("--color-warning-foreground"),
    merged: typeof violet === "string" ? themeColorToNativeColor(violet) : muted,
  };
  return { edges, muted, success, card: color("--color-card") };
}

type PrFlowColors = ReturnType<typeof usePrFlowColors>;

const MID = ROW_HEIGHT / 2;
/** Room left of the base lane for the conflict ripple, which grows past the graph's box. */
const BLEED = 6;

function PrFlowGraphRows(props: {
  readonly flow: PrFlow;
  readonly live: boolean;
  readonly onShowConflicts: (row: Extract<PrFlowRow, { kind: "commit" }>) => void;
}) {
  const { flow } = props;
  const colors = usePrFlowColors();
  const { showTarget, rowOffset, segments, edgeTone } = layoutPrFlowGraph(flow);
  const status = prFlowStatus(flow);
  const merged = flow.phase === "merged";
  const base = flow.base ?? "base";
  return (
    <View>
      {showTarget ? (
        <PrFlowRowFrame
          segments={segments[0] ?? []}
          tone={edgeTone}
          colors={colors}
          node={<TargetNode flow={flow} live={props.live} colors={colors} />}
        >
          <Text className="min-w-0 shrink text-sm text-foreground-muted" numberOfLines={1}>
            {merged ? `Merged into ${base}` : `Merge into ${base}`}
          </Text>
          <Text
            className={cn(
              "ml-auto shrink-0 pl-2 text-xs",
              status.tone === "warning"
                ? "text-warning-foreground"
                : status.tone === "merged"
                  ? "text-adaptive-violet-600-400"
                  : status.target === "resolved" || status.tone === "success"
                    ? "text-adaptive-emerald-600-400"
                    : "text-foreground-muted",
            )}
          >
            {status.target}
          </Text>
        </PrFlowRowFrame>
      ) : null}
      {flow.rows.map((row, index) => (
        <PrFlowRowFrame
          key={row.key}
          segments={segments[index + rowOffset] ?? []}
          tone={edgeTone}
          colors={colors}
          highlight={merged && row.kind === "commit" && row.lane === "head"}
          node={<RowNode row={row} flow={flow} colors={colors} />}
        >
          <RowContent row={row} flow={flow} onShowConflicts={props.onShowConflicts} />
        </PrFlowRowFrame>
      ))}
    </View>
  );
}

function PrFlowRowFrame(props: {
  readonly segments: ReadonlyArray<GraphSegment>;
  readonly tone: (segment: GraphSegment) => PrFlowEdgeTone;
  readonly colors: PrFlowColors;
  readonly node: ReactNode;
  readonly highlight?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <View
      className={cn(
        "h-7 flex-row items-center gap-2 rounded-md pr-1",
        props.highlight && "bg-adaptive-violet-500-a12-a16",
      )}
    >
      <Svg
        width={GRAPH_WIDTH + BLEED}
        height={ROW_HEIGHT}
        style={{ marginLeft: -BLEED, marginRight: -2 }}
      >
        <G x={BLEED}>
          {props.segments.map((segment) => (
            <Path
              key={`${segment.d}${segment.lane}`}
              d={segment.d}
              stroke={props.colors.edges[props.tone(segment)]}
              strokeWidth={1.5}
              strokeDasharray={segment.dashed ? "3.5 3" : undefined}
              fill="none"
            />
          ))}
          {props.node}
        </G>
      </Svg>
      {props.children}
    </View>
  );
}

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
/** The ripple plays a few beats when conflicts appear, then rests: nothing loops on the phone. */
const RIPPLE_BEATS = 3;
const RIPPLE_MS = 1800;

function ConflictRipple(props: { readonly x: number; readonly color: string }) {
  const progress = useSharedValue(0);
  useEffect(() => {
    progress.set(
      withRepeat(
        withTiming(1, { duration: RIPPLE_MS, easing: Easing.linear }),
        RIPPLE_BEATS,
        false,
      ),
    );
    return () => cancelAnimation(progress);
  }, [progress]);
  const animatedProps = useAnimatedProps(() => {
    // A thin ring leaves the node, widens and fades over the first half of each beat.
    const t = Math.min(progress.value / 0.55, 1);
    return {
      r: 6.8 + 5.6 * t,
      strokeOpacity: progress.value < 0.08 ? (progress.value / 0.08) * 0.7 : 0.7 * (1 - t),
    };
  });
  return (
    <AnimatedCircle
      cx={props.x}
      cy={MID}
      fill="none"
      stroke={props.color}
      strokeWidth={1.25}
      animatedProps={animatedProps}
    />
  );
}

function TargetNode(props: {
  readonly flow: PrFlow;
  readonly live: boolean;
  readonly colors: PrFlowColors;
}) {
  const { flow, colors } = props;
  const reducedMotion = useReducedMotion();
  const x = LANE_X.base;
  if (flow.phase === "merged") {
    return <Circle cx={x} cy={MID} r={5.5} fill={colors.edges.merged} />;
  }
  if (flow.phase === "conflicts") {
    return (
      <G>
        {props.live && !reducedMotion ? (
          <ConflictRipple x={x} color={colors.edges.warning} />
        ) : null}
        <Circle cx={x} cy={MID} r={6} fill={colors.edges.warning} />
        <Path
          d={`M${x} ${MID - 3}v3.4M${x} ${MID + 2.6}v.1`}
          stroke="#ffffff"
          strokeWidth={1.6}
          strokeLinecap="round"
        />
      </G>
    );
  }
  if (flow.phase === "ready" && prFlowFooterAction(flow) === "merge") {
    return (
      <G>
        <Circle cx={x} cy={MID} r={6} fill={colors.success} />
        <Path
          d={`M${x - 2.6} ${MID + 0.2}l1.8 1.8 3.4-3.6`}
          stroke="#ffffff"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </G>
    );
  }
  return (
    <Circle
      cx={x}
      cy={MID}
      r={4.5}
      fill={colors.card}
      stroke={themeColorWithAlpha(colors.muted, 0.6)}
      strokeWidth={1.5}
    />
  );
}

function RowNode(props: {
  readonly row: PrFlowRow;
  readonly flow: PrFlow;
  readonly colors: PrFlowColors;
}) {
  const { row, flow, colors } = props;
  if (row.kind !== "commit") {
    return (
      <G>
        <Circle
          cx={LANE_X.head}
          cy={MID}
          r={4.5}
          fill={colors.card}
          stroke={colors.edges.head}
          strokeWidth={1.5}
          strokeDasharray={row.kind === "uncommitted" ? "2.4 2" : undefined}
        />
        {row.kind === "merging" ? (
          <Circle cx={LANE_X.head} cy={MID} r={1.6} fill={colors.edges.head} />
        ) : null}
      </G>
    );
  }
  const conflicting =
    row.conflicts > 0 &&
    !row.resolved &&
    (flow.phase === "conflicts" || flow.phase === "resolving");
  const fill = conflicting
    ? colors.edges.warning
    : flow.phase === "merged" && row.lane === "head"
      ? colors.edges.merged
      : colors.edges[row.lane];
  return <Circle cx={LANE_X[row.lane]} cy={MID} r={row.lane === "head" ? 4 : 3.5} fill={fill} />;
}

const REF_SURFACE = {
  head: "bg-primary/10",
  base: "bg-subtle",
  side: "bg-adaptive-emerald-500-a12-a16",
} as const;

const REF_TEXT = {
  head: "text-primary-text",
  base: "text-foreground-muted",
  side: "text-adaptive-emerald-700-300",
} as const;

function RowContent(props: {
  readonly row: PrFlowRow;
  readonly flow: PrFlow;
  readonly onShowConflicts: (row: Extract<PrFlowRow, { kind: "commit" }>) => void;
}) {
  const { row, flow } = props;
  if (row.kind === "uncommitted") {
    return (
      <>
        <Text className="min-w-0 shrink text-sm text-foreground-muted" numberOfLines={1}>
          Uncommitted changes
        </Text>
        <Text className="ml-auto shrink-0 pl-2 text-xs text-foreground-muted">
          {row.files} {row.files === 1 ? "file" : "files"}
        </Text>
      </>
    );
  }
  if (row.kind === "merging") {
    return (
      <>
        <Text className="min-w-0 shrink text-sm text-foreground-muted" numberOfLines={1}>
          {row.subject}
        </Text>
        <Text className="ml-auto shrink-0 pl-2 text-xs text-foreground-muted">
          {row.done}/{row.total}
        </Text>
        {/* Under the row's text, not the graph, as on web. */}
        <View
          className="absolute right-1 bottom-0 h-0.5 overflow-hidden rounded-full bg-subtle"
          style={{ left: GRAPH_WIDTH + 6 }}
        >
          <View
            className="h-full bg-adaptive-emerald-600-400"
            style={{ width: `${row.total === 0 ? 0 : (row.done / row.total) * 100}%` }}
          />
        </View>
      </>
    );
  }
  const conflictPhase = flow.phase === "conflicts" || flow.phase === "resolving";
  const conflicting = conflictPhase && row.conflicts > 0 && !row.resolved;
  const merged = flow.phase === "merged" && row.lane === "head";
  // One chip at most: on a phone the title needs the width.
  const ref = row.refs[0];
  return (
    <>
      <Text
        className={cn(
          "min-w-0 shrink text-sm",
          conflicting
            ? "text-warning-foreground"
            : row.lane === "head"
              ? "text-foreground"
              : "text-foreground-muted",
        )}
        numberOfLines={1}
      >
        {row.subject}
      </Text>
      {ref === undefined ? null : (
        <View
          className={cn(
            "max-w-28 shrink rounded px-1.5",
            merged ? "bg-adaptive-violet-500-a12-a16" : REF_SURFACE[row.lane],
          )}
        >
          <Text
            className={cn(
              "text-2xs leading-5",
              merged ? "text-adaptive-violet-600-400" : REF_TEXT[row.lane],
            )}
            style={{ fontFamily: REVIEW_MONO_FONT_FAMILY }}
            numberOfLines={1}
          >
            {ref}
          </Text>
        </View>
      )}
      {conflicting ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${row.conflicts} ${row.conflicts === 1 ? "conflict" : "conflicts"} from ${row.subject}`}
          accessibilityHint="Shows the lines that clash."
          onPress={() => props.onShowConflicts(row)}
          hitSlop={8}
          className="size-[18px] shrink-0 items-center justify-center rounded-full border border-warning-border bg-warning active:opacity-70"
        >
          <Text className="text-2xs text-warning-foreground">{row.conflicts}</Text>
        </Pressable>
      ) : row.resolved && conflictPhase ? (
        <SymbolView
          name="checkmark.circle.fill"
          size={15}
          tintColorClassName="accent-adaptive-emerald-600-400"
        />
      ) : null}
      <Text className="ml-auto shrink-0 pl-2 text-xs text-foreground-muted" numberOfLines={1}>
        {row.author} ·{" "}
        {relativeTime(row.authoredAt) === "<1m" ? "now" : relativeTime(row.authoredAt)}
      </Text>
    </>
  );
}

function CheckIcon({ check }: { check: PrFlowCheck }) {
  switch (check.state) {
    case "passed":
      return (
        <SymbolView
          name="checkmark"
          size={11}
          tintColorClassName="accent-adaptive-emerald-600-400"
        />
      );
    case "failed":
      return <SymbolView name="xmark" size={11} tintColorClassName="accent-danger-foreground" />;
    case "skipped":
      return <SymbolView name="minus" size={11} tintColorClassName="accent-icon-muted" />;
    case "running":
      return (
        <AppActivityIndicator size="small" style={{ transform: [{ scale: 0.6 }], width: 12 }} />
      );
  }
}

function PrFlowCheckChips(props: {
  readonly checks: ReadonlyArray<PrFlowCheck>;
  readonly onOpen: (url: string) => void;
}) {
  return (
    <View className="flex-row flex-wrap gap-1.5 pt-1">
      {props.checks.map((check) => (
        <Pressable
          key={check.name}
          accessibilityRole="button"
          accessibilityLabel={`${check.name}, ${check.result}`}
          accessibilityHint="Shows the check's details."
          onPress={() => {
            const detail = [
              check.description ?? check.result,
              check.durationMs === null ? null : formatCheckDuration(check.durationMs),
            ]
              .filter((part) => part !== null)
              .join(" · ");
            const url = check.url;
            Alert.alert(
              check.name,
              detail,
              url === null
                ? [{ text: "OK" }]
                : [
                    { text: "Close", style: "cancel" },
                    { text: "Details", onPress: () => props.onOpen(url) },
                  ],
            );
          }}
          className={cn(
            "h-6 flex-row items-center gap-1.5 rounded-full border px-2 active:opacity-70",
            check.state === "failed" ? "border-danger/40" : "border-border",
          )}
        >
          <CheckIcon check={check} />
          <Text
            className={cn(
              "max-w-32 text-xs",
              check.state === "running" ? "text-foreground-muted" : "text-foreground",
            )}
            numberOfLines={1}
          >
            {check.name}
          </Text>
          <Text
            className={cn(
              "text-xs",
              check.state === "failed" ? "text-danger-foreground" : "text-foreground-muted",
            )}
          >
            {check.result}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function PrFlowFooter(props: {
  readonly flow: PrFlow;
  readonly onShowConflicts: () => void;
  readonly onOpen: (url: string) => void;
  readonly onMerge: () => void;
  readonly onResolveConflicts: () => void;
}) {
  const { flow } = props;
  const status = prFlowStatus(flow);
  const base = flow.base ?? "the base";
  const checks = flow.checks;
  const conflictsKnown = (flow.conflicts?.files.length ?? 0) > 0;
  return (
    <View className="flex-row flex-wrap items-center gap-x-2 gap-y-2 pt-1">
      <View className="min-w-0 flex-1 flex-row items-center gap-2" style={{ flexBasis: 180 }}>
        <FooterIcon flow={flow} />
        <View className="min-w-0 flex-1 gap-1.5">
          {flow.phase === "conflicts" ? (
            <Text className="text-sm text-foreground" numberOfLines={1}>
              <Text
                className="text-warning-foreground"
                style={
                  conflictsKnown
                    ? { textDecorationLine: "underline", textDecorationStyle: "dotted" }
                    : undefined
                }
                onPress={conflictsKnown ? props.onShowConflicts : undefined}
                accessibilityRole={conflictsKnown ? "button" : undefined}
                accessibilityHint={conflictsKnown ? "Shows the lines that clash." : undefined}
              >
                {status.short}
              </Text>{" "}
              with {base}
            </Text>
          ) : (
            <Text
              className={cn(
                "text-sm",
                status.tone === "busy" ? "text-foreground-muted" : "text-foreground",
              )}
              numberOfLines={1}
            >
              {status.label}
            </Text>
          )}
          {flow.phase === "testing" && checks !== null && checks.total > 0 ? (
            <View className="h-0.5 w-48 max-w-full overflow-hidden rounded-full bg-subtle">
              <View
                className="h-full bg-adaptive-emerald-600-400"
                style={{ width: `${(checks.done / checks.total) * 100}%` }}
              />
            </View>
          ) : null}
        </View>
      </View>
      <View className="ml-auto">
        <FooterAction
          flow={flow}
          onOpen={props.onOpen}
          onMerge={props.onMerge}
          onResolveConflicts={props.onResolveConflicts}
        />
      </View>
    </View>
  );
}

function FooterIcon({ flow }: { flow: PrFlow }) {
  const status = prFlowStatus(flow);
  if (status.tone === "busy") {
    return (
      <AppActivityIndicator size="small" style={{ width: 16, transform: [{ scale: 0.75 }] }} />
    );
  }
  if (status.tone === "warning") {
    return (
      <SymbolView
        name="exclamationmark.triangle"
        size={14}
        tintColorClassName="accent-warning-foreground"
      />
    );
  }
  if (flow.phase === "merged") {
    return (
      <SymbolView
        name={PullRequestGlyph.merged}
        size={14}
        tintColorClassName="accent-adaptive-violet-600-400"
      />
    );
  }
  return (
    <SymbolView name="checkmark" size={14} tintColorClassName="accent-adaptive-emerald-600-400" />
  );
}

/** The card's one soft call to action, as web's primary-soft button. */
function SoftButton(props: {
  readonly label: string;
  readonly icon?: AppSymbolName;
  readonly busy?: boolean;
  readonly onPress?: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: props.onPress === undefined, busy: props.busy === true }}
      disabled={props.onPress === undefined}
      onPress={props.onPress}
      className={cn(
        "h-8 flex-row items-center gap-1.5 rounded-full px-3 active:opacity-70",
        props.onPress === undefined ? "bg-subtle" : "bg-primary/15",
      )}
    >
      {props.busy ? (
        <AppActivityIndicator size="small" style={{ width: 14, transform: [{ scale: 0.65 }] }} />
      ) : props.icon ? (
        <SymbolView name={props.icon} size={12} tintColorClassName="accent-primary-text" />
      ) : null}
      <Text
        className={cn(
          "text-sm font-t3-medium",
          props.onPress === undefined ? "text-foreground-muted" : "text-primary-text",
        )}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

function FooterAction(props: {
  readonly flow: PrFlow;
  readonly onOpen: (url: string) => void;
  readonly onMerge: () => void;
  readonly onResolveConflicts: () => void;
}) {
  const { flow } = props;
  const action = prFlowFooterAction(flow);
  switch (action) {
    case "resolve":
      return <SoftButton label="Resolve conflicts" onPress={props.onResolveConflicts} />;
    case "resolving":
    case "merging":
      return <SoftButton label={action === "resolving" ? "Resolving" : "Merging"} busy />;
    case "merge":
      return <SoftButton label="Merge" icon={PullRequestGlyph.merged} onPress={props.onMerge} />;
    case "open": {
      const url = flow.url;
      return url === null ? null : (
        <SoftButton label="Open" icon="arrow.up.right" onPress={() => props.onOpen(url)} />
      );
    }
    case null:
      return null;
  }
}

interface ConflictSheetContent {
  /** A commit's own clashes name the commit; the footer's name who changed the base. */
  readonly heading: { readonly strong: string; readonly rest: string } | null;
  readonly files: ReadonlyArray<PrFlowConflictFile>;
  readonly base: string;
}

/** The clashing lines, as web's hover card shows them, in a native sheet. */
function ConflictSheet(props: {
  readonly content: ConflictSheetContent;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { files, base } = props.content;
  const theirs = [...new Set(files.flatMap((file) => file.theirsAuthor ?? []))];
  const heading = props.content.heading ?? {
    strong: theirs.length === 1 ? (theirs[0] ?? base) : base,
    rest:
      theirs.length === 1
        ? `changed the same lines on ${base}`
        : "changed the same lines since this branch left it",
  };
  const shortName = (name: string | null) => name?.split(" ")[0] ?? "";
  return (
    <Modal presentationStyle="pageSheet" animationType="slide" onRequestClose={props.onClose}>
      <View
        className="flex-1 bg-sheet-solid"
        style={
          Platform.OS === "android"
            ? { paddingTop: insets.top, paddingBottom: insets.bottom }
            : undefined
        }
      >
        <View className="flex-row items-center justify-between px-4 pt-4 pb-2">
          <Text className="text-lg font-t3-medium text-foreground">Conflicts</Text>
          <Pressable accessibilityRole="button" onPress={props.onClose} className="p-3">
            <Text className="text-foreground">Done</Text>
          </Pressable>
        </View>
        <ScrollView className="flex-1" contentContainerStyle={{ padding: 16, gap: 14 }}>
          <Text className="text-sm text-foreground">
            <Text className="font-t3-medium">{heading.strong}</Text>{" "}
            <Text className="text-foreground-muted">{heading.rest}</Text>
          </Text>
          {files.map((file) =>
            file.hunks.length === 0 ? (
              <View key={file.path} className="gap-1 border-t border-border pt-3">
                <Text className="text-sm text-foreground">
                  <Text className="font-t3-medium">{file.path}</Text>{" "}
                  <Text className="text-foreground-muted">
                    {file.count} {file.count === 1 ? "conflict" : "conflicts"}
                  </Text>
                </Text>
              </View>
            ) : (
              file.hunks.map((hunk) => (
                <View
                  key={`${file.path}:${hunk.line}`}
                  className="gap-1.5 border-t border-border pt-3"
                >
                  <Text className="text-sm text-foreground">
                    <Text className="font-t3-medium">{file.path}</Text>{" "}
                    <Text className="text-foreground-muted">line {hunk.line}</Text>
                  </Text>
                  <HunkSide
                    name={shortName(file.theirsAuthor) || base}
                    lines={hunk.theirs}
                    tone="theirs"
                  />
                  <HunkSide
                    name={shortName(file.oursAuthor) || "You"}
                    lines={hunk.ours}
                    tone="ours"
                  />
                </View>
              ))
            ),
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

function HunkSide(props: {
  readonly name: string;
  readonly lines: ReadonlyArray<string>;
  readonly tone: "ours" | "theirs";
}) {
  return (
    <View
      className={cn(
        "flex-row gap-3 border-l-2 py-0.5 pl-2",
        props.tone === "theirs" ? "border-warning-foreground" : "border-primary",
      )}
    >
      <Text className="w-12 text-xs text-foreground-muted" numberOfLines={1}>
        {props.name}
      </Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} className="flex-1">
        <Text className="text-xs text-foreground" style={{ fontFamily: REVIEW_MONO_FONT_FAMILY }}>
          {props.lines.length === 0 ? "(removed)" : props.lines.join("\n")}
        </Text>
      </ScrollView>
    </View>
  );
}
