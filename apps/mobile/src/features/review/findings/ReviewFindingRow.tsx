import type { ReviewFindingEntry } from "@t3tools/client-runtime/review-findings";
import type { ReviewFindingRating, ReviewFindingSeverity } from "@t3tools/contracts";
import {
  fencedCode,
  type PostedReviewFinding,
  REVIEW_FINDING_SEVERITY_LABELS,
  reviewFindingLocation,
} from "@t3tools/shared/reviewFindings";
import { memo, type ReactNode } from "react";
import { Pressable, View } from "react-native";

import { type AppSymbolName, SymbolView } from "../../../components/AppSymbol";
import { AppText as Text } from "../../../components/AppText";
import { cn } from "../../../lib/cn";
import { MarkdownText } from "../../files/FileMarkdownPreview";
import type { ReviewFixDestination } from "../../../state/review-findings";

export const REVIEW_SEVERITY_PRESENTATION: Record<
  ReviewFindingSeverity,
  { readonly icon: AppSymbolName; readonly tint: string; readonly text: string }
> = {
  blocker: {
    icon: "exclamationmark.octagon",
    tint: "accent-adaptive-rose-700-300",
    text: "text-adaptive-rose-700-300",
  },
  important: {
    icon: "exclamationmark.triangle",
    tint: "accent-adaptive-amber-700-300",
    text: "text-adaptive-amber-700-300",
  },
  nit: { icon: "info.circle", tint: "accent-foreground-muted", text: "text-foreground-muted" },
  question: {
    icon: "questionmark.circle",
    tint: "accent-adaptive-sky-700-300",
    text: "text-adaptive-sky-700-300",
  },
};

/** A finding's main action: fixing it, or posting it to somebody else's pull request. */
export interface ReviewFindingAction {
  readonly label: string;
  readonly icon: AppSymbolName;
  readonly run: (entry: ReviewFindingEntry) => void;
}

function FindingPill(props: {
  readonly label: string;
  readonly icon?: AppSymbolName;
  readonly accessibilityLabel?: string;
  readonly selected?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityState={props.selected === undefined ? undefined : { selected: props.selected }}
      hitSlop={4}
      onPress={props.onPress}
      className={cn(
        "min-h-10 flex-row items-center gap-1.5 rounded-full px-3.5 active:opacity-70",
        props.selected ? "bg-subtle-strong" : "bg-subtle",
      )}
    >
      {props.icon ? (
        <SymbolView
          name={props.icon}
          size={15}
          tintColorClassName="accent-foreground"
          type="monochrome"
        />
      ) : null}
      {props.label ? (
        <Text className="text-[13px] font-t3-medium text-foreground">{props.label}</Text>
      ) : null}
    </Pressable>
  );
}

function Tag(props: { readonly children: ReactNode }) {
  return (
    <View className="rounded-sm bg-subtle-strong px-1.5 py-0.5">
      <Text className="text-3xs font-t3-medium text-foreground-muted">{props.children}</Text>
    </View>
  );
}

/**
 * One finding in the list: severity, confidence, title and where it is; tapped open, the detail,
 * the suggested fix and what can be done about it. Memoized: the list redraws whenever the review
 * thread's activities change, which a row only cares about when its own inputs do.
 */
export const ReviewFindingRow = memo(function ReviewFindingRow(props: {
  readonly entry: ReviewFindingEntry;
  readonly expanded: boolean;
  readonly dismissed: boolean;
  /** Present when the server keeps ratings; undefined is unrated. */
  readonly rating: ReviewFindingRating | undefined;
  readonly canRate: boolean;
  readonly posted: PostedReviewFinding | undefined;
  readonly sentTo: ReviewFixDestination | undefined;
  /** Present in comment mode, where findings are ticked to post several as one review. */
  readonly ticked?: boolean | undefined;
  readonly action: ReviewFindingAction | null;
  readonly onToggleExpanded: (entry: ReviewFindingEntry) => void;
  readonly onTick?: ((entry: ReviewFindingEntry) => void) | undefined;
  readonly onDismiss: (entry: ReviewFindingEntry, dismissed: boolean) => void;
  readonly onRate: (entry: ReviewFindingEntry, rating: ReviewFindingRating) => void;
  readonly onOpenPosted: (url: string) => void;
}) {
  const { entry, expanded } = props;
  const { finding } = entry;
  const severity = REVIEW_SEVERITY_PRESENTATION[finding.severity];
  return (
    <View className={cn("px-4", props.dismissed && "opacity-60")}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityHint={expanded ? "Hides the detail." : "Shows the detail and suggested fix."}
        onPress={() => props.onToggleExpanded(entry)}
        className="min-h-[56px] flex-row items-start gap-3 py-3"
      >
        {props.onTick !== undefined ? (
          <Pressable
            accessibilityRole="checkbox"
            accessibilityLabel={`Select "${finding.title}"`}
            accessibilityState={{ checked: props.ticked === true }}
            hitSlop={8}
            onPress={() => props.onTick?.(entry)}
          >
            <SymbolView
              name={props.ticked ? "checkmark.square.fill" : "square"}
              size={20}
              tintColorClassName={props.ticked ? "accent-primary" : "accent-icon-muted"}
              type="monochrome"
            />
          </Pressable>
        ) : null}
        <View className="pt-0.5">
          <SymbolView
            name={severity.icon}
            size={18}
            tintColorClassName={severity.tint}
            type="monochrome"
          />
        </View>
        <View className="min-w-0 flex-1 gap-1">
          <Text
            className="text-[15px] font-t3-medium leading-[20px] text-foreground"
            numberOfLines={expanded ? undefined : 2}
          >
            {finding.title}
          </Text>
          <Text className="text-[13px] text-foreground-muted" numberOfLines={1}>
            <Text className={cn("text-[13px] font-t3-medium", severity.text)}>
              {REVIEW_FINDING_SEVERITY_LABELS[finding.severity]}
            </Text>
            {` · ${finding.confidence}% · `}
            <Text className="font-mono text-[12px] text-foreground-muted">
              {reviewFindingLocation(finding)}
            </Text>
          </Text>
          {entry.needsChecking ||
          finding.preExisting ||
          props.posted ||
          props.sentTo ||
          props.dismissed ? (
            <View className="flex-row flex-wrap gap-1.5 pt-0.5">
              {entry.needsChecking ? <Tag>Needs checking</Tag> : null}
              {finding.preExisting ? <Tag>Pre-existing</Tag> : null}
              {props.dismissed ? <Tag>Dismissed</Tag> : null}
              {props.posted ? (
                <Tag>
                  {props.posted.placement === "inline"
                    ? "Posted on its line"
                    : "Posted in the review"}
                </Tag>
              ) : null}
              {props.sentTo ? <Tag>Sent to {props.sentTo.title}</Tag> : null}
            </View>
          ) : null}
        </View>
        <View className="pt-1">
          <SymbolView
            name={expanded ? "chevron.down" : "chevron.right"}
            size={13}
            tintColorClassName="accent-icon-subtle"
            type="monochrome"
          />
        </View>
      </Pressable>
      {expanded ? (
        <View className="gap-3 pb-4">
          <Text selectable className="text-[15px] leading-[21px] text-foreground">
            {finding.detail}
          </Text>
          {entry.needsChecking ? (
            <Text className="text-[13px] text-foreground-muted">
              The reviewer could not settle this one.
            </Text>
          ) : null}
          {finding.rule ? (
            <Text selectable className="text-[13px] text-foreground-muted">
              Rule: {finding.rule}
            </Text>
          ) : null}
          {finding.suggestedFix ? (
            <View className="gap-1">
              <Text className="text-[13px] font-t3-medium text-foreground-muted">
                Suggested fix
              </Text>
              <MarkdownText markdown={fencedCode(finding.suggestedFix, finding.path)} />
            </View>
          ) : null}
          <View className="flex-row flex-wrap items-center gap-2">
            {props.posted ? (
              <FindingPill
                label="Open comment"
                icon="arrow.up.right"
                onPress={() => props.onOpenPosted(props.posted!.url)}
              />
            ) : props.action ? (
              <FindingPill
                label={props.action.label}
                icon={props.action.icon}
                onPress={() => props.action?.run(entry)}
              />
            ) : null}
            <FindingPill
              label={props.dismissed ? "Restore" : "Dismiss"}
              onPress={() => props.onDismiss(entry, !props.dismissed)}
            />
            {props.canRate ? (
              <View className="ml-auto flex-row gap-2">
                <FindingPill
                  label=""
                  accessibilityLabel="Helpful"
                  icon={props.rating === "up" ? "hand.thumbsup.fill" : "hand.thumbsup"}
                  selected={props.rating === "up"}
                  onPress={() => props.onRate(entry, "up")}
                />
                <FindingPill
                  label=""
                  accessibilityLabel="Not helpful"
                  icon={props.rating === "down" ? "hand.thumbsdown.fill" : "hand.thumbsdown"}
                  selected={props.rating === "down"}
                  onPress={() => props.onRate(entry, "down")}
                />
              </View>
            ) : null}
          </View>
        </View>
      ) : null}
    </View>
  );
});
