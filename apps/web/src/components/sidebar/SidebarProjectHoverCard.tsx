import type { ReactElement } from "react";

import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "../ui/preview-card";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { threadCountLabel } from "./sidebarHoverCard.logic";

/** Hover card for a project header: where it lives and how much is in it. */
export function SidebarProjectHoverCard(props: {
  group: SidebarProjectSnapshot;
  threadCount: number;
  children: ReactElement;
}) {
  const { group } = props;
  return (
    <PreviewCard>
      <PreviewCardTrigger delay={700} closeDelay={60} render={props.children} />
      <PreviewCardPopup side="right" align="start" sideOffset={8}>
        <div className="flex w-64 max-w-full flex-col gap-1.5 p-3">
          <span className="truncate font-semibold text-sm">{group.displayName}</span>
          <span className="break-all text-muted-foreground text-xs leading-snug [direction:rtl] [text-align:left]">
            <bdi>{group.workspaceRoot}</bdi>
          </span>
          <div className="flex items-center gap-2 text-muted-foreground text-xs">
            <span>{threadCountLabel(props.threadCount)}</span>
            {group.groupedProjectCount > 1 ? (
              <span>· {group.groupedProjectCount} environments</span>
            ) : null}
          </div>
        </div>
      </PreviewCardPopup>
    </PreviewCard>
  );
}
