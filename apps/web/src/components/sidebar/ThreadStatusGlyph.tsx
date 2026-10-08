import { CircleAlertIcon, HandIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import type { SidebarThreadStatus } from "../Sidebar.logic";
import { Spinner } from "../ui/spinner";

/**
 * The mark a thread row or tab leads with when the thread wants a look: needs you (approval or
 * input), working, or failed. Null for the quiet states, so callers fall through to their own
 * glyph with `??`.
 */
export function threadStatusGlyph(status: SidebarThreadStatus, size: "xs" | "sm") {
  const iconClassName = size === "xs" ? "size-3" : "size-3.5";
  switch (status) {
    case "approval":
    case "input":
      return (
        <HandIcon
          role="img"
          aria-label={status === "approval" ? "Needs approval" : "Needs input"}
          className={cn(iconClassName, "text-warning")}
        />
      );
    case "working":
      return <Spinner size={size} tone="muted" aria-label="Working" />;
    case "failed":
      return (
        <CircleAlertIcon
          role="img"
          aria-label="Failed"
          className={cn(iconClassName, "text-destructive-foreground")}
        />
      );
    default:
      return null;
  }
}
