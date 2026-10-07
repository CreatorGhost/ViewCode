import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { useThreadShells } from "../../state/entities";
import { useThreadTabsStore } from "../../threadTabsStore";
import { isSidechat } from "../chat/sidechat.logic";
import { recentViewCandidates, stepRecentSelection } from "./threadTabs.logic";

/**
 * Ctrl-Tab / Ctrl-Shift-Tab: a most-recently-used list of threads. Holding Ctrl keeps the overlay
 * open and each Tab steps deeper; releasing Ctrl commits. Escape cancels. The key is Ctrl on every
 * platform (Cmd-Tab belongs to macOS), and the overlay renders only while it is open.
 */
export function RecentThreadSwitcher() {
  const navigate = useNavigate();
  const shells = useThreadShells();
  const [selected, setSelected] = useState<number | null>(null);
  const selectedRef = useRef<number | null>(null);
  const shellsByKey = useMemo(
    () =>
      new Map(
        shells.map((shell) => [
          scopedThreadKey({ environmentId: shell.environmentId, threadId: shell.id }),
          shell,
        ]),
      ),
    [shells],
  );
  const candidates = useRef<ReadonlyArray<string>>([]);
  const [keys, setKeys] = useState<ReadonlyArray<string>>([]);

  useEffect(() => {
    const finish = (commit: boolean) => {
      const index = selectedRef.current;
      selectedRef.current = null;
      setSelected(null);
      if (!commit || index === null) return;
      const ref = parseScopedThreadKey(candidates.current[index] ?? "");
      if (ref) {
        void navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: ref.environmentId, threadId: ref.threadId },
        });
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (selectedRef.current !== null && event.key === "Escape") {
        event.preventDefault();
        finish(false);
        return;
      }
      if (event.key !== "Tab" || !event.ctrlKey || event.metaKey || event.altKey) return;
      if (selectedRef.current === null) {
        candidates.current = recentViewCandidates(
          useThreadTabsStore.getState().recentThreadKeys,
          (key) => {
            const shell = shellsByKey.get(key);
            return shell !== undefined && shell.archivedAt == null && !isSidechat(shell);
          },
        );
        if (candidates.current.length < 2) return;
        setKeys(candidates.current);
      }
      event.preventDefault();
      event.stopPropagation();
      // The first press lands on the previous thread (index 1); the current one is index 0.
      const next =
        selectedRef.current === null
          ? event.shiftKey
            ? candidates.current.length - 1
            : 1
          : stepRecentSelection(
              candidates.current.length,
              selectedRef.current,
              event.shiftKey ? "backward" : "forward",
            );
      selectedRef.current = next;
      setSelected(next);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Control" && selectedRef.current !== null) finish(true);
    };
    const onBlur = () => {
      if (selectedRef.current !== null) finish(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [navigate, shellsByKey]);

  if (selected === null) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-[150] flex items-start justify-center pt-32">
      <div
        role="listbox"
        aria-label="Recent threads"
        className="pointer-events-auto flex w-[min(28rem,calc(100vw-2rem))] flex-col gap-0.5 rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-lg"
      >
        {keys.map((key, index) => (
          <div
            key={key}
            role="option"
            aria-selected={index === selected}
            className={cn(
              "truncate rounded-md px-2.5 py-1.5 text-sm",
              index === selected ? "bg-accent text-accent-foreground" : "text-muted-foreground",
            )}
          >
            {shellsByKey.get(key)?.title ?? key}
          </div>
        ))}
      </div>
    </div>
  );
}
