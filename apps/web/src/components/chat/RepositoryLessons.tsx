/**
 * Repository lessons: what a repository's own history showed going wrong, which every review of
 * it is told to look for. The strip of risky parts of a change, and the lessons as Settings
 * lists them.
 */
import { PlusIcon } from "lucide-react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
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

const SOURCE_LABELS: Record<RepositoryLessonSource, string> = {
  "kept-breaking": "kept breaking",
  "reviewers-ask": "reviewers ask",
  "you-rated": "you rated",
};

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

/**
 * A repository's lessons in Settings: learned in the background from its history and from how
 * findings are rated, used by every review of it, and switched off here one at a time.
 */
export function RepositoryLessonsSettings({
  lessons,
  learnedFrom,
  onToggle,
}: {
  lessons: ReadonlyArray<RepositoryLesson>;
  /** What they were learned from and when, as one line. */
  learnedFrom: string;
  onToggle: (id: string, enabled: boolean) => void;
}) {
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 text-muted-foreground text-xs">{learnedFrom}</p>
        <div className="flex gap-2">
          <Button type="button" size="xs" variant="ghost">
            Save to repository
          </Button>
          <Button type="button" size="xs" variant="outline">
            <PlusIcon aria-hidden />
            Add a lesson
          </Button>
        </div>
      </div>
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
                <Badge
                  size="sm"
                  variant={lesson.source === "kept-breaking" ? "warning" : "outline"}
                >
                  {SOURCE_LABELS[lesson.source]}
                </Badge>
                <span className="font-mono">{lesson.where}</span>
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
    </div>
  );
}
