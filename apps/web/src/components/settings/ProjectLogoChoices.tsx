import type { EnvironmentId } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { useProjectIconCandidates } from "../files/projectFilesQueryState";
import { ProjectFavicon } from "../ProjectFavicon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * The logos found in a project, as tiles to pick from: the one ViewCode chose on its own first,
 * then the other likely marks (ProjectFaviconResolver.listCandidates). Renders nothing until the
 * search finds at least one, so projects without images keep the picker unchanged.
 */
export function ProjectLogoChoices(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly projectName: string;
  /** Whether the project shows a logo now, rather than an icon, emoji or monogram. */
  readonly showsLogo: boolean;
  /** The logo the user picked; null while ViewCode chooses (the first candidate). */
  readonly savedPath: string | null;
  readonly onSelect: (path: string) => void;
}) {
  const { paths } = useProjectIconCandidates(props.environmentId, props.cwd, props.projectName);
  if (paths.length === 0) return null;
  return (
    <div>
      <div className="mb-2 text-xs font-medium text-muted-foreground">Logos in this project</div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Logos in this project">
        {paths.map((path) => {
          const selected = props.showsLogo && (props.savedPath ?? paths[0]) === path;
          return (
            <Tooltip key={path}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={`Use ${path}`}
                    aria-pressed={selected}
                    className={cn(
                      "flex size-11 items-center justify-center rounded-lg border border-border bg-muted/40 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                      selected && "border-foreground/64 bg-accent",
                    )}
                    onClick={() => props.onSelect(path)}
                  >
                    <ProjectFavicon
                      project={{
                        environmentId: props.environmentId,
                        workspaceRoot: props.cwd,
                        title: props.projectName,
                        faviconPath: path,
                        projectIcon: null,
                      }}
                      className="size-6"
                    />
                  </button>
                }
              />
              <TooltipPopup>{path}</TooltipPopup>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}
