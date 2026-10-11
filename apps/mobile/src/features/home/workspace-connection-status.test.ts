import { describe, expect, it } from "vite-plus/test";

import type { WorkspaceState } from "../../state/workspaceModel";
import type { WorkspaceEnvironment } from "../../state/workspaceModel";
import {
  environmentConnectionLabel,
  selectedEnvironmentHealth,
  workspaceConnectionStatusPresentation,
  workspaceFleetSubtitle,
} from "./workspace-connection-status";

function environment(
  id: string,
  overrides: Partial<WorkspaceEnvironment> = {},
): WorkspaceEnvironment {
  return {
    environmentId: id as never,
    environmentLabel: id,
    displayUrl: "",
    isEnabled: true,
    connectionState: "connected",
    connectionError: null,
    connectionErrorTraceId: null,
    ...overrides,
  };
}

function workspaceState(overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  return {
    isLoadingConnections: false,
    hasConnections: true,
    hasLoadedShellSnapshot: true,
    hasPendingShellSnapshot: false,
    hasReadyEnvironment: true,
    hasConnectingEnvironment: false,
    connectingEnvironments: [],
    connectionState: "connected",
    connectionError: null,
    shellSnapshotError: null,
    latestCachedSnapshotReceivedAt: null,
    networkStatus: "online",
    ...overrides,
  };
}

describe("workspace connection status", () => {
  it("stays hidden while a ready environment is connected", () => {
    expect(workspaceConnectionStatusPresentation(workspaceState())).toBeNull();
  });

  it("surfaces offline snapshots", () => {
    const state = workspaceState({ networkStatus: "offline", hasReadyEnvironment: false });

    expect(workspaceConnectionStatusPresentation(state)).toEqual({
      label: "You are offline",
      detail: "You are offline",
      showsProgress: false,
    });
  });

  it("keeps the environment name out of the title but in the detail", () => {
    const state = workspaceState({
      hasConnectingEnvironment: true,
      hasReadyEnvironment: false,
      connectingEnvironments: [
        {
          environmentId: "environment-1" as never,
          environmentLabel: "Julius’s Mac mini",
          displayUrl: "",
          isEnabled: true,
          connectionState: "reconnecting",
          connectionError: null,
          connectionErrorTraceId: null,
        },
      ],
    });

    expect(workspaceConnectionStatusPresentation(state)).toEqual({
      label: "Reconnecting…",
      detail: "Reconnecting to Julius’s Mac mini",
      showsProgress: true,
    });
  });

  it("surfaces connection errors before the generic disconnected fallback", () => {
    const state = workspaceState({
      connectionError: "Could not reach Julius’s Mac mini",
      hasLoadedShellSnapshot: false,
      hasReadyEnvironment: false,
    });

    expect(workspaceConnectionStatusPresentation(state)).toEqual({
      label: "Can't connect",
      detail: "Could not reach Julius’s Mac mini",
      showsProgress: false,
    });
  });

  it("shows shell catch-up while cached threads remain visible", () => {
    const state = workspaceState({ hasPendingShellSnapshot: true });

    expect(workspaceConnectionStatusPresentation(state)).toEqual({
      label: "Syncing threads...",
      detail: "Syncing threads...",
      showsProgress: true,
    });
  });

  it("distinguishes initial shell loading from cached catch-up", () => {
    const state = workspaceState({
      hasLoadedShellSnapshot: false,
      hasPendingShellSnapshot: true,
    });

    expect(workspaceConnectionStatusPresentation(state)).toEqual({
      label: "Loading threads...",
      detail: "Loading threads...",
      showsProgress: true,
    });
  });
});

describe("workspace fleet subtitle", () => {
  it("counts online computers and singularises one", () => {
    expect(workspaceFleetSubtitle("online", [environment("a")])).toEqual({
      lead: "1 computer",
      tail: "1 online",
      tailTone: "muted",
    });
    expect(workspaceFleetSubtitle("online", [environment("a"), environment("b")])).toEqual({
      lead: "2 computers",
      tail: "2 online",
      tailTone: "muted",
    });
  });

  it("warns about environments that are not online", () => {
    const subtitle = workspaceFleetSubtitle("online", [
      environment("a"),
      environment("b", { connectionState: "offline" }),
      environment("c", { connectionState: "reconnecting" }),
    ]);

    expect(subtitle).toEqual({ lead: "3 computers", tail: "2 offline", tailTone: "warning" });
  });

  it("ignores switched-off environments", () => {
    const subtitle = workspaceFleetSubtitle("online", [
      environment("a"),
      environment("b", { isEnabled: false, connectionState: "offline" }),
    ]);

    expect(subtitle).toEqual({ lead: "1 computer", tail: "1 online", tailTone: "muted" });
  });

  it("stays calm while every environment is still connecting", () => {
    const subtitle = workspaceFleetSubtitle("online", [
      environment("a", { connectionState: "connecting" }),
      environment("b", { connectionState: "reconnecting" }),
    ]);

    expect(subtitle).toEqual({ lead: "Connecting…", tail: null, tailTone: "muted" });
  });

  it("reports the network being offline before counting", () => {
    expect(workspaceFleetSubtitle("offline", [environment("a")])).toEqual({
      lead: "You are offline",
      tail: null,
      tailTone: "muted",
    });
  });

  it("handles having no enabled environments", () => {
    expect(workspaceFleetSubtitle("online", [])).toEqual({
      lead: "No computers connected",
      tail: null,
      tailTone: "muted",
    });
  });
});

describe("environment connection label and health", () => {
  it("maps phases to menu subtitles", () => {
    expect(environmentConnectionLabel("connected")).toBe("Online");
    expect(environmentConnectionLabel("connecting")).toBe("Reconnecting…");
    expect(environmentConnectionLabel("reconnecting")).toBe("Reconnecting…");
    expect(environmentConnectionLabel("error")).toBe("Offline");
    expect(environmentConnectionLabel("offline")).toBe("Offline");
  });

  it("is healthy for all environments only when every enabled one is connected", () => {
    const offlineButDisabled = environment("b", { isEnabled: false, connectionState: "offline" });
    expect(selectedEnvironmentHealth([environment("a"), offlineButDisabled], null)).toBe("online");
    expect(
      selectedEnvironmentHealth(
        [environment("a"), environment("c", { connectionState: "error" })],
        null,
      ),
    ).toBe("attention");
  });

  it("follows the selected environment alone", () => {
    const environments = [environment("a"), environment("b", { connectionState: "offline" })];
    expect(selectedEnvironmentHealth(environments, "a" as never)).toBe("online");
    expect(selectedEnvironmentHealth(environments, "b" as never)).toBe("attention");
    expect(selectedEnvironmentHealth(environments, "missing" as never)).toBe("attention");
  });
});
