import type { ThemeCardPreviewColors } from "./ThemePreviewCircles";

/**
 * A theme card's picture of the app in that theme: the sidebar strip, two lines of text and
 * the accent, on the theme's own canvas.
 */
export function ThemeMiniPreview({ colors }: { colors: ThemeCardPreviewColors }) {
  return (
    <span
      aria-hidden
      className="flex h-14 w-full overflow-hidden rounded-md"
      style={{
        backgroundColor: colors.canvas,
        boxShadow: "inset 0 0 0 1px rgb(127 127 127 / 0.16)",
      }}
    >
      <span className="w-1/4 shrink-0" style={{ backgroundColor: colors.sidebar }} />
      <span className="flex min-w-0 flex-1 flex-col gap-1.5 px-2 py-2">
        <span
          className="h-1.5 w-4/5 rounded-full"
          style={{ backgroundColor: colors.text, opacity: 0.55 }}
        />
        <span
          className="h-1.5 w-1/2 rounded-full"
          style={{ backgroundColor: colors.text, opacity: 0.3 }}
        />
        <span
          className="mt-auto h-2 w-2/5 rounded-full"
          style={{ backgroundColor: colors.messageAction }}
        />
      </span>
    </span>
  );
}
