import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { ArrowLeftToLineIcon, ArrowRightToLineIcon, XIcon } from "lucide-react";

import { useThreadTabsStore } from "../../threadTabsStore";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "../CommandPalette.logic";
import { adjacentThreadTab } from "./threadTabs.logic";

/**
 * Command-palette entries for the open-thread tabs. Same behaviour as the shortcuts in
 * ThreadTabsHost; empty when there is no thread, or only one tab to move between.
 */
export function buildThreadTabActions(
  active: ScopedThreadRef | null,
  navigateToThread: (ref: ScopedThreadRef) => void,
  goHome: () => void,
): Array<CommandPaletteActionItem> {
  if (!active) return [];
  const store = useThreadTabsStore.getState();
  const tabs = store.tabsByEnvironmentId[active.environmentId] ?? [];
  const activeKey = scopedThreadKey(active);
  const move = (direction: "next" | "previous") => async () => {
    const ref = parseScopedThreadKey(adjacentThreadTab(tabs, activeKey, direction) ?? "");
    if (ref) navigateToThread(ref);
  };
  const items: Array<CommandPaletteActionItem> = [];
  if (tabs.length > 1) {
    items.push(
      {
        kind: "action",
        value: "action:tab-next",
        searchTerms: ["tab", "next", "thread", "switch"],
        title: "Next thread tab",
        icon: <ArrowRightToLineIcon className={ITEM_ICON_CLASS} />,
        shortcutCommand: "tab.next",
        run: move("next"),
      },
      {
        kind: "action",
        value: "action:tab-previous",
        searchTerms: ["tab", "previous", "thread", "switch"],
        title: "Previous thread tab",
        icon: <ArrowLeftToLineIcon className={ITEM_ICON_CLASS} />,
        shortcutCommand: "tab.previous",
        run: move("previous"),
      },
    );
  }
  items.push({
    kind: "action",
    value: "action:tab-close",
    searchTerms: ["tab", "close", "thread"],
    title: "Close thread tab",
    icon: <XIcon className={ITEM_ICON_CLASS} />,
    shortcutCommand: "tab.close",
    run: async () => {
      const next = parseScopedThreadKey(
        store.close(active.environmentId, activeKey, activeKey) ?? "",
      );
      if (next) navigateToThread(next);
      else goHome();
    },
  });
  return items;
}
