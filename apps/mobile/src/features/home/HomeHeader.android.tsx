import type { MenuAction } from "@react-native-menu/menu";
import { useCallback, useMemo } from "react";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { HomePillToolbar } from "./HomePillToolbar";
import type { HomeHeaderProps } from "./HomeHeader.types";

export type { HomeHeaderEnvironment } from "./HomeHeader.types";

function checkedMenuState(checked: boolean) {
  return checked ? ("on" as const) : undefined;
}

export function HomeHeader(props: HomeHeaderProps) {
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
        state: checkedMenuState(props.selectedEnvironmentId === environment.environmentId),
      })),
      { id: "environment-settings", title: "Manage environments" },
    ],
    [props.environments, props.selectedEnvironmentId],
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

  return (
    <>
      <NativeStackScreenOptions options={{ headerShown: false }} />
      <HomePillToolbar
        searchQuery={props.searchQuery}
        onSearchQueryChange={props.onSearchQueryChange}
        environmentLabel={environmentLabel}
        environmentActions={environmentActions}
        projectLabel={projectLabel}
        projectActions={projectActions}
        onMenuAction={handleMenuAction}
        onOpenSettings={props.onOpenSettings}
        onOpenEnvironments={props.onOpenEnvironments}
        onOpenUsage={props.onOpenUsage}
      />
    </>
  );
}
