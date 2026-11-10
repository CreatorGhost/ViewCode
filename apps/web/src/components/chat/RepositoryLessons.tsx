/**
 * A project's review skill as the Review panel and Settings show it: the strip of risky parts of
 * a change, and the list of lessons with a switch each.
 */
import type { ReviewSkillLesson, ReviewSkillLessonSource } from "@t3tools/contracts";
import { Trash2Icon } from "lucide-react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";

const SOURCE_LABELS: Record<ReviewSkillLessonSource, string> = {
  "kept-breaking": "kept breaking",
  "reviewers-ask": "reviewers ask",
  yours: "yours",
};

/** How findings that cited a lesson were rated, or why it is off. */
export function reviewSkillLessonStanding(lesson: ReviewSkillLesson): string {
  if (lesson.disabledByRatings === true) return "off after your ratings";
  if (lesson.helpful === 0 && lesson.unhelpful === 0) return "not rated yet";
  return `${lesson.helpful} helpful, ${lesson.unhelpful} not`;
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

export function ReviewSkillLessonList({
  lessons,
  disabled,
  onToggle,
  onRemove,
}: {
  lessons: ReadonlyArray<ReviewSkillLesson>;
  disabled: boolean;
  onToggle: (lesson: ReviewSkillLesson, enabled: boolean) => void;
  /** Removes a lesson of the user's own; learned ones are switched off instead. */
  onRemove: (lesson: ReviewSkillLesson) => void;
}) {
  return (
    <ul className="grid gap-2">
      {lessons.map((lesson) => (
        <li
          key={lesson.id}
          className="flex items-start gap-3 rounded-md border border-border px-3 py-2 text-sm"
        >
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className={lesson.enabled ? "font-medium" : "text-muted-foreground"}>
              {lesson.text}
            </span>
            <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-muted-foreground text-xs">
              <Badge size="sm" variant={lesson.source === "kept-breaking" ? "warning" : "outline"}>
                {SOURCE_LABELS[lesson.source]}
              </Badge>
              {lesson.where === undefined ? null : (
                <span className="font-mono">{lesson.where}</span>
              )}
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
              <span>{reviewSkillLessonStanding(lesson)}</span>
            </span>
          </div>
          {lesson.source === "yours" ? (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost-muted"
              aria-label={`Remove "${lesson.text}"`}
              disabled={disabled}
              onClick={() => onRemove(lesson)}
            >
              <Trash2Icon aria-hidden />
            </Button>
          ) : null}
          <Switch
            size="sm"
            aria-label={`Use "${lesson.text}"`}
            checked={lesson.enabled}
            disabled={disabled}
            onCheckedChange={(checked) => onToggle(lesson, checked)}
          />
        </li>
      ))}
    </ul>
  );
}
