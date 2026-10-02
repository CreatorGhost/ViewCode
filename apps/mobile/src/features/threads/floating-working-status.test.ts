import { describe, expect, it, vi } from "vite-plus/test";

import { connectionFloatingStatus } from "./floating-working-status";

const status = (
  connectionState: Parameters<typeof connectionFloatingStatus>[0]["connectionState"],
  overrides: { connectionError?: string | null; environmentLabel?: string | null } = {},
) =>
  connectionFloatingStatus({
    connectionError: overrides.connectionError ?? null,
    connectionState,
    environmentLabel:
      overrides.environmentLabel === undefined ? "Mac mini" : overrides.environmentLabel,
    onReconnect: () => {},
  });

describe("connectionFloatingStatus", () => {
  it("yields the pill to sync and working state once connected", () => {
    expect(status("connected")).toBeNull();
  });

  it("keeps the label short and names the environment in the detail", () => {
    expect(status("connecting")).toMatchObject({
      tone: "reconnecting",
      label: "Reconnecting…",
      detail: "Reconnecting to Mac mini",
    });
    expect(status("reconnecting", { connectionError: "ECONNREFUSED" })).toMatchObject({
      tone: "reconnecting",
      label: "Can't connect · retrying",
      detail: "Failed to connect. Retrying Mac mini: ECONNREFUSED",
    });
  });

  it("reports why the environment is unreachable", () => {
    expect(status("offline")).toMatchObject({ tone: "unavailable", label: "You are offline" });
    expect(status("available")).toMatchObject({
      tone: "unavailable",
      label: "Disconnected",
      detail: "Mac mini is not connected",
    });
    expect(status("error", { connectionError: "handshake timed out" })).toMatchObject({
      label: "Can't connect",
      detail: "Failed to connect to Mac mini: handshake timed out",
    });
  });

  it("falls back to a generic name when the environment has no label", () => {
    expect(status("error", { environmentLabel: null })).toMatchObject({
      detail: "Failed to connect to Environment",
    });
  });

  it("carries the reconnect handler so the pill can trigger it", () => {
    const onReconnect = vi.fn();
    const pill = connectionFloatingStatus({
      connectionError: null,
      connectionState: "offline",
      environmentLabel: "Mac mini",
      onReconnect,
    });
    if (pill?.kind !== "connection") throw new Error("expected a connection pill");
    pill.onPress();
    expect(onReconnect).toHaveBeenCalledOnce();
  });
});
