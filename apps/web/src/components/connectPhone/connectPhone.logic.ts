import type { AdvertisedEndpoint, DesktopServerExposureMode } from "@t3tools/contracts";

/** An address the phone can dial, and how the dialog names it. */
export interface PhoneEndpoint {
  readonly id: string;
  readonly label: string;
  readonly httpBaseUrl: string;
  /** Only this computer can open it: a QR for it would make the phone dial itself. */
  readonly loopback: boolean;
}

export type ConnectPhoneState =
  | { readonly kind: "loading" }
  /** No local server here (hosted app, or the desktop's local environment is off). */
  | { readonly kind: "no-server" }
  /** Connected, but this session may not create pairing links. */
  | { readonly kind: "no-permission" }
  /** Desktop in socket-only mode: turning on network access relaunches the app. */
  | { readonly kind: "needs-network-access" }
  /** Network access is on, but no address other devices can reach was found. */
  | { readonly kind: "no-address" }
  | {
      readonly kind: "ready";
      readonly endpoints: ReadonlyArray<PhoneEndpoint>;
      /** Desktop with network access on: the dialog offers the way back to no-port mode. */
      readonly canTurnOff: boolean;
    };

const REACHABILITY_ORDER: Record<AdvertisedEndpoint["reachability"], number> = {
  lan: 0,
  "private-network": 1,
  public: 2,
  loopback: 3,
};

function isTailscaleHttpsEndpoint(endpoint: AdvertisedEndpoint): boolean {
  return endpoint.id.startsWith("tailscale-magicdns:");
}

/**
 * The addresses a phone can use, best first. Plain network endpoints only
 * listen while network access is on; Tailscale HTTPS is its own route and
 * counts whenever it is up. Same-Wi-Fi addresses lead because that is the
 * setup most people have.
 */
export function selectPhoneEndpoints(input: {
  readonly endpoints: ReadonlyArray<AdvertisedEndpoint>;
  readonly exposureMode: DesktopServerExposureMode;
}): PhoneEndpoint[] {
  return input.endpoints
    .filter((endpoint) =>
      isTailscaleHttpsEndpoint(endpoint)
        ? endpoint.status === "available"
        : input.exposureMode === "network-accessible" &&
          endpoint.status !== "unavailable" &&
          endpoint.reachability !== "loopback",
    )
    .toSorted(
      (left, right) =>
        Number(right.isDefault === true) - Number(left.isDefault === true) ||
        REACHABILITY_ORDER[left.reachability] - REACHABILITY_ORDER[right.reachability],
    )
    .map((endpoint) => ({
      id: endpoint.id,
      label: endpoint.label,
      httpBaseUrl: endpoint.httpBaseUrl,
      loopback: false,
    }));
}

export function resolveConnectPhoneState(input: {
  /** Null outside the desktop app. */
  readonly desktop: {
    readonly localEnvironmentDisabled: boolean;
    /** Null while the desktop's network state loads. */
    readonly network: {
      readonly exposureMode: DesktopServerExposureMode;
      readonly endpoints: ReadonlyArray<AdvertisedEndpoint>;
    } | null;
  } | null;
  /** Web only: the connected server's session, or null while it loads. */
  readonly web: {
    readonly hasServer: boolean;
    readonly canManageAccess: boolean;
    readonly origin: string;
    readonly originIsLoopback: boolean;
  } | null;
}): ConnectPhoneState {
  const { desktop, web } = input;
  if (desktop) {
    if (desktop.localEnvironmentDisabled) return { kind: "no-server" };
    if (!desktop.network) return { kind: "loading" };
    const endpoints = selectPhoneEndpoints(desktop.network);
    const networkAccessible = desktop.network.exposureMode === "network-accessible";
    if (endpoints.length > 0) {
      return { kind: "ready", endpoints, canTurnOff: networkAccessible };
    }
    return networkAccessible ? { kind: "no-address" } : { kind: "needs-network-access" };
  }
  if (!web) return { kind: "loading" };
  if (!web.hasServer) return { kind: "no-server" };
  if (!web.canManageAccess) return { kind: "no-permission" };
  return {
    kind: "ready",
    endpoints: [
      {
        id: "current-origin",
        label: new URL(web.origin).host,
        httpBaseUrl: web.origin,
        loopback: web.originIsLoopback,
      },
    ],
    canTurnOff: false,
  };
}

/**
 * "Turn on and restart" relaunches the desktop app, which loses the open
 * dialog. It leaves this flag behind so the relaunched app opens straight to
 * the QR code. The flag holds a timestamp: if no relaunch happens, a stale
 * flag must not pop the dialog on some later launch.
 */
export const CONNECT_PHONE_RESUME_KEY = "viewcode:open-connect-phone";
const CONNECT_PHONE_RESUME_WINDOW_MS = 2 * 60_000;

export function shouldResumeConnectPhone(stored: string | null, nowMs: number): boolean {
  if (stored === null) return false;
  const setAtMs = Number(stored);
  return (
    Number.isFinite(setAtMs) &&
    nowMs - setAtMs >= 0 &&
    nowMs - setAtMs <= CONNECT_PHONE_RESUME_WINDOW_MS
  );
}

/**
 * Tracks one pairing code through its life. A code is "paired" once the
 * server removes its link before expiry, which it does when a device
 * consumes it. The link has to have been seen first: the access snapshot can
 * arrive before the freshly created link shows up in it.
 */
export function resolvePairingCodeStatus(input: {
  readonly expiresAtMs: number;
  readonly nowMs: number;
  readonly seenInSnapshot: boolean;
  readonly inSnapshot: boolean;
}): "active" | "paired" | "expired" {
  if (input.seenInSnapshot && !input.inSnapshot) {
    return input.nowMs < input.expiresAtMs ? "paired" : "expired";
  }
  return input.nowMs < input.expiresAtMs ? "active" : "expired";
}
