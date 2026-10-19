import * as Schema from "effect/Schema";
import { ChevronRightIcon, LayersIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "../../lib/utils";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { Separator } from "../ui/separator";

const STORAGE_KEY = "viewcode:pull-requests:collapsed-groups";
const CollapsedGroupKeys = Schema.Array(Schema.String);

/** Retain the existing saved folder state across the orchestrator upgrade. */
export function ViewCodePullRequestProjectGroup({
  group,
  project,
  showHeader,
  children,
}: {
  group: {
    readonly key: string;
    readonly label: string;
    readonly repositoryLabel?: string | null;
    readonly entries: ReadonlyArray<{ readonly viewerLogin?: string | undefined }>;
  };
  project?: ProjectFaviconProject | undefined;
  showHeader: boolean;
  children: ReactNode;
}) {
  const [collapsedGroups, setCollapsedGroups] = useLocalStorage(
    STORAGE_KEY,
    [],
    CollapsedGroupKeys,
  );
  const collapsed = showHeader && collapsedGroups.includes(group.key);
  const accounts = [
    ...new Set(
      group.entries.flatMap((entry) => (entry.viewerLogin ? [`@${entry.viewerLogin}`] : [])),
    ),
  ];
  return (
    <div className="space-y-0.5">
      {showHeader ? (
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() =>
            setCollapsedGroups((current) =>
              current.includes(group.key)
                ? current.filter((key) => key !== group.key)
                : [...current, group.key],
            )
          }
          className="group/header flex w-full items-center gap-2 px-3 pb-1 text-left text-xs font-medium text-muted-foreground/70 hover:text-muted-foreground"
        >
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3 shrink-0 text-muted-foreground/50 transition-transform group-hover/header:text-muted-foreground",
              !collapsed && "rotate-90",
            )}
          />
          {project ? (
            <ProjectFavicon project={project} className="size-3.5 shrink-0" />
          ) : (
            <LayersIcon aria-hidden className="size-3.5 shrink-0" />
          )}
          <h2 className="min-w-0 truncate">{group.label}</h2>
          {group.repositoryLabel ? (
            <span className="min-w-0 truncate font-normal text-muted-foreground/60">
              · {group.repositoryLabel}
            </span>
          ) : null}
          {accounts.length > 0 ? (
            <span className="min-w-0 truncate font-normal text-muted-foreground/50">
              {accounts.join(", ")}
            </span>
          ) : null}
          <span className="shrink-0 tabular-nums text-muted-foreground/50">
            {group.entries.length}
          </span>
          <Separator className="min-w-2 flex-1" />
        </button>
      ) : null}
      {collapsed ? null : children}
    </div>
  );
}
