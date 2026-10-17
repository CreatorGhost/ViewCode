import { describe, expect, it } from "vite-plus/test";
import {
  isAdminBlockedProvider,
  providerAccountActionsAvailable,
  providerSetupUnavailableReason,
} from "./providerPolicyUi";

describe("provider policy actions", () => {
  it("authorizes account creation and sign-in independently", () => {
    expect(
      providerAccountActionsAvailable({
        driver: "codex",
        blocked: false,
        canManage: true,
        canWrite: false,
      }),
    ).toEqual({ canAdd: false, canSignIn: true });
    expect(
      providerAccountActionsAvailable({
        driver: "claudeAgent",
        blocked: false,
        canManage: false,
        canWrite: true,
      }),
    ).toEqual({ canAdd: true, canSignIn: false });
    expect(
      providerAccountActionsAvailable({
        driver: "codex",
        blocked: false,
        canManage: false,
        canWrite: false,
      }),
    ).toEqual({ canAdd: false, canSignIn: false });
  });
  it("hides blocked and unsupported account actions even with all permissions", () => {
    for (const driver of ["codex", "claudeAgent", "muse", "droid", "unknown"]) {
      expect(
        providerAccountActionsAvailable({ driver, blocked: true, canManage: true, canWrite: true }),
      ).toEqual({ canAdd: false, canSignIn: false });
    }
    expect(
      providerAccountActionsAvailable({
        driver: "muse",
        blocked: false,
        canManage: true,
        canWrite: true,
      }),
    ).toEqual({ canAdd: false, canSignIn: false });
  });
  it("applies machine policy to native providers and registry aliases before status arrives", () => {
    expect(isAdminBlockedProvider({ driver: "muse" }, ["muse"])).toBe(true);
    expect(
      isAdminBlockedProvider({ driver: "acpRegistry", config: { agentId: "factory-droid" } }, [
        "droid",
      ]),
    ).toBe(true);
    expect(
      isAdminBlockedProvider({ driver: "acpRegistry", config: { agentId: "claude-code" } }, [
        "claudeAgent",
      ]),
    ).toBe(true);
    expect(
      isAdminBlockedProvider({ driver: "acpRegistry", config: { agentId: "allowed" } }, [
        "acpRegistry",
      ]),
    ).toBe(true);
    expect(
      isAdminBlockedProvider({ driver: "acpRegistry", config: { agentId: "allowed" } }, ["droid"]),
    ).toBe(false);
  });
});

describe("provider setup policy", () => {
  it("waits for policy and respects read-only connections before installation", () => {
    const input = {
      instance: { driver: "muse" },
      blockedDrivers: [],
      hasConfiguration: false,
      canManage: true,
    };
    expect(providerSetupUnavailableReason(input)).toBe("Waiting for provider policy.");
    expect(
      providerSetupUnavailableReason({ ...input, hasConfiguration: true, canManage: false }),
    ).toBe("This connection cannot manage providers.");
    expect(providerSetupUnavailableReason({ ...input, hasConfiguration: true })).toBeNull();
  });
  it("blocks the native, registry, and manual registry routes using the same aliases", () => {
    const input = { blockedDrivers: ["droid"], hasConfiguration: true, canManage: true };
    expect(providerSetupUnavailableReason({ ...input, instance: { driver: "droid" } })).toBe(
      "Blocked by your administrator.",
    );
    expect(
      providerSetupUnavailableReason({
        ...input,
        instance: { driver: "acpRegistry", config: { agentId: "factory-droid" } },
      }),
    ).toBe("Blocked by your administrator.");
    expect(
      providerSetupUnavailableReason({
        ...input,
        instance: { driver: "acpRegistry", config: { agentId: "allowed" } },
      }),
    ).toBeNull();
    expect(
      providerSetupUnavailableReason({
        ...input,
        instance: { driver: "acpRegistry", config: { source: "local", commandPath: "/bin/agent" } },
        blockedDrivers: ["acpRegistry"],
      }),
    ).toBe("Blocked by your administrator.");
    expect(
      providerSetupUnavailableReason({
        ...input,
        instance: { driver: "muse" },
        blockedDrivers: [],
      }),
    ).toBeNull();
  });
});
