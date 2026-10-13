import type { MenuAction } from "@react-native-menu/menu";
import { useCallback, useMemo } from "react";
import { useWorkspaceState } from "../../state/workspace";
import { HomeScopePills } from "./HomePillToolbar";
import type { HomeHeaderProps } from "./HomeHeader.types";
import {
  environmentConnectionLabel,
  selectedEnvironmentHealth,
} from "./workspace-connection-status";

type HomeScopeFilterProps = Pick<
  HomeHeaderProps,
  | "environments"
  | "projects"
  | "selectedEnvironmentId"
  | "selectedProjectKey"
  | "onEnvironmentChange"
  | "onProjectChange"
  | "onOpenEnvironments"
>;

function checkedMenuState(checked: boolean) {
  return checked ? ("on" as const) : undefined;
}

export function useHomeScopeFilters(props: HomeScopeFilterProps) {
  const { environments: workspaceEnvironments } = useWorkspaceState();
  // The environment pill and the project row each open their own menu; the
  // list ignores sort/group options, so these filters are the whole scope.
  const environmentActions = useMemo<MenuAction[]>(
    () => [
      {
        id: "environment:all",
        title: "All environments",
        state: checkedMenuState(props.selectedEnvironmentId === null),
      },
      ...props.environments.map((environment) => ({
        id: `environment:${environment.environmentId}`,
        title: environment.label,
        subtitle: environmentConnectionLabel(
          workspaceEnvironments.find(
            (candidate) => candidate.environmentId === environment.environmentId,
          )?.connectionState ?? "offline",
        ),
        state: checkedMenuState(props.selectedEnvironmentId === environment.environmentId),
      })),
      { id: "environment-settings", title: "Manage environments" },
    ],
    [props.environments, props.selectedEnvironmentId, workspaceEnvironments],
  );
  const projectActions = useMemo<MenuAction[]>(
    () =>
      props.projects.length === 0
        ? []
        : [
            {
              id: "project:all",
              title: "All projects",
              state: checkedMenuState(props.selectedProjectKey === null),
            },
            ...props.projects.map((project) => ({
              id: `project:${project.key}`,
              title: project.label,
              state: checkedMenuState(props.selectedProjectKey === project.key),
            })),
          ],
    [props.projects, props.selectedProjectKey],
  );
  // One environment needs no "All": the pill names the machine it shows.
  const environmentLabel =
    props.environments.find(
      (environment) => environment.environmentId === props.selectedEnvironmentId,
    )?.label ??
    (props.environments.length === 1 ? props.environments[0]?.label : undefined) ??
    "All environments";
  const projectLabel =
    props.projects.find((project) => project.key === props.selectedProjectKey)?.label ??
    "All projects";

  const handleMenuAction = useCallback(
    (event: { nativeEvent: { event: string } }) => {
      const id = event.nativeEvent.event;
      if (id === "environment-settings") {
        props.onOpenEnvironments();
        return;
      }

      if (id === "environment:all") {
        props.onEnvironmentChange(null);
        return;
      }

      if (id.startsWith("environment:")) {
        const environmentId = id.slice("environment:".length);
        const environment = props.environments.find(
          (candidate) => candidate.environmentId === environmentId,
        );
        if (environment) {
          props.onEnvironmentChange(environment.environmentId);
        }
        return;
      }

      if (id === "project:all") {
        props.onProjectChange(null);
        return;
      }

      if (id.startsWith("project:")) {
        const projectKey = id.slice("project:".length);
        if (props.projects.some((project) => project.key === projectKey)) {
          props.onProjectChange(projectKey);
        }
        return;
      }
    },
    [props],
  );

  return {
    environmentLabel,
    environmentHealth: selectedEnvironmentHealth(
      workspaceEnvironments,
      props.selectedEnvironmentId,
    ),
    environmentActions,
    projectLabel,
    projectActions,
    onMenuAction: handleMenuAction,
    onOpenEnvironments: props.onOpenEnvironments,
  };
}

export function HomeScopeFilters(
  props: HomeScopeFilterProps & {
    readonly onOpenPullRequests?: () => void;
  },
) {
  const scope = useHomeScopeFilters(props);
  return <HomeScopePills {...scope} onOpenPullRequests={props.onOpenPullRequests} />;
}
