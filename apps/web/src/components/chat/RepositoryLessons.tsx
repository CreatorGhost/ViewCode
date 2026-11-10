/**
 * Repository lessons: what a repository's own history showed going wrong, which a review is told
 * to look for. The line that says a review uses them, the strip of risky parts of a change, and
 * the sheet that lists them.
 */
import { BookOpenCheckIcon, PlusIcon } from "lucide-react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Sheet, SheetDescription, SheetHeader, SheetPopup, SheetTitle } from "../ui/sheet";
import { Switch } from "../ui/switch";

export type RepositoryLessonSource = "kept-breaking" | "reviewers-ask" | "you-rated";

export interface RepositoryLesson {
  readonly id: string;
  readonly text: string;
  /** Where it applies, as path globs. */
  readonly where: string;
  readonly source: RepositoryLessonSource;
  readonly evidence: ReadonlyArray<{ readonly label: string; readonly url: string }>;
  readonly flagged: number;
  readonly helpful: number;
  readonly enabled: boolean;
  /** Why it is off, when the reader's own ratings turned it off. */
  readonly offReason?: string | undefined;
}

export type RepositoryLessonsStatus =
  | { readonly kind: "never"; readonly reverts: number; readonly followUpFixes: number }
  | { readonly kind: "learning" }
  | { readonly kind: "learned"; readonly count: number }
  | { readonly kind: "stale"; readonly count: number; readonly mergesSince: number };

const SOURCE_LABELS: Record<RepositoryLessonSource, string> = {
  "kept-breaking": "kept breaking",
  "reviewers-ask": "reviewers ask",
  "you-rated": "you rated",
};

/** The start form's one line about lessons: whether a review will use any, and the way to them. */
export function RepositoryLessonsLine({
  status,
  onLearn,
  onView,
}: {
  status: RepositoryLessonsStatus;
  onLearn: () => void;
  onView: () => void;
}) {
  const lessons = (count: number) => `${count} ${count === 1 ? "lesson" : "lessons"}`;
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
      <BookOpenCheckIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        {status.kind === "never"
          ? `${status.reverts} reverts, ${status.followUpFixes} quick fixes this year`
          : status.kind === "learning"
            ? "Learning from history… you can start now"
            : status.kind === "learned"
              ? `Using ${lessons(status.count)} from this repository`
              : `${lessons(status.count)} · ${status.mergesSince} merges since`}
      </span>
      {status.kind === "learning" ? null : (
        <Button
          type="button"
          size="xs"
          variant="link"
          onClick={status.kind === "learned" ? onView : onLearn}
        >
          {status.kind === "never"
            ? "Learn from them"
            : status.kind === "learned"
              ? "View"
              : "Update"}
        </Button>
      )}
    </div>
  );
}

/** The risky parts of a change, found without a model, shown as soon as a review starts. */
export function ReviewLookFirst({ items }: { items: ReadonlyArray<string> }) {
  if (items.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5 border-b border-border/60 px-3 py-1.5 text-muted-foreground text-xs">
      <span>Look first</span>
      {items.map((item) => (
        <Badge key={item} size="sm" variant="outline">
          {item}
        </Badge>
      ))}
    </div>
  );
}

export function RepositoryLessonsSheet({
  open,
  onOpenChange,
  lessons,
  learnedFrom,
  onToggle,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lessons: ReadonlyArray<RepositoryLesson>;
  /** What they were learned from and when, as one line. */
  learnedFrom: string;
  onToggle: (id: string, enabled: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetPopup side="right">
        <SheetHeader>
          <SheetTitle>Repository lessons</SheetTitle>
          <SheetDescription>{learnedFrom}</SheetDescription>
        </SheetHeader>
        <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-6">
          {lessons.map((lesson) => (
            <li
              key={lesson.id}
              className="flex items-start gap-3 rounded-lg border border-border/70 p-3 text-sm"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className={lesson.enabled ? "font-medium" : "text-muted-foreground"}>
                  {lesson.text}
                </span>
                <span className="truncate font-mono text-muted-foreground text-xs">
                  {lesson.where}
                </span>
                <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-muted-foreground text-xs">
                  <Badge
                    size="sm"
                    variant={lesson.source === "kept-breaking" ? "warning" : "outline"}
                  >
                    {SOURCE_LABELS[lesson.source]}
                  </Badge>
                  {lesson.evidence.map((evidence) => (
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
                  <span>
                    {lesson.offReason ??
                      (lesson.flagged === 0
                        ? "not flagged yet"
                        : `flagged ${lesson.flagged}, ${lesson.helpful} helpful`)}
                  </span>
                </span>
              </div>
              <Switch
                size="sm"
                aria-label={`Use "${lesson.text}"`}
                checked={lesson.enabled}
                onCheckedChange={(checked) => onToggle(lesson.id, checked)}
              />
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-2 p-6">
          <Button type="button" size="sm" variant="outline">
            <PlusIcon aria-hidden />
            Add a lesson
          </Button>
          <Button type="button" size="sm" variant="ghost">
            Learn again
          </Button>
          <span className="flex-1" />
          <Button type="button" size="sm">
            Save to repository
          </Button>
        </div>
      </SheetPopup>
    </Sheet>
  );
}
