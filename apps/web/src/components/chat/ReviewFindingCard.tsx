import type { ReviewFindingEntry, ReviewFindingKey } from "@t3tools/client-runtime/review-findings";
import type {
  ReviewFindingRating,
  ReviewFindingSeverity,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  fencedCode,
  type PostedReviewFinding,
  REVIEW_FINDING_SEVERITY_LABELS,
  reviewFindingLocation,
} from "@t3tools/shared/reviewFindings";
import {
  BookOpenCheckIcon,
  CheckIcon,
  CircleHelpIcon,
  InfoIcon,
  OctagonAlertIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  TriangleAlertIcon,
  MessageSquarePlusIcon,
  WrenchIcon,
} from "lucide-react";
import { memo, useState } from "react";

import { cn } from "~/lib/utils";
import ChatMarkdown from "../ChatMarkdown";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import type { ReviewFixDestination } from "./reviewFixSentStore";

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

/** Why a finding was not wanted, as the row under a thumbs-down offers it. */
const RATING_REASONS = ["Not a real problem", "Intended here", "Too minor", "Handled elsewhere"];

/** Long enough that four lines would cut it off, so the card offers to show the rest. */
function isLongDetail(detail: string): boolean {
  return detail.length > 320 || detail.split("\n").length > 4;
}

/** A finding's main action: fixing it, or posting it to somebody else's pull request. */
export interface ReviewFindingAction {
  readonly kind: "fix" | "post";
  readonly label: string;
  readonly run: (key: ReviewFindingKey) => void;
}

export interface ReviewFindingCardProps {
  readonly entry: ReviewFindingEntry;
  /** The finding Previous and Next are on. */
  readonly current: boolean;
  readonly expanded: boolean;
  readonly dismissed: boolean;
  readonly rating: ReviewFindingRating | undefined;
  readonly sentTo: ReviewFixDestination | undefined;
  /** Shows the message the finding was sent as. */
  readonly onOpenSent?: ((destination: ReviewFixDestination) => void) | undefined;
  /** Shown for findings outside the diff, which have no line above them to say where they are. */
  readonly showLocation: boolean;
  /** Present in reviewer mode, where findings are ticked to post them. */
  readonly ticked?: boolean | undefined;
  readonly onTick?: ((key: ReviewFindingKey, ticked: boolean) => void) | undefined;
  readonly onToggleExpanded: (key: ReviewFindingKey) => void;
  readonly onDismiss: (key: ReviewFindingKey, dismissed: boolean) => void;
  /** Rates the finding, or takes its rating back (null); absent where the server keeps none. */
  readonly onRate:
    | ((key: ReviewFindingKey, rating: ReviewFindingRating | null) => void)
    | undefined;
  /** Says why a finding was rated down; absent where the server keeps no reasons. */
  readonly onRatingReason?: ((key: ReviewFindingKey, reason: string | null) => void) | undefined;
  /** Switches off the review-skill lesson a finding cited; absent where that cannot be done. */
  readonly onStopLesson?: ((lessonId: string) => void) | undefined;
  /** The finding's main action: fix it, or in reviewer mode post it. */
  readonly action: ReviewFindingAction;
  /** A post of this finding is under way. */
  readonly busy: boolean;
  /** Where this finding was posted, from the review thread's record. */
  readonly posted: PostedReviewFinding | undefined;
  /** Why the last attempt to post it failed. */
  readonly failure: string | undefined;
  readonly markdownCwd: string | undefined;
  readonly threadRef: ScopedThreadRef;
  /** Hands the view the card's element, which it scrolls to and marks. */
  readonly register?: ((key: ReviewFindingKey, element: HTMLElement | null) => void) | undefined;
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
  onOpenSent,
  showLocation,
  ticked,
  onTick,
  onToggleExpanded,
  onDismiss,
  onRate,
  onRatingReason,
  onStopLesson,
  action,
  busy,
  posted,
  failure,
  markdownCwd,
  threadRef,
  register,
}: ReviewFindingCardProps) {
  const { finding, key } = entry;
  const SeverityIcon = SEVERITY_ICONS[finding.severity];
  const { lesson } = finding;
  const lessonId = lesson?.id;
  const [reason, setChosenReason] = useState<string | null>(null);
  const setReason = (next: string | null) => {
    setChosenReason(next);
    onRatingReason?.(key, next);
  };
  return (
    <div
      className={cn(
        "mx-3 my-2 rounded-lg border bg-background p-3 font-sans text-foreground text-sm",
        current ? "border-primary" : "border-border/70",
        dismissed && "opacity-64",
      )}
      ref={register === undefined ? undefined : (element) => register(key, element)}
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
            {lesson?.occurrences !== undefined ? (
              <Badge size="sm" variant="warning">
                broke {lesson.occurrences}× here
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
          {lesson ? (
            <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-muted-foreground text-xs">
              <BookOpenCheckIcon aria-hidden className="size-3.5 shrink-0" />
              <span className="text-foreground">Lesson: {lesson.text}</span>
              {lesson.evidence?.map((evidence) => (
                <a
                  key={evidence.url}
                  href={evidence.url}
                  target="_blank"
                  rel="noreferrer"
                  className="tabular-nums underline-offset-2 hover:text-foreground hover:underline"
                >
                  {evidence.label}
                </a>
              ))}
            </span>
          ) : null}
          {finding.suggestedFix ? (
            <ChatMarkdown
              text={fencedCode(finding.suggestedFix, finding.path)}
              cwd={markdownCwd}
              threadRef={threadRef}
              skills={NO_SKILLS}
            />
          ) : null}
          {failure ? (
            <p role="alert" className="text-destructive-foreground text-xs">
              {failure}
            </p>
          ) : null}
          <div className="flex min-w-0 items-center gap-1">
            {posted ? (
              <a
                href={posted.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-w-0 items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
              >
                <CheckIcon aria-hidden className="size-3.5 shrink-0" />
                {posted.placement === "inline" ? "Posted on its line" : "Posted in the review"}
              </a>
            ) : (
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => action.run(key)}
              >
                {action.kind === "post" ? (
                  <MessageSquarePlusIcon aria-hidden />
                ) : (
                  <WrenchIcon aria-hidden />
                )}
                {action.label}
              </Button>
            )}
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => onDismiss(key, !dismissed)}
            >
              {dismissed ? "Restore" : "Dismiss"}
            </Button>
            {sentTo ? (
              onOpenSent ? (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost-muted"
                  className="min-w-0"
                  title="Show the message, where the agent says whether it fixed this"
                  onClick={() => onOpenSent(sentTo)}
                >
                  <span className="truncate">Sent to {sentTo.title}</span>
                </Button>
              ) : (
                <span className="min-w-0 truncate text-muted-foreground text-xs">
                  Sent to {sentTo.title}
                </span>
              )
            ) : null}
            {onRate ? (
              <span className="ml-auto flex shrink-0 items-center gap-0.5">
                <Button
                  type="button"
                  size="icon-xs"
                  variant={rating === "up" ? "secondary" : "ghost-muted"}
                  aria-label="Helpful"
                  aria-pressed={rating === "up"}
                  onClick={() => onRate(key, rating === "up" ? null : "up")}
                >
                  <ThumbsUpIcon aria-hidden />
                </Button>
                <Button
                  type="button"
                  size="icon-xs"
                  variant={rating === "down" ? "secondary" : "ghost-muted"}
                  aria-label="Not helpful"
                  aria-pressed={rating === "down"}
                  onClick={() => onRate(key, rating === "down" ? null : "down")}
                >
                  <ThumbsDownIcon aria-hidden />
                </Button>
              </span>
            ) : null}
          </div>
          {onRatingReason && rating === "down" ? (
            reason === null ? (
              <div className="flex min-w-0 flex-wrap items-center gap-1 border-border/60 border-t pt-2">
                <span className="mr-1 text-muted-foreground text-xs">Why not?</span>
                {RATING_REASONS.map((label) => (
                  <Button
                    key={label}
                    type="button"
                    size="chip"
                    variant="chip-outline"
                    onClick={() => setReason(label)}
                  >
                    {label}
                  </Button>
                ))}
                {lessonId !== undefined && onStopLesson ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      setReason("Stop checking this here");
                      onStopLesson(lessonId);
                    }}
                  >
                    Stop checking this here
                  </Button>
                ) : null}
              </div>
            ) : (
              <span className="flex items-center gap-1 border-border/60 border-t pt-2 text-muted-foreground text-xs">
                <CheckIcon aria-hidden className="size-3.5 shrink-0" />
                {reason} · noted for this project
                <Button type="button" size="xs" variant="link" onClick={() => setReason(null)}>
                  Undo
                </Button>
              </span>
            )
          ) : null}
        </div>
      </div>
    </div>
  );
});
