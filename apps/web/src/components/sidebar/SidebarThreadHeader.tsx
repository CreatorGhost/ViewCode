/**
 * The sidebar's search row: inline search over chats and agents (title, PR and message text),
 * with the command palette's shortcut at its end. The + menu and the phone-only project scope
 * sit in the title row above (SidebarChromeHeader), so this row is search alone.
 */
import { SearchIcon, XIcon } from "lucide-react";
import {
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { cn } from "~/lib/utils";
import { openCommandPalette } from "../../commandPaletteBus";
import { Button } from "../ui/button";
import { SidebarInput, SidebarMenuButton } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface SidebarThreadHeaderProps {
  /** Lands on the search field so a popup can anchor to its width. */
  searchFieldRef?: RefObject<HTMLDivElement | null>;
  /** The command palette's shortcut ("⌘K"); null hides the hint. */
  paletteShortcutLabel: string | null | undefined;
  searchInputRef: RefObject<HTMLInputElement | null>;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  onSearchKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  isSearching: boolean;
  searchResultCount: number;
  activeSearchResultIndex: number;
  onClearSearch: () => void;
}

export function SidebarThreadHeader({
  searchFieldRef,
  paletteShortcutLabel,
  searchInputRef,
  searchQuery,
  onSearchQueryChange,
  onSearchKeyDown,
  isSearching,
  searchResultCount,
  activeSearchResultIndex,
  onClearSearch,
}: SidebarThreadHeaderProps) {
  const resultsVisible = isSearching && searchResultCount > 0;
  // Results shrink as the query narrows, so the active index can outrun the
  // list; pointing aria-activedescendant at a removed option strands the
  // screen reader on nothing.
  const activeResultExists = resultsVisible && activeSearchResultIndex < searchResultCount;

  return (
    <div
      ref={searchFieldRef}
      className="flex h-8 min-w-0 items-center gap-2 rounded-lg bg-sidebar-foreground/6 pr-1 pl-2.5 text-row text-sidebar-muted-foreground focus-within:bg-sidebar-foreground/9 focus-within:text-sidebar-foreground hover:text-sidebar-foreground"
    >
      <SearchIcon className="size-3.5 shrink-0 text-(--sidebar-icon-color)" />
      <SidebarInput
        ref={searchInputRef}
        nativeInput
        type="search"
        value={searchQuery}
        onChange={(event) => onSearchQueryChange(event.currentTarget.value)}
        onKeyDown={onSearchKeyDown}
        placeholder="Search chats"
        aria-label="Search chats and agents"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={resultsVisible}
        aria-controls={resultsVisible ? "sidebar-thread-search-results" : undefined}
        aria-activedescendant={
          activeResultExists ? `sidebar-thread-search-result-${activeSearchResultIndex}` : undefined
        }
        className="min-w-0 flex-1"
      />
      {isSearching ? (
        <Button
          type="button"
          size="icon-micro"
          variant="ghost-muted"
          className="shrink-0"
          aria-label="Clear thread search"
          onClick={() => {
            onClearSearch();
            searchInputRef.current?.focus();
          }}
        >
          <XIcon className="size-3" />
        </Button>
      ) : paletteShortcutLabel ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="micro"
                variant="ghost-muted"
                className="shrink-0"
                aria-label={`Command palette (${paletteShortcutLabel})`}
                onClick={() => openCommandPalette()}
              />
            }
          >
            {paletteShortcutLabel}
          </TooltipTrigger>
          <TooltipPopup side="top">Command palette, also searches chats</TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
}

/**
 * Icon button with a tooltip, sized for the header's segmented pair. Spreads
 * unknown props through so it can serve as a popup trigger's render target,
 * which injects its own handlers, ref and aria state.
 */
export function SidebarHeaderIconButton({
  label,
  tooltip = label,
  className,
  children,
  ...rest
}: {
  /** Accessible name; also the tooltip unless `tooltip` says more. */
  label: string;
  tooltip?: ReactNode;
  className?: string | undefined;
  children?: ReactNode;
} & Omit<
  ComponentProps<typeof SidebarMenuButton>,
  "children" | "className" | "tooltip" | "isActive" | "aria-label"
>) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarMenuButton
            size="icon"
            type="button"
            aria-label={label}
            {...rest}
            className={cn("relative size-7 shrink-0", className)}
          />
        }
      >
        {children}
        {/* Coarse-pointer hit area, matching the rest of the sidebar chrome. */}
        <span
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
        />
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
