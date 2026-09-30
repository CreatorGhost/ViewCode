import type { AdvertisedEndpoint, ViewCodeRelayState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  CONNECT_PHONE_CODE_TTL_SECONDS,
  describeLanReachability,
  describeQuickConnectStatus,
  resolveSetupChecklist,
  formatPairingExpiry,
  LAN_BLOCKED_MESSAGE,
  LAN_UNREACHABLE_MESSAGE,
  resolveAnywhereView,
  resolveConnectModes,
  resolveConnectPhoneState,
  resolveQuickConnectView,
  resolvePairingCodeStatus,
  resolveSelectedMode,
  resolveTailscaleView,
  selectPhoneEndpoints,
  shouldResumeConnectPhone,
  shouldRunLanSelfTest,
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
  it("offers nothing while network access is off", () => {
    expect(
      selectPhoneEndpoints({
        endpoints: [loopback, lan, tailnetHttps],
        exposureMode: "local-only",
      }),
    ).toEqual([]);
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

  it("leaves Tailscale HTTPS to its own tab", () => {
    expect(
      selectPhoneEndpoints({
        endpoints: [tailnetHttps, lan],
        exposureMode: "network-accessible",
      }).map((entry) => entry.id),
    ).toEqual([lan.id]);
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

  it("does not treat Tailscale HTTPS as a same-Wi-Fi address", () => {
    expect(resolveConnectPhoneState(desktop("local-only", [tailnetHttps])).kind).toBe(
      "needs-network-access",
    );
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

describe("LAN self-test", () => {
  const shown = "http://192.168.1.5:3773/";

  it("warns only about the address on screen", () => {
    expect(describeLanReachability({ status: "lan-blocked", url: shown }, shown)).toBe(
      LAN_BLOCKED_MESSAGE,
    );
    expect(describeLanReachability({ status: "unreachable", url: shown }, shown)).toBe(
      LAN_UNREACHABLE_MESSAGE,
    );
    expect(
      describeLanReachability(
        { status: "lan-blocked", url: "http://10.0.0.9:3773" },
        "http://192.168.1.5:3773",
      ),
    ).toBeNull();
  });

  it("is quiet when the LAN address works or there is nothing to test", () => {
    expect(describeLanReachability({ status: "ok", url: shown }, shown)).toBeNull();
    expect(describeLanReachability({ status: "not-applicable", url: null }, shown)).toBeNull();
    expect(describeLanReachability(null, shown)).toBeNull();
  });

  it("runs only on the desktop shell for the LAN address", () => {
    expect(shouldRunLanSelfTest({ canCheck: true, endpoint: { lan: true } })).toBe(true);
    expect(shouldRunLanSelfTest({ canCheck: true, endpoint: { lan: false } })).toBe(false);
    expect(shouldRunLanSelfTest({ canCheck: false, endpoint: { lan: true } })).toBe(false);
    expect(shouldRunLanSelfTest({ canCheck: true, endpoint: undefined })).toBe(false);
  });
});

describe("pairing code lifetime", () => {
  it("mints dialog codes for fifteen minutes", () => {
    expect(CONNECT_PHONE_CODE_TTL_SECONDS).toBe(900);
  });

  it("shows a clock time, not a countdown", () => {
    expect(formatPairingExpiry(Date.UTC(2026, 0, 1, 15, 42), "en-US")).toMatch(/\d{1,2}:\d{2}/);
  });
});

describe("resolveConnectModes", () => {
  it("always offers same Wi-Fi and Quick connect, and hides what is not available", () => {
    expect(resolveConnectModes({ cloudConfigured: false, tailscaleInstalled: false })).toEqual([
      "local",
      "quick",
    ]);
  });

  it("puts Quick connect before T3 Connect and Tailscale, which appear only when available", () => {
    expect(resolveConnectModes({ cloudConfigured: false, tailscaleInstalled: true })).toEqual([
      "local",
      "quick",
      "tailscale",
    ]);
    expect(resolveConnectModes({ cloudConfigured: true, tailscaleInstalled: true })).toEqual([
      "local",
      "quick",
      "cloud",
      "tailscale",
    ]);
  });

  it("falls back to the first tab when a remembered one is gone", () => {
    expect(resolveSelectedMode("cloud", ["local", "quick"])).toBe("local");
    expect(resolveSelectedMode("quick", ["local", "quick"])).toBe("quick");
  });
});

describe("resolveQuickConnectView", () => {
  const relay = (
    partial: Partial<ViewCodeRelayState> & Pick<ViewCodeRelayState, "status">,
  ): ViewCodeRelayState => ({
    configured: true,
    ...partial,
  });

  it("waits for the state, then asks for setup when nothing is stored", () => {
    expect(resolveQuickConnectView(null)).toEqual({ kind: "loading" });
    expect(resolveQuickConnectView({ status: "off", configured: false })).toEqual({
      kind: "not-set-up",
    });
  });

  it("says what the connection is doing, with its reason", () => {
    expect(resolveQuickConnectView(relay({ status: "off" }))).toEqual({ kind: "off" });
    expect(resolveQuickConnectView(relay({ status: "connecting" }))).toEqual({
      kind: "connecting",
    });
    expect(resolveQuickConnectView(relay({ status: "reconnecting", reason: "dropped" }))).toEqual({
      kind: "reconnecting",
      reason: "dropped",
    });
    expect(resolveQuickConnectView(relay({ status: "blocked", reason: "cert" }))).toEqual({
      kind: "blocked",
      reason: "cert",
    });
    expect(resolveQuickConnectView(relay({ status: "auth-failed" }))).toEqual({
      kind: "auth-failed",
      reason: null,
    });
  });

  it("shows the QR address only while connected, and never without an address", () => {
    expect(
      resolveQuickConnectView(
        relay({ status: "connected", httpBaseUrl: "https://viewcode-relay.me.workers.dev" }),
      ),
    ).toEqual({
      kind: "ready",
      baseUrl: "https://viewcode-relay.me.workers.dev",
      host: "viewcode-relay.me.workers.dev",
    });
    expect(resolveQuickConnectView(relay({ status: "connected" }))).toEqual({ kind: "connecting" });
    expect(
      resolveQuickConnectView(relay({ status: "connected", httpBaseUrl: "nonsense" })),
    ).toEqual({
      kind: "not-set-up",
    });
  });
});

describe("describeQuickConnectStatus", () => {
  it("gives Settings one honest line per state", () => {
    expect(describeQuickConnectStatus({ kind: "not-set-up" })).toContain("Cloudflare account");
    // A running setup outranks the connection's own line.
    expect(
      describeQuickConnectStatus(
        { kind: "not-set-up" },
        { status: "running", step: "deploying", message: "Setting up your relay…" },
      ),
    ).toBe("Setting up your relay…");
    expect(describeQuickConnectStatus({ kind: "off" })).toBe("Off.");
    expect(
      describeQuickConnectStatus({ kind: "reconnecting", reason: "The connection dropped." }),
    ).toBe("Reconnecting. The connection dropped.");
    expect(describeQuickConnectStatus({ kind: "reconnecting", reason: null })).toBe(
      "Reconnecting to your relay…",
    );
    expect(describeQuickConnectStatus({ kind: "blocked", reason: "cert not trusted" })).toBe(
      "cert not trusted",
    );
    expect(
      describeQuickConnectStatus({
        kind: "ready",
        baseUrl: "https://r.a.workers.dev",
        host: "r.a.workers.dev",
      }),
    ).toBe("Connected through r.a.workers.dev.");
  });
});

describe("resolveTailscaleView", () => {
  it("shows the QR address once Serve is up", () => {
    expect(
      resolveTailscaleView({ serveEnabled: true, endpoints: [lan, tailnetHttps] }),
    ).toMatchObject({ kind: "ready", endpoint: { httpBaseUrl: "https://machine.ts.net" } });
  });

  it("offers Turn on while Serve is off, and explains a Serve that has no address", () => {
    expect(resolveTailscaleView({ serveEnabled: false, endpoints: [lan] }).kind).toBe("off");
    expect(
      resolveTailscaleView({
        serveEnabled: true,
        endpoints: [{ ...tailnetHttps, status: "unavailable" }],
      }).kind,
    ).toBe("unavailable");
  });
});

describe("resolveAnywhereView", () => {
  const tunnel = (
    overrides: Partial<NonNullable<Parameters<typeof resolveAnywhereView>[0]["tunnel"]>>,
  ) => ({
    status: "connected" as const,
    registered: true,
    httpBaseUrl: "https://abc.example.test",
    ...overrides,
  });

  it("offers the button while T3 Connect is off, whatever the tunnel says", () => {
    expect(resolveAnywhereView({ managedTunnelActive: false, tunnel: tunnel({}) })).toEqual({
      kind: "off",
    });
  });

  it("shows the QR only while the tunnel is registered", () => {
    expect(resolveAnywhereView({ managedTunnelActive: true, tunnel: null }).kind).toBe(
      "connecting",
    );
    expect(
      resolveAnywhereView({
        managedTunnelActive: true,
        tunnel: tunnel({ status: "connecting", registered: false }),
      }).kind,
    ).toBe("connecting");
    expect(resolveAnywhereView({ managedTunnelActive: true, tunnel: tunnel({}) })).toEqual({
      kind: "ready",
      baseUrl: "https://abc.example.test",
      host: "abc.example.test",
      unstable: false,
    });
  });

  it("pauses on a blocked network, even if a stale registration flag lingers", () => {
    expect(
      resolveAnywhereView({
        managedTunnelActive: true,
        tunnel: tunnel({ status: "blocked-by-network" }),
      }).kind,
    ).toBe("blocked");
  });

  it("warns before the QR when the tunnel is unstable, and hides it while reconnecting", () => {
    expect(
      resolveAnywhereView({ managedTunnelActive: true, tunnel: tunnel({ status: "unstable" }) }),
    ).toMatchObject({ kind: "ready", unstable: true });
    expect(
      resolveAnywhereView({
        managedTunnelActive: true,
        tunnel: tunnel({ status: "unstable", registered: false }),
      }).kind,
    ).toBe("unstable-reconnecting");
  });

  it("asks to turn T3 Connect off and on when the tunnel address was never kept", () => {
    const { httpBaseUrl: _omitted, ...withoutUrl } = tunnel({});
    expect(resolveAnywhereView({ managedTunnelActive: true, tunnel: withoutUrl }).kind).toBe(
      "needs-relink",
    );
  });
});

describe("resolveSetupChecklist", () => {
  it("ticks off the steps before the running one", () => {
    expect(resolveSetupChecklist("storing-secret").map((row) => row.state)).toEqual([
      "done",
      "done",
      "current",
      "pending",
    ]);
    // Checking for Node is shown as part of signing in.
    expect(resolveSetupChecklist("checking-tools")[0]!.state).toBe("current");
    expect(resolveSetupChecklist("verifying").at(-1)!.state).toBe("current");
  });
});
