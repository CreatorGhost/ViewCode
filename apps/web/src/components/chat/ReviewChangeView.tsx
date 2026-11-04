import { reviewedChangeLabel, reviewNoChangesText } from "@t3tools/client-runtime/agent-review";
import type { EnvironmentId, LocalReviewScope, ProjectId } from "@t3tools/contracts";

import { useClientSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";
import { StyledDiffCodeView } from "../diffs/StyledDiffCodeView";
import { type ReviewDiffTarget, useReviewDiff } from "./useReviewDiff";

/**
 * The change a review is reading, before it has sent any findings: the same diff the findings
 * will sit on, so the reader can start reading while the reviewer works.
 */
export function ReviewChangeView({
  environmentId,
  target,
  scope,
  projectId,
  cwd,
}: {
  environmentId: EnvironmentId;
  target: ReviewDiffTarget;
  /** What of the local changes the running review reads. */
  scope: LocalReviewScope | null;
  projectId: ProjectId | null;
  cwd: string | undefined;
}) {
  const diff = useReviewDiff({ environmentId, target, projectId, cwd: cwd ?? null, scope });
  const { resolvedTheme } = useTheme();
  const settings = useClientSettings();
  const items = (() =>
    diff.files.map(({ fileKey, fileDiff }) => ({
      id: fileKey,
      type: "diff" as const,
      fileDiff,
    })))();
  const options = (() => ({
    diffStyle: "unified" as const,
    lineDiffType: "none" as const,
    overflow: settings.wordWrap ? ("wrap" as const) : ("scroll" as const),
    theme: resolveDiffThemeName(resolvedTheme),
    preferredHighlighter: PREFERRED_HIGHLIGHTER,
    themeType: resolvedTheme,
    stickyHeaders: true,
    ...(diff.loadDiffFiles ? { loadDiffFiles: diff.loadDiffFiles } : {}),
  }))();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <p className="flex items-baseline gap-2 border-b border-border/60 px-3 py-2 text-xs">
        <span className="min-w-0 flex-1 truncate">
          <span className="text-muted-foreground">Reviewing </span>
          <span className="font-medium">{reviewedChangeLabel(target, scope, diff.base)}</span>
        </span>
        {items.length > 0 ? (
          <span className="shrink-0 text-muted-foreground tabular-nums">
            {items.length === 1 ? "1 file" : `${items.length} files`}
          </span>
        ) : null}
      </p>
      {diff.partial || diff.error !== null ? (
        <p className="border-b border-border/60 px-3 py-1.5 text-muted-foreground text-xs">
          {diff.error !== null
            ? `The change could not be loaded: ${diff.error}`
            : "Part of the change is not shown here."}
        </p>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col">
        {items.length > 0 ? (
          <StyledDiffCodeView
            className="@container h-full overflow-auto [scrollbar-gutter:stable]"
            items={items}
            options={options}
          />
        ) : diff.pending ? (
          <p className="px-3 py-2 text-muted-foreground text-sm" role="status">
            Loading the change...
          </p>
        ) : diff.error === null ? (
          <p className="px-3 py-2 text-muted-foreground text-sm">
            {reviewNoChangesText(target, scope, diff.base)}
          </p>
        ) : null}
      </div>
    </div>
  );
}
