import { useLocation } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { isSidebarUtilityPage, useNavigateToMainApp } from "./mainAppLocation";

/**
 * Back to the thread you came from, at the start of a utility page's header
 * (Settings, Usage, Pull Requests), on narrow screens only: from md up the title bar's back
 * arrow does this, and two back buttons side by side read as two different places to go.
 * Escape does the same on Settings.
 */
export function UtilityPageBackButton() {
  const onUtilityPage = useLocation({
    select: (location) => isSidebarUtilityPage(location.pathname),
  });
  const navigateToMainApp = useNavigateToMainApp();
  if (!onUtilityPage) return null;
  return (
    <span className="flex md:hidden">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost-muted"
              size="icon-sm"
              aria-label="Back"
              onClick={() => void navigateToMainApp()}
            />
          }
        >
          <ArrowLeftIcon />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Back</TooltipPopup>
      </Tooltip>
    </span>
  );
}
