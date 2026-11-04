import type { ReactNode } from "react";

/** Reserve both widths so revealing actions cannot move the disclosure or PR link under a pointer. */
export function SidebarThreadRowControls(props: { resting: ReactNode; actions: ReactNode }) {
  return (
    <span className="grid shrink-0 items-center">
      <span className="col-start-1 row-start-1 flex items-center justify-self-end gap-1.5 group-hover/sidebar-row:invisible group-focus-visible/sidebar-row:invisible group-has-[:focus-visible]/sidebar-row:invisible">
        {props.resting}
      </span>
      <span className="pointer-events-none col-start-1 row-start-1 flex items-center justify-self-end gap-0.5 opacity-0 group-hover/sidebar-row:pointer-events-auto group-hover/sidebar-row:opacity-100 group-focus-visible/sidebar-row:pointer-events-auto group-focus-visible/sidebar-row:opacity-100 group-has-[:focus-visible]/sidebar-row:pointer-events-auto group-has-[:focus-visible]/sidebar-row:opacity-100">
        {props.actions}
      </span>
    </span>
  );
}
