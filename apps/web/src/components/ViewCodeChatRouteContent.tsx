import type { ReactNode } from "react";

import type { ThreadRouteTarget } from "../threadRoutes";
import { SplitChatSurface } from "../splitView/SplitChatSurface";
import { useActiveSplit } from "../splitView/useSplitView";
import { ThreadTabsHost } from "./tabs/OpenThreadTabs";
import { RecentThreadSwitcher } from "./tabs/RecentThreadSwitcher";

export function ViewCodeChatRouteContent({
  target,
  children,
}: {
  target: ThreadRouteTarget | null;
  children: ReactNode;
}) {
  const split = useActiveSplit();
  return (
    <>
      {target ? (
        <>
          <ThreadTabsHost />
          <RecentThreadSwitcher />
        </>
      ) : null}
      {target?.kind === "server" && split ? (
        <SplitChatSurface pair={split.pair} focusedIndex={split.focusedIndex} />
      ) : (
        children
      )}
    </>
  );
}
