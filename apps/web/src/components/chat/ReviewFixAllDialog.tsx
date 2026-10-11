import type { ReviewFindingEntry, ReviewFindingKey } from "@t3tools/client-runtime/review-findings";
import { REVIEW_FINDING_SEVERITY_LABELS } from "@t3tools/shared/reviewFindings";
import { useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { REVIEW_SEVERITY_BADGES } from "./ReviewFindingCard";

function findingLocation(entry: ReviewFindingEntry): string {
  const { path, line } = entry.finding;
  return line === undefined ? path : `${path}:${line}`;
}

/**
 * Fix all, for more than one finding: the findings that will go to `chatTitle`, all ticked, so the
 * reader can leave some out before the request is written into that chat's composer.
 */
export function ReviewFixAllDialog({
  entries,
  chatTitle,
  onSend,
  onClose,
}: {
  entries: ReadonlyArray<ReviewFindingEntry>;
  /** The chat the request goes to, when the view knows it. */
  chatTitle: string | null;
  onSend: (selection: ReadonlyArray<ReviewFindingEntry>) => void;
  onClose: () => void;
}) {
  const [left, setLeft] = useState<ReadonlySet<ReviewFindingKey>>(() => new Set());
  const selection = entries.filter((entry) => !left.has(entry.key));
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="sm:max-w-lg">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (selection.length > 0) onSend(selection);
          }}
        >
          <DialogHeader>
            <DialogTitle>Fix {entries.length} findings</DialogTitle>
            <DialogDescription>
              The request goes into {chatTitle === null ? "the chat's" : `${chatTitle}'s`} composer
              for you to read and send. The agent checks each finding first and says which it
              fixed and which it skipped.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <ul className="flex flex-col gap-1">
              {entries.map((entry) => (
                <li key={entry.key}>
                  <label className="flex cursor-pointer items-start gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-accent/40">
                    <Checkbox
                      className="mt-0.5"
                      checked={!left.has(entry.key)}
                      onCheckedChange={(checked) =>
                        setLeft((current) => {
                          const next = new Set(current);
                          if (checked) next.delete(entry.key);
                          else next.add(entry.key);
                          return next;
                        })
                      }
                    />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <Badge size="sm" variant={REVIEW_SEVERITY_BADGES[entry.finding.severity]}>
                          {REVIEW_FINDING_SEVERITY_LABELS[entry.finding.severity]}
                        </Badge>
                        <span className="truncate font-medium">{entry.finding.title}</span>
                      </span>
                      <span className="truncate text-muted-foreground text-xs">
                        {findingLocation(entry)}
                        {entry.needsChecking ? " · needs checking" : ""}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={selection.length === 0}>
              Send {selection.length} {selection.length === 1 ? "finding" : "findings"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
