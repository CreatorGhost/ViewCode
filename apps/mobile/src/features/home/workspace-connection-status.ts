import type { EnvironmentId } from "@t3tools/contracts";

import type { WorkspaceEnvironment, WorkspaceState } from "../../state/workspaceModel";

export interface WorkspaceConnectionStatusPresentation {
  /** Short enough for the header title slot beside the toolbar icons. */
  readonly label: string;
  /** The full sentence, for the accessibility label. */
  readonly detail: string;
  /** True while actively working (connecting/syncing) — render a spinner. False for offline/error/idle states — render a wifi-slash icon. */
  readonly showsProgress: boolean;
}

function shouldShowWorkspaceConnectionStatus(state: WorkspaceState): boolean {
  return (
    state.networkStatus === "offline" ||
    state.connectionError !== null ||
    state.hasConnectingEnvironment ||
    state.hasPendingShellSnapshot ||
    (state.hasLoadedShellSnapshot && !state.hasReadyEnvironment)
  );
}

// Environment names and error text never fit the title slot, so they move to
// `detail`; the visible label stays a few words.
function workspaceConnectionStatusText(state: WorkspaceState): {
  readonly label: string;
  readonly detail?: string;
} {
  if (state.networkStatus === "offline") return { label: "You are offline" };
  if (state.connectingEnvironments.length === 1) {
    return {
      label: "Reconnecting…",
      detail: `Reconnecting to ${state.connectingEnvironments[0]!.environmentLabel}`,
    };
  }
  if (state.connectingEnvironments.length > 1) {
    return { label: `Reconnecting ${state.connectingEnvironments.length} environments` };
  }
  if (state.connectionError !== null) {
    return { label: "Can't connect", detail: state.connectionError };
  }
  if (state.hasPendingShellSnapshot) {
    return { label: state.hasLoadedShellSnapshot ? "Syncing threads..." : "Loading threads..." };
  }
  return { label: "Not connected" };
}

/** Header-title presentation of the connection state, or null while connected. */
export function workspaceConnectionStatusPresentation(
  state: WorkspaceState,
): WorkspaceConnectionStatusPresentation | null {
  if (!shouldShowWorkspaceConnectionStatus(state)) return null;
  const text = workspaceConnectionStatusText(state);
  return {
    label: text.label,
    detail: text.detail ?? text.label,
    showsProgress:
      state.networkStatus !== "offline" &&
      state.connectionError === null &&
      (state.connectingEnvironments.length > 0 || state.hasPendingShellSnapshot),
  };
}

export interface WorkspaceFleetSubtitle {
  readonly lead: string;
  /** Rendered after a "·" separator; absent when `lead` says it all. */
  readonly tail: string | null;
  readonly tailTone: "muted" | "warning";
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The Home brand block's subtitle: how many computers are enabled and how many
 * are reachable. Switched-off environments are not counted, matching how the
 * rest of the workspace state treats them.
 */
export function workspaceFleetSubtitle(
  networkStatus: WorkspaceState["networkStatus"],
  environments: ReadonlyArray<WorkspaceEnvironment>,
): WorkspaceFleetSubtitle {
  if (networkStatus === "offline") {
    return { lead: "You are offline", tail: null, tailTone: "muted" };
  }
  const enabled = environments.filter((environment) => environment.isEnabled);
  if (enabled.length === 0) {
    return { lead: "No computers connected", tail: null, tailTone: "muted" };
  }
  const online = enabled.filter((environment) => environment.connectionState === "connected");
  // Calm while everything is still dialling in; "offline" would be a false alarm.
  const settling = enabled.every(
    (environment) =>
      environment.connectionState === "connecting" ||
      environment.connectionState === "reconnecting",
  );
  if (online.length === 0 && settling) {
    return { lead: "Connecting…", tail: null, tailTone: "muted" };
  }
  const lead = plural(enabled.length, "computer");
  const offline = enabled.length - online.length;
  return offline > 0
    ? { lead, tail: `${offline} offline`, tailTone: "warning" }
    : { lead, tail: `${online.length} online`, tailTone: "muted" };
}

/** Menu subtitle for one environment. */
export function environmentConnectionLabel(phase: WorkspaceEnvironment["connectionState"]): string {
  if (phase === "connected") return "Online";
  if (phase === "connecting" || phase === "reconnecting") return "Reconnecting…";
  return "Offline";
}

/**
 * Status dot for the environment pill: "online" only when every environment in
 * scope (the selected one, or all enabled ones) is connected.
 */
export function selectedEnvironmentHealth(
  environments: ReadonlyArray<WorkspaceEnvironment>,
  selectedEnvironmentId: EnvironmentId | null,
): "online" | "attention" {
  const scoped =
    selectedEnvironmentId === null
      ? environments.filter((environment) => environment.isEnabled)
      : environments.filter((environment) => environment.environmentId === selectedEnvironmentId);
  return scoped.length > 0 &&
    scoped.every((environment) => environment.connectionState === "connected")
    ? "online"
    : "attention";
}
