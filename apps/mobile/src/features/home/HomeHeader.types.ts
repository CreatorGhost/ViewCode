import type { EnvironmentId } from "@t3tools/contracts";
import type {
  HomeListFilterMenuEnvironment,
  HomeListFilterMenuProject,
} from "./home-list-filter-menu";
import type { HomeTerminalTarget } from "./homeTerminalTargets";

export type HomeHeaderEnvironment = HomeListFilterMenuEnvironment;

export interface HomeHeaderProps {
  readonly environments: ReadonlyArray<HomeHeaderEnvironment>;
  readonly projects: ReadonlyArray<HomeListFilterMenuProject>;
  readonly searchQuery: string;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectKey: string | null;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onProjectChange: (projectKey: string | null) => void;
  readonly onOpenEnvironments: () => void;
  readonly onOpenSettings: () => void;
  /** Subscription limits and usage-limit resumes. */
  readonly onOpenUsage: () => void;
  readonly onStartNewTask: () => void;
  /** ViewCode: Home's scope row opens the pull request list on both platforms. */
  readonly onOpenPullRequests?: () => void;
  /** iOS opens a terminal from Home's header; Android's bottom bar takes these directly. */
  readonly terminalTargets: ReadonlyArray<HomeTerminalTarget>;
  readonly selectedTerminalTarget: HomeTerminalTarget | null;
  readonly onOpenTerminal: (target: HomeTerminalTarget) => void;
}
