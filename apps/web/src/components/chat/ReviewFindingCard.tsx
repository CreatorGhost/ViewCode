import type { ReviewFindingSeverity, ScopedThreadRef } from "@t3tools/contracts";
import {
  fencedCode,
  REVIEW_FINDING_SEVERITY_LABELS,
  reviewFindingLocation,
} from "@t3tools/shared/reviewFindings";
import {
  CircleHelpIcon,
  InfoIcon,
  OctagonAlertIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  TriangleAlertIcon,
  WrenchIcon,
} from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import ChatMarkdown from "../ChatMarkdown";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import type { ReviewFindingEntry, ReviewFindingKey } from "./reviewPanel.logic";
import type { ReviewFindingRating, ReviewFixDestination } from "./reviewFixSentStore";

export const REVIEW_SEVERITY_BADGES: Record<
  ReviewFindingSeverity,
  "error" | "warning" | "outline" | "info"
> = {
  blocker: "error",
  important: "warning",
  nit: "outline",
  question: "info",
};

const SEVERITY_ICONS: Record<ReviewFindingSeverity, typeof InfoIcon> = {
  blocker: OctagonAlertIcon,
  important: TriangleAlertIcon,
  nit: InfoIcon,
  question: CircleHelpIcon,
};

const NO_SKILLS: ReadonlyArray<never> = [];

/** Long enough that four lines would cut it off, so the card offers to show the rest. */
function isLongDetail(detail: string): boolean {
  return detail.length > 320 || detail.split("\n").length > 4;
}

export interface ReviewFindingCardProps {
  readonly entry: ReviewFindingEntry;
  /** The finding Previous and Next are on. */
  readonly current: boolean;
  readonly expanded: boolean;
  readonly dismissed: boolean;
  readonly rating: ReviewFindingRating | undefined;
  readonly sentTo: ReviewFixDestination | undefined;
  /** Shown for findings outside the diff, which have no line above them to say where they are. */
  readonly showLocation: boolean;
  /** Present in reviewer mode, where findings are ticked to post them. */
  readonly ticked?: boolean | undefined;
  readonly onTick?: ((key: ReviewFindingKey, ticked: boolean) => void) | undefined;
  readonly onToggleExpanded: (key: ReviewFindingKey) => void;
  readonly onDismiss: (key: ReviewFindingKey, dismissed: boolean) => void;
  readonly onRate: (key: ReviewFindingKey, rating: ReviewFindingRating) => void;
  /** The finding's main action: fix it, or in reviewer mode post it. */
  readonly action: { readonly label: string; readonly run: (key: ReviewFindingKey) => void };
  readonly markdownCwd: string | undefined;
  readonly threadRef: ScopedThreadRef;
}

/**
 * One finding under its lines in the diff, or in the General list: what is wrong, the detail
 * (four lines until expanded) and the suggested fix, with what can be done about it.
 */
export const ReviewFindingCard = memo(function ReviewFindingCard({
  entry,
  current,
  expanded,
  dismissed,
  rating,
  sentTo,
  showLocation,
  ticked,
  onTick,
  onToggleExpanded,
  onDismiss,
  onRate,
  action,
  markdownCwd,
  threadRef,
}: ReviewFindingCardProps) {
  const { finding, key } = entry;
  const SeverityIcon = SEVERITY_ICONS[finding.severity];
  return (
    <div
      className={cn(
        "mx-3 my-2 rounded-lg border bg-background p-3 font-sans text-foreground text-sm",
        current ? "border-primary" : "border-border/70",
        dismissed && "opacity-64",
      )}
      data-review-finding={key}
      contentEditable={false}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex min-w-0 items-start gap-2">
        {onTick ? (
          <Checkbox
            aria-label={`Select "${finding.title}"`}
            checked={ticked === true}
            onCheckedChange={(checked) => onTick(key, checked === true)}
          />
        ) : null}
        <SeverityIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="font-semibold">{finding.title}</span>
            <Badge size="sm" variant={REVIEW_SEVERITY_BADGES[finding.severity]}>
              {REVIEW_FINDING_SEVERITY_LABELS[finding.severity]}
            </Badge>
            <span className="text-muted-foreground text-xs tabular-nums">
              {finding.confidence}%
            </span>
            {entry.needsChecking ? (
              <Badge size="sm" variant="outline">
                needs checking
              </Badge>
            ) : null}
            {finding.preExisting ? (
              <Badge size="sm" variant="outline">
                pre-existing
              </Badge>
            ) : null}
          </div>
          {showLocation ? (
            <span className="truncate font-mono text-muted-foreground text-xs">
              {reviewFindingLocation(finding)}
            </span>
          ) : null}
          <p
            className={cn("whitespace-pre-wrap text-muted-foreground", !expanded && "line-clamp-4")}
          >
            {finding.detail}
          </p>
          {isLongDetail(finding.detail) ? (
            <Button
              type="button"
              size="xs"
              variant="link"
              className="self-start"
              aria-expanded={expanded}
              onClick={() => onToggleExpanded(key)}
            >
              {expanded ? "Show less" : "Show more"}
            </Button>
          ) : null}
          {finding.rule ? (
            <span className="text-muted-foreground text-xs">Rule: {finding.rule}</span>
          ) : null}
          {finding.suggestedFix ? (
            <ChatMarkdown
              text={fencedCode(finding.suggestedFix, finding.path)}
              cwd={markdownCwd}
              threadRef={threadRef}
              skills={NO_SKILLS}
            />
          ) : null}
          <div className="flex min-w-0 items-center gap-1">
            <Button type="button" size="xs" variant="outline" onClick={() => action.run(key)}>
              <WrenchIcon aria-hidden />
              {action.label}
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => onDismiss(key, !dismissed)}
            >
              {dismissed ? "Restore" : "Dismiss"}
            </Button>
            {sentTo ? (
              <span className="min-w-0 truncate text-muted-foreground text-xs">
                Sent to {sentTo.title}
              </span>
            ) : null}
            <span className="ml-auto flex shrink-0 items-center gap-0.5">
              <Button
                type="button"
                size="icon-xs"
                variant={rating === "up" ? "secondary" : "ghost-muted"}
                aria-label="Helpful"
                aria-pressed={rating === "up"}
                onClick={() => onRate(key, "up")}
              >
                <ThumbsUpIcon aria-hidden />
              </Button>
              <Button
                type="button"
                size="icon-xs"
                variant={rating === "down" ? "secondary" : "ghost-muted"}
                aria-label="Not helpful"
                aria-pressed={rating === "down"}
                onClick={() => onRate(key, "down")}
              >
                <ThumbsDownIcon aria-hidden />
              </Button>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
});
