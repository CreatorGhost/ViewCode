import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import type { ReactNode } from "react";

import { useThreadShell } from "../../state/entities";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** What a review read: a pull request, named by number and title when known, or the chat's changes. */
export type ReviewHeading =
  | { readonly kind: "pull-request"; readonly number: number; readonly title: string | null }
  | { readonly kind: "local" };

export function reviewHeadingText(heading: ReviewHeading): string {
  if (heading.kind === "local") return "This chat's changes";
  return heading.title === null
    ? `PR #${heading.number}`
    : `PR #${heading.number} · ${heading.title}`;
}

/**
 * The pull request's title from the review thread's own name, which the server writes as
 * "<Mode>: #<number> <title>", for when its link carries no snapshot yet.
 */
export function pullRequestTitleFromReviewTitle(
  threadTitle: string,
  number: number,
): string | null {
  const match = new RegExp(`#${number}\\s+(.+)$`).exec(threadTitle);
  const title = match?.[1]?.trim() ?? "";
  return title.length > 0 ? title : null;
}

/**
 * The title of the pull request a review thread is linked to, by number, from the thread's own
 * links (a review of a pull request runs in a thread linked to it), else from its name.
 */
export function useLinkedPullRequestTitle(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  number: number | null,
): string | null {
  const shell = useThreadShell(number === null ? null : scopeThreadRef(environmentId, threadId));
  if (number === null) return null;
  const link = visibleThreadPullRequests(shell?.pullRequests ?? []).find(
    (entry) => entry.number === number,
  );
  return link?.snapshot?.title ?? pullRequestTitleFromReviewTitle(shell?.title ?? "", number);
}

/**
 * How every review block introduces itself, so two of them in one panel never blur: a kicker that
 * says what the block is (reviewing now, an earlier review, the latest), then what it reviewed in
 * one prominent line.
 */
export function ReviewIdentity({
  kicker,
  kickerVariant,
  heading,
  trailing,
}: {
  kicker: string;
  kickerVariant: "info" | "warning" | "outline" | "success" | "error";
  heading: ReviewHeading;
  /** What sits at the row's end: a time, the controls. */
  trailing?: ReactNode;
}) {
  const text = reviewHeadingText(heading);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-2">
        <Badge size="sm" variant={kickerVariant}>
          {kicker}
        </Badge>
        <span className="min-w-0 flex-1" />
        {trailing}
      </div>
      <Tooltip>
        <TooltipTrigger render={<p className="min-w-0 truncate font-medium text-sm" />}>
          {heading.kind === "local" ? (
            text
          ) : (
            <>
              <span className="font-semibold">PR #{heading.number}</span>
              {heading.title === null ? null : (
                <>
                  <span className="text-muted-foreground"> · </span>
                  {heading.title}
                </>
              )}
            </>
          )}
        </TooltipTrigger>
        <TooltipPopup side="top">{text}</TooltipPopup>
      </Tooltip>
    </div>
  );
}
