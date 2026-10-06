import { Link } from "@tanstack/react-router";
import { GitForkIcon } from "lucide-react";

/** "Forked from <thread>" at the top of a fork; the title links back to the source. */
export function ForkSourceDivider({
  label,
  source,
  environmentId,
}: {
  label: string;
  environmentId: string | undefined;
  source: { threadId: string; title: string };
}) {
  return (
    <div
      role="separator"
      aria-label={label}
      className="mx-auto flex w-full max-w-3xl items-center gap-3 py-2 text-xs"
    >
      <span className="h-px flex-1 bg-border/70" />
      <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
        <GitForkIcon aria-hidden="true" className="size-3 shrink-0" />
        <span className="shrink-0">Forked from</span>
        {environmentId ? (
          <Link
            to="/$environmentId/$threadId"
            params={{ environmentId, threadId: source.threadId }}
            className="truncate text-foreground underline-offset-2 hover:underline"
          >
            {source.title}
          </Link>
        ) : (
          <span className="truncate">{source.title}</span>
        )}
      </span>
      <span className="h-px flex-1 bg-border/70" />
    </div>
  );
}
