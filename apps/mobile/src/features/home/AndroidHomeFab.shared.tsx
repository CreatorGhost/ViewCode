import type { ReactNode } from "react";

import type { HomeTerminalTarget } from "./homeTerminalTargets";

/** Other platforms render the list without Android's floating bottom bar and button. */
export function AndroidHomeFabLayout(props: {
  readonly onStartNewTask: () => void;
  /** Phone bar only: the tablet sidebar keeps the plain new-thread button and ignores these. */
  readonly searchQuery?: string;
  readonly onSearchQueryChange?: (query: string) => void;
  /** Projects the terminal button can open, most recently active first. */
  readonly terminalTargets?: ReadonlyArray<HomeTerminalTarget>;
  /** The target for the single selected Home project, which the button opens directly. */
  readonly selectedTerminalTarget?: HomeTerminalTarget | null;
  readonly onOpenTerminal?: (target: HomeTerminalTarget) => void;
  readonly children: ReactNode;
  readonly sidebar?: boolean;
}) {
  return <>{props.children}</>;
}
