import type { ProjectIconColor } from "@t3tools/contracts";

export const PROJECT_ICON_COLORS: ReadonlyArray<{
  readonly value: ProjectIconColor;
  readonly label: string;
  readonly className: string;
  readonly swatchClassName: string;
  /** Sets `--project-accent` for a project colour's borders, strips and tints. */
  readonly accentClassName: string;
}> = [
  {
    value: "gray",
    label: "Gray",
    className: "text-gray-600 dark:text-gray-400",
    swatchClassName: "bg-gray-500",
    accentClassName:
      "[--project-accent:var(--color-gray-500)] dark:[--project-accent:var(--color-gray-400)]",
  },
  {
    value: "red",
    label: "Red",
    className: "text-red-600 dark:text-red-400",
    swatchClassName: "bg-red-500",
    accentClassName:
      "[--project-accent:var(--color-red-500)] dark:[--project-accent:var(--color-red-400)]",
  },
  {
    value: "orange",
    label: "Orange",
    className: "text-orange-600 dark:text-orange-400",
    swatchClassName: "bg-orange-500",
    accentClassName:
      "[--project-accent:var(--color-orange-500)] dark:[--project-accent:var(--color-orange-400)]",
  },
  {
    value: "amber",
    label: "Amber",
    className: "text-amber-600 dark:text-amber-400",
    swatchClassName: "bg-amber-500",
    accentClassName:
      "[--project-accent:var(--color-amber-500)] dark:[--project-accent:var(--color-amber-400)]",
  },
  {
    value: "yellow",
    label: "Yellow",
    className: "text-yellow-600 dark:text-yellow-400",
    swatchClassName: "bg-yellow-500",
    accentClassName:
      "[--project-accent:var(--color-yellow-500)] dark:[--project-accent:var(--color-yellow-400)]",
  },
  {
    value: "lime",
    label: "Lime",
    className: "text-lime-600 dark:text-lime-400",
    swatchClassName: "bg-lime-500",
    accentClassName:
      "[--project-accent:var(--color-lime-500)] dark:[--project-accent:var(--color-lime-400)]",
  },
  {
    value: "green",
    label: "Green",
    className: "text-green-600 dark:text-green-400",
    swatchClassName: "bg-green-500",
    accentClassName:
      "[--project-accent:var(--color-green-500)] dark:[--project-accent:var(--color-green-400)]",
  },
  {
    value: "emerald",
    label: "Emerald",
    className: "text-emerald-600 dark:text-emerald-400",
    swatchClassName: "bg-emerald-500",
    accentClassName:
      "[--project-accent:var(--color-emerald-500)] dark:[--project-accent:var(--color-emerald-400)]",
  },
  {
    value: "teal",
    label: "Teal",
    className: "text-teal-600 dark:text-teal-400",
    swatchClassName: "bg-teal-500",
    accentClassName:
      "[--project-accent:var(--color-teal-500)] dark:[--project-accent:var(--color-teal-400)]",
  },
  {
    value: "cyan",
    label: "Cyan",
    className: "text-cyan-600 dark:text-cyan-400",
    swatchClassName: "bg-cyan-500",
    accentClassName:
      "[--project-accent:var(--color-cyan-500)] dark:[--project-accent:var(--color-cyan-400)]",
  },
  {
    value: "sky",
    label: "Sky",
    className: "text-sky-600 dark:text-sky-400",
    swatchClassName: "bg-sky-500",
    accentClassName:
      "[--project-accent:var(--color-sky-500)] dark:[--project-accent:var(--color-sky-400)]",
  },
  {
    value: "blue",
    label: "Blue",
    className: "text-blue-600 dark:text-blue-400",
    swatchClassName: "bg-blue-500",
    accentClassName:
      "[--project-accent:var(--color-blue-500)] dark:[--project-accent:var(--color-blue-400)]",
  },
  {
    value: "indigo",
    label: "Indigo",
    className: "text-indigo-600 dark:text-indigo-400",
    swatchClassName: "bg-indigo-500",
    accentClassName:
      "[--project-accent:var(--color-indigo-500)] dark:[--project-accent:var(--color-indigo-400)]",
  },
  {
    value: "violet",
    label: "Violet",
    className: "text-violet-600 dark:text-violet-400",
    swatchClassName: "bg-violet-500",
    accentClassName:
      "[--project-accent:var(--color-violet-500)] dark:[--project-accent:var(--color-violet-400)]",
  },
  {
    value: "purple",
    label: "Purple",
    className: "text-purple-600 dark:text-purple-400",
    swatchClassName: "bg-purple-500",
    accentClassName:
      "[--project-accent:var(--color-purple-500)] dark:[--project-accent:var(--color-purple-400)]",
  },
  {
    value: "fuchsia",
    label: "Fuchsia",
    className: "text-fuchsia-600 dark:text-fuchsia-400",
    swatchClassName: "bg-fuchsia-500",
    accentClassName:
      "[--project-accent:var(--color-fuchsia-500)] dark:[--project-accent:var(--color-fuchsia-400)]",
  },
  {
    value: "pink",
    label: "Pink",
    className: "text-pink-600 dark:text-pink-400",
    swatchClassName: "bg-pink-500",
    accentClassName:
      "[--project-accent:var(--color-pink-500)] dark:[--project-accent:var(--color-pink-400)]",
  },
  {
    value: "rose",
    label: "Rose",
    className: "text-rose-600 dark:text-rose-400",
    swatchClassName: "bg-rose-500",
    accentClassName:
      "[--project-accent:var(--color-rose-500)] dark:[--project-accent:var(--color-rose-400)]",
  },
];

const PROJECT_ICON_COLOR_CLASSES = Object.fromEntries(
  PROJECT_ICON_COLORS.map(({ value, className }) => [value, className]),
) as Record<ProjectIconColor, string>;

export function projectIconColorClassName(color: ProjectIconColor): string {
  return PROJECT_ICON_COLOR_CLASSES[color];
}

const PROJECT_ACCENT_CLASSES = Object.fromEntries(
  PROJECT_ICON_COLORS.map(({ value, accentClassName }) => [value, accentClassName]),
) as Record<ProjectIconColor, string>;

/** The class that sets `--project-accent` for a project colour, in light and dark themes. */
export function projectAccentClassName(color: ProjectIconColor): string {
  return PROJECT_ACCENT_CLASSES[color];
}
