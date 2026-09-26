import type { AdvertisedEndpoint } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveConnectPhoneState,
  resolvePairingCodeStatus,
  selectPhoneEndpoints,
  shouldResumeConnectPhone,
} from "./connectPhone.logic";

function endpoint(
  overrides: Partial<AdvertisedEndpoint> & Pick<AdvertisedEndpoint, "id" | "reachability">,
): AdvertisedEndpoint {
  return {
    label: overrides.id,
    provider: { id: "desktop", label: "Desktop", kind: "core", isAddon: false },
    httpBaseUrl: `http://${overrides.id}:3773`,
    wsBaseUrl: `ws://${overrides.id}:3773`,
    compatibility: { hostedHttpsApp: "mixed-content-blocked", desktopApp: "compatible" },
    source: "desktop-core",
    status: "available",
    ...overrides,
  };
}

const loopback = endpoint({ id: "desktop-loopback:127.0.0.1", reachability: "loopback" });
const lan = endpoint({ id: "desktop-lan:192.168.1.5", reachability: "lan" });
const tailnetIp = endpoint({ id: "tailscale-ip:100.64.0.2", reachability: "private-network" });
const tailnetHttps = endpoint({
  id: "tailscale-magicdns:machine.ts.net",
  reachability: "private-network",
  httpBaseUrl: "https://machine.ts.net",
});

describe("selectPhoneEndpoints", () => {
  it("offers nothing but Tailscale HTTPS while network access is off", () => {
    expect(
      selectPhoneEndpoints({
        endpoints: [loopback, lan, tailnetHttps],
        exposureMode: "local-only",
      }).map((entry) => entry.id),
    ).toEqual([tailnetHttps.id]);
  });

  it("drops loopback and unavailable addresses and puts same-Wi-Fi first", () => {
    expect(
      selectPhoneEndpoints({
        endpoints: [
          loopback,
          tailnetIp,
          endpoint({ id: "desktop-lan:10.0.0.9", reachability: "lan", status: "unavailable" }),
          lan,
        ],
        exposureMode: "network-accessible",
      }).map((entry) => entry.id),
    ).toEqual([lan.id, tailnetIp.id]);
  });

  it("keeps the user's default address first", () => {
    expect(
      selectPhoneEndpoints({
        endpoints: [lan, { ...tailnetIp, isDefault: true }],
        exposureMode: "network-accessible",
      })[0]?.id,
    ).toBe(tailnetIp.id);
  });

  it("skips Tailscale HTTPS until it is up", () => {
    expect(
      selectPhoneEndpoints({
        endpoints: [{ ...tailnetHttps, status: "unknown" }],
        exposureMode: "network-accessible",
      }),
    ).toEqual([]);
  });
});

describe("resolveConnectPhoneState", () => {
  const desktop = (exposureMode: "local-only" | "network-accessible", endpoints = [loopback]) => ({
    desktop: { localEnvironmentDisabled: false, network: { exposureMode, endpoints } },
    web: null,
  });

  it("asks to turn on network access in socket-only mode", () => {
    expect(resolveConnectPhoneState(desktop("local-only")).kind).toBe("needs-network-access");
  });

  it("shows the code once a phone-reachable address exists, with the way back", () => {
    expect(resolveConnectPhoneState(desktop("network-accessible", [loopback, lan]))).toMatchObject({
      kind: "ready",
      canTurnOff: true,
    });
  });

  it("uses Tailscale HTTPS without network access, and offers no turn-off", () => {
    expect(resolveConnectPhoneState(desktop("local-only", [tailnetHttps]))).toMatchObject({
      kind: "ready",
      canTurnOff: false,
    });
  });

  it("reports a missing address instead of a dead QR code", () => {
    expect(resolveConnectPhoneState(desktop("network-accessible")).kind).toBe("no-address");
  });

  it("has no server to pair when the desktop's local environment is off", () => {
    expect(
      resolveConnectPhoneState({
        desktop: { localEnvironmentDisabled: true, network: null },
        web: null,
      }).kind,
    ).toBe("no-server");
  });

  it("pairs a browser's own server only with access-management permission", () => {
    const web = {
      hasServer: true,
      canManageAccess: true,
      origin: "http://localhost:5733",
      originIsLoopback: true,
    };
    expect(resolveConnectPhoneState({ desktop: null, web })).toMatchObject({
      kind: "ready",
      endpoints: [{ httpBaseUrl: "http://localhost:5733", loopback: true }],
    });
    expect(
      resolveConnectPhoneState({ desktop: null, web: { ...web, canManageAccess: false } }).kind,
    ).toBe("no-permission");
    expect(
      resolveConnectPhoneState({ desktop: null, web: { ...web, hasServer: false } }).kind,
    ).toBe("no-server");
  });
});

describe("shouldResumeConnectPhone", () => {
  it("resumes only right after the relaunch it was set for", () => {
    const now = 1_000_000;
    expect(shouldResumeConnectPhone(String(now - 10_000), now)).toBe(true);
    expect(shouldResumeConnectPhone(String(now - 10 * 60_000), now)).toBe(false);
    expect(shouldResumeConnectPhone("1", now)).toBe(false);
    expect(shouldResumeConnectPhone("garbage", now)).toBe(false);
    expect(shouldResumeConnectPhone(null, now)).toBe(false);
  });
});

describe("resolvePairingCodeStatus", () => {
  const base = { expiresAtMs: 100, nowMs: 50, seenInSnapshot: false, inSnapshot: false };

  it("does not call a code paired before the snapshot ever listed it", () => {
    expect(resolvePairingCodeStatus(base)).toBe("active");
  });

  it("calls a listed code paired once it disappears before expiry", () => {
    expect(resolvePairingCodeStatus({ ...base, seenInSnapshot: true })).toBe("paired");
  });

  it("calls it expired when it disappears at or after expiry", () => {
    expect(resolvePairingCodeStatus({ ...base, seenInSnapshot: true, nowMs: 100 })).toBe("expired");
    expect(resolvePairingCodeStatus({ ...base, inSnapshot: true, nowMs: 150 })).toBe("expired");
  });
});
