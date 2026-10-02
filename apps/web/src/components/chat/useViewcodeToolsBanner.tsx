import { deriveViewcodeToolsNotice } from "@t3tools/client-runtime/viewcode-tools";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { WrenchIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

const DISMISSED_STORAGE_KEY = "viewcode:dismissed-viewcode-tools-notices";

function readDismissed(): ReadonlySet<string> {
  try {
    const raw = window.localStorage.getItem(DISMISSED_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((key) => typeof key === "string") : []);
  } catch {
    return new Set();
  }
}

function rememberDismissed(key: string): void {
  try {
    // Newest last; a few hundred threads is plenty to remember.
    const keys = [...readDismissed(), key].slice(-300);
    window.localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify(keys));
  } catch {
    // Storage is unavailable: the dismissal lasts until the page reloads.
  }
}

/**
 * "ViewCode tools are off for Claude" on a thread whose Claude session runs
 * without ViewCode's MCP server (organization-managed MCP config, or the
 * provider setting). Dismissible per thread; never shown on unmanaged chats.
 */
export function useViewcodeToolsBanner(input: {
  readonly threadId: string | null;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly sessionProviderName: string | null | undefined;
}): ComposerBannerStackItem | null {
  const { threadId, activities, sessionProviderName } = input;
  const [dismissed, setDismissed] = useState(readDismissed);
  const notice = useMemo(
    () =>
      threadId === null
        ? null
        : deriveViewcodeToolsNotice({ threadId, activities, sessionProviderName }),
    [activities, sessionProviderName, threadId],
  );

  return useMemo(() => {
    if (notice === null || dismissed.has(notice.key)) return null;
    return {
      id: notice.key,
      variant: "info",
      icon: <WrenchIcon />,
      title: "ViewCode tools are off for Claude",
      description: notice.text,
      actions: (
        <Popover>
          <PopoverTrigger render={<Button size="xs" variant="ghost" />}>Why?</PopoverTrigger>
          <PopoverPopup
            aria-label="Why ViewCode tools are off"
            tooltipStyle
            side="top"
            className="max-w-80 whitespace-normal"
          >
            {notice.why}
          </PopoverPopup>
        </Popover>
      ),
      dismissLabel: "Dismiss ViewCode tools notice",
      onDismiss: () => {
        rememberDismissed(notice.key);
        setDismissed((current) => new Set([...current, notice.key]));
      },
    };
  }, [dismissed, notice]);
}
