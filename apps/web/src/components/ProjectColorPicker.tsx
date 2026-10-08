import type { ProjectIconColor } from "@t3tools/contracts";
import { CheckIcon } from "lucide-react";
import { create } from "zustand";

import { cn } from "~/lib/utils";
import { projectColorsUsedElsewhere, resolveProjectGroupColor } from "../projectColor.logic";
import { PROJECT_ICON_COLORS } from "../projectIconColors";
import { useSidebarProjectGroups } from "./sidebar/useSidebarProjectGroups";
import { useUpdateProjectGroup } from "./sidebar/useUpdateProjectGroup";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

function SwatchButton(props: {
  readonly label: string;
  readonly selected: boolean;
  readonly disabled: boolean | undefined;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={props.label}
            aria-pressed={props.selected}
            disabled={props.disabled}
            className={cn(
              "relative flex size-7 items-center justify-center rounded-full border border-transparent outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
              props.selected && "border-foreground/64",
            )}
            onClick={props.onClick}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup>{props.label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Default plus every palette colour. A dot marks colours other projects already use, so the
 * user can keep each project distinct.
 */
export function ProjectColorSwatches(props: {
  readonly value: ProjectIconColor | null;
  readonly usedElsewhere: ReadonlySet<ProjectIconColor>;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly onSelect: (color: ProjectIconColor | null) => void;
}) {
  return (
    <div
      className={cn("flex flex-wrap gap-1", props.className)}
      role="group"
      aria-label="Project color"
    >
      <SwatchButton
        label="Default"
        selected={props.value === null}
        disabled={props.disabled}
        onClick={() => props.onSelect(null)}
      >
        <span className="flex size-5 items-center justify-center rounded-full border border-dashed border-muted-foreground/60">
          {props.value === null ? <CheckIcon className="size-3 text-muted-foreground" /> : null}
        </span>
      </SwatchButton>
      {PROJECT_ICON_COLORS.map((option) => {
        const used = props.usedElsewhere.has(option.value);
        return (
          <SwatchButton
            key={option.value}
            label={used ? `${option.label} (used by another project)` : option.label}
            selected={props.value === option.value}
            disabled={props.disabled}
            onClick={() => props.onSelect(option.value)}
          >
            <span className={cn("size-5 rounded-full", option.swatchClassName)} />
            {used ? (
              <span
                aria-hidden
                className="absolute top-0 right-0 size-1.5 rounded-full bg-foreground"
              />
            ) : null}
          </SwatchButton>
        );
      })}
    </div>
  );
}

const useProjectColorRequest = create<{ projectKey: string | null }>(() => ({
  projectKey: null,
}));

/** Opens the colour picker for a project folder, from the sidebar or app rail menu. */
export function openProjectColorDialog(projectKey: string) {
  useProjectColorRequest.setState({ projectKey });
}

function closeProjectColorDialog() {
  useProjectColorRequest.setState({ projectKey: null });
}

function ProjectColorDialogContent(props: { projectKey: string }) {
  const groups = useSidebarProjectGroups();
  const updateProjectGroup = useUpdateProjectGroup();
  const group = groups.find((entry) => entry.projectKey === props.projectKey);
  if (!group) return null;
  return (
    <DialogPopup className="w-full sm:w-[22rem]">
      <DialogHeader>
        <DialogTitle>Project color</DialogTitle>
        <DialogDescription>
          Marks {group.displayName} on its tabs, top bar and rail button.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <ProjectColorSwatches
          value={resolveProjectGroupColor(group)}
          usedElsewhere={projectColorsUsedElsewhere(groups, group.projectKey)}
          onSelect={(projectColor) => {
            updateProjectGroup(
              group,
              { projectColor },
              `Could not change the color for ${group.displayName}`,
            );
            closeProjectColorDialog();
          }}
        />
      </DialogPanel>
    </DialogPopup>
  );
}

export function ProjectColorDialogHost() {
  const projectKey = useProjectColorRequest((state) => state.projectKey);
  return (
    <Dialog
      open={projectKey !== null}
      onOpenChange={(open) => {
        if (!open) closeProjectColorDialog();
      }}
    >
      {projectKey !== null ? <ProjectColorDialogContent projectKey={projectKey} /> : null}
    </Dialog>
  );
}
