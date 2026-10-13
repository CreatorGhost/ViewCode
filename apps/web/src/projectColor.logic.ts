import type { ProjectIconColor } from "@t3tools/contracts";

interface ColoredProject {
  readonly projectColor?: ProjectIconColor | null | undefined;
}

/**
 * A project folder's colour. Edits write every checkout, so members agree; the first one that
 * has a colour wins when they don't (a checkout on a server that predates project colours).
 */
export function resolveProjectGroupColor(
  group: ColoredProject & { readonly memberProjects: ReadonlyArray<ColoredProject> },
): ProjectIconColor | null {
  return (
    group.projectColor ??
    group.memberProjects.find((member) => member.projectColor != null)?.projectColor ??
    null
  );
}

/** Colours other project folders already use, so the picker can mark them. */
export function projectColorsUsedElsewhere(
  groups: ReadonlyArray<
    ColoredProject & {
      readonly projectKey: string;
      readonly memberProjects: ReadonlyArray<ColoredProject>;
    }
  >,
  projectKey: string,
): ReadonlySet<ProjectIconColor> {
  const used = new Set<ProjectIconColor>();
  for (const group of groups) {
    if (group.projectKey === projectKey) continue;
    const color = resolveProjectGroupColor(group);
    if (color !== null) used.add(color);
  }
  return used;
}
