import type { SidebarAttentionFilter } from "@t3tools/client-runtime/state/thread-arrangement";
import { CheckIcon, XIcon } from "lucide-react";
import { memo, type ReactNode } from "react";

import { Button } from "../ui/button";

const ITEMS: ReadonlyArray<{
  readonly id: SidebarAttentionFilter;
  readonly label: (count: number) => string;
  readonly glyph: ReactNode;
}> = [
  {
    id: "needs-you",
    label: (count) => `${count} ${count === 1 ? "needs" : "need"} you`,
    glyph: <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning-foreground" />,
  },
  {
    id: "working",
    label: (count) => `${count} working`,
    glyph: <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-info" />,
  },
  {
    id: "new",
    label: (count) => `${count} new`,
    glyph: <CheckIcon aria-hidden className="size-3" />,
  },
];

/**
 * The strip under search: how many chats and agents wait on the user, are working, or finished
 * since last opened. Each item narrows the list to those threads (with the chats they sit in);
 * Clear goes back. Items at zero hide, except the one filtering, and the strip goes away when
 * nothing needs a look. Counts arrive as numbers, so the strip renders only when one changes.
 */
export const SidebarAttentionStrip = memo(function SidebarAttentionStrip(props: {
  needsYou: number;
  working: number;
  fresh: number;
  active: SidebarAttentionFilter | null;
  onChange: (filter: SidebarAttentionFilter | null) => void;
}) {
  const { active, onChange } = props;
  const countOf: Record<SidebarAttentionFilter, number> = {
    "needs-you": props.needsYou,
    working: props.working,
    new: props.fresh,
  };
  const items = ITEMS.filter((item) => countOf[item.id] > 0 || item.id === active);
  if (items.length === 0) return null;
  return (
    <div
      role="group"
      aria-label="Show only"
      data-sidebar-attention-strip=""
      className="flex flex-wrap items-center gap-1"
    >
      {items.map((item) => {
        const pressed = item.id === active;
        return (
          <Button
            key={item.id}
            size="chip"
            variant="chip"
            aria-pressed={pressed}
            data-pressed={pressed ? "" : undefined}
            onClick={() => onChange(pressed ? null : item.id)}
          >
            {item.glyph}
            <span className="tabular-nums">{item.label(countOf[item.id])}</span>
          </Button>
        );
      })}
      {active ? (
        <Button
          size="chip"
          variant="chip"
          aria-label="Show everything"
          onClick={() => onChange(null)}
        >
          Clear
          <XIcon aria-hidden />
        </Button>
      ) : null}
    </div>
  );
});
