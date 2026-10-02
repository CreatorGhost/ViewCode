import type { WorkspaceState } from "../../state/workspaceModel";

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
