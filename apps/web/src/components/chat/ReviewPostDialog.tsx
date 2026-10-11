import {
  type PullRequestReviewVerdict,
  REVIEW_POST_MAX_OVERALL_COMMENT_CHARS,
  type ReviewFindingPlacement,
  type ReviewVerdict,
} from "@t3tools/contracts";
import {
  reviewFindingCommentBody,
  reviewFindingLocation,
  reviewSubmitVerdictFor,
} from "@t3tools/shared/reviewFindings";
import { useId, useState } from "react";

import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { type ReviewFindingEntry, reviewPostOverallComment } from "./reviewPanel.logic";

const SUBMIT_AS: Record<PullRequestReviewVerdict, string> = {
  comment: "Comment",
  approve: "Approve",
  "request-changes": "Request changes",
};

function isSubmitVerdict(value: unknown): value is PullRequestReviewVerdict {
  return value === "comment" || value === "approve" || value === "request-changes";
}

/**
 * Posting findings to somebody else's pull request, which other people will read: always behind
 * this click, with the verdict the review is submitted as and its own words above the findings.
 * One finding shows exactly the comment that will be posted.
 */
export function ReviewPostDialog({
  entries,
  verdict,
  placementOf,
  markdownCwd,
  onPost,
  onClose,
}: {
  entries: ReadonlyArray<ReviewFindingEntry>;
  /** The reviewer's verdict, which sets the defaults. */
  verdict: ReviewVerdict;
  /** Where a finding is expected to land: on its line, or in the review's text. */
  placementOf: (entry: ReviewFindingEntry) => ReviewFindingPlacement;
  markdownCwd: string | undefined;
  /** Resolves to whether the review was posted; the dialog stays open otherwise. */
  onPost: (input: {
    verdict: PullRequestReviewVerdict;
    overallComment: string;
  }) => Promise<boolean>;
  onClose: () => void;
}) {
  const id = useId();
  const [submitAs, setSubmitAs] = useState<PullRequestReviewVerdict>(() =>
    reviewSubmitVerdictFor(verdict),
  );
  const [overallComment, setOverallComment] = useState(() =>
    reviewPostOverallComment(verdict, entries),
  );
  const [pending, setPending] = useState(false);
  const only = entries.length === 1 ? entries[0] : undefined;

  const post = async () => {
    if (pending) return;
    setPending(true);
    const posted = await onPost({ verdict: submitAs, overallComment });
    setPending(false);
    if (posted) onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-lg">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void post();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              Post {only ? "this finding" : `${entries.length} findings`} as a review
            </DialogTitle>
            <DialogDescription>
              Each finding goes on its line where the pull request's diff shows it, and into the
              review's text otherwise. Everyone on the pull request can read it.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <Label className="flex min-w-0 flex-col items-stretch" htmlFor={`${id}-verdict`}>
                Submit as
                <Select
                  value={submitAs}
                  items={SUBMIT_AS}
                  onValueChange={(value) => {
                    if (isSubmitVerdict(value)) setSubmitAs(value);
                  }}
                >
                  <SelectTrigger id={`${id}-verdict`} className="min-w-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {Object.entries(SUBMIT_AS).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Label>
              <Label className="flex min-w-0 flex-col items-stretch" htmlFor={`${id}-overall`}>
                Overall comment
                <Textarea
                  id={`${id}-overall`}
                  rows={4}
                  value={overallComment}
                  maxLength={REVIEW_POST_MAX_OVERALL_COMMENT_CHARS}
                  disabled={pending}
                  onChange={(event) => setOverallComment(event.target.value)}
                />
              </Label>
              {only ? (
                <div className="flex min-w-0 flex-col gap-1 text-sm">
                  <span className="text-muted-foreground text-xs">
                    {placementOf(only) === "inline"
                      ? `Comment on ${reviewFindingLocation(only.finding)}`
                      : "In the review's text"}
                  </span>
                  <div className="min-w-0 rounded-lg border border-border/70 p-3">
                    <ChatMarkdown
                      text={reviewFindingCommentBody(only.finding, placementOf(only))}
                      cwd={markdownCwd}
                    />
                  </div>
                </div>
              ) : (
                <ul className="flex min-w-0 flex-col gap-1 text-sm">
                  {entries.map((entry) => (
                    <li key={entry.key} className="flex min-w-0 items-baseline gap-2">
                      <span className="min-w-0 truncate">{entry.finding.title}</span>
                      <span className="shrink-0 text-muted-foreground text-xs">
                        {placementOf(entry) === "inline"
                          ? reviewFindingLocation(entry.finding)
                          : "in the text"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Posting..." : "Post review"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
