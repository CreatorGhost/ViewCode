import {
  AUTH_PAIRING_CREDENTIAL_MAX_TTL_SECONDS,
  type AdvertisedEndpoint,
  type DesktopLanReachability,
  type DesktopServerExposureMode,
  type ManagedTunnelState,
} from "@t3tools/contracts";

/** How long a code minted by the dialog lives; the server caps it at the same value. */
export const CONNECT_PHONE_CODE_TTL_SECONDS = AUTH_PAIRING_CREDENTIAL_MAX_TTL_SECONDS;

/** An address the phone can dial, and how the dialog names it. */
export interface PhoneEndpoint {
  readonly id: string;
  readonly label: string;
  readonly httpBaseUrl: string;
  /** Only this computer can open it: a QR for it would make the phone dial itself. */
  readonly loopback: boolean;
  /** Same-network address the desktop app itself serves, the one a firewall can block. */
  readonly lan: boolean;
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
 * The same-Wi-Fi addresses a phone can use, best first. They only listen while
 * network access is on. Tailscale HTTPS is its own tab.
 */
export function selectPhoneEndpoints(input: {
  readonly endpoints: ReadonlyArray<AdvertisedEndpoint>;
  readonly exposureMode: DesktopServerExposureMode;
}): PhoneEndpoint[] {
  return input.endpoints
    .filter(
      (endpoint) =>
        !isTailscaleHttpsEndpoint(endpoint) &&
        input.exposureMode === "network-accessible" &&
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
      lan: endpoint.reachability === "lan",
    }));
}

export type ConnectMode = "local" | "tailscale" | "cloud";

/**
 * The tabs to offer. Same Wi-Fi is always there. T3 Connect needs the build's
 * relay configuration; a tab that could only say "not configured" is worse
 * than none. Tailscale needs the desktop to have found the Tailscale CLI on
 * disk (found is not running; that check waits until the user turns it on).
 */
export function resolveConnectModes(input: {
  readonly cloudConfigured: boolean;
  readonly tailscaleInstalled: boolean;
}): ReadonlyArray<ConnectMode> {
  return [
    "local",
    ...(input.tailscaleInstalled ? (["tailscale"] as const) : []),
    ...(input.cloudConfigured ? (["cloud"] as const) : []),
  ];
}

/** A remembered tab that is no longer offered falls back to the first one. */
export function resolveSelectedMode(
  selected: ConnectMode,
  modes: ReadonlyArray<ConnectMode>,
): ConnectMode {
  return modes.includes(selected) ? selected : (modes[0] ?? "local");
}

export type TailscaleView =
  /** Serve is up: the QR uses this address. */
  | { readonly kind: "ready"; readonly endpoint: PhoneEndpoint }
  /** Serve is on, but Tailscale gave no address: not running or not signed in. */
  | { readonly kind: "unavailable" }
  | { readonly kind: "off" };

export function resolveTailscaleView(input: {
  readonly serveEnabled: boolean;
  readonly endpoints: ReadonlyArray<AdvertisedEndpoint>;
}): TailscaleView {
  const endpoint = input.endpoints.find(
    (candidate) => isTailscaleHttpsEndpoint(candidate) && candidate.status === "available",
  );
  if (endpoint) {
    return {
      kind: "ready",
      endpoint: {
        id: endpoint.id,
        label: endpoint.label,
        httpBaseUrl: endpoint.httpBaseUrl,
        loopback: false,
        lan: false,
      },
    };
  }
  return input.serveEnabled ? { kind: "unavailable" } : { kind: "off" };
}

export type AnywhereView =
  /** Not linked: offer the one button. */
  | { readonly kind: "off" }
  | { readonly kind: "connecting" }
  /** The network refused the tunnel repeatedly; retries are paused. */
  | { readonly kind: "blocked" }
  /** Registrations keep dying; reconnecting, so no QR yet. */
  | { readonly kind: "unstable-reconnecting" }
  /** Linked before the tunnel address was kept; turning it off and on fixes it. */
  | { readonly kind: "needs-relink" }
  | {
      readonly kind: "ready";
      readonly baseUrl: string;
      readonly host: string;
      /** Registrations have been dying within a minute: warn before the QR. */
      readonly unstable: boolean;
    };

/** What the Anywhere tab shows. The QR appears only while the tunnel is registered. */
export function resolveAnywhereView(input: {
  readonly managedTunnelActive: boolean;
  readonly tunnel: ManagedTunnelState | null;
}): AnywhereView {
  if (!input.managedTunnelActive) return { kind: "off" };
  const tunnel = input.tunnel;
  if (tunnel === null) return { kind: "connecting" };
  if (tunnel.status === "blocked-by-network") return { kind: "blocked" };
  if (!tunnel.registered) {
    return tunnel.status === "unstable"
      ? { kind: "unstable-reconnecting" }
      : { kind: "connecting" };
  }
  if (tunnel.httpBaseUrl === undefined) return { kind: "needs-relink" };
  let host: string;
  try {
    host = new URL(tunnel.httpBaseUrl).host;
  } catch {
    return { kind: "needs-relink" };
  }
  return {
    kind: "ready",
    baseUrl: tunnel.httpBaseUrl,
    host,
    unstable: tunnel.status === "unstable",
  };
}

export const TUNNEL_BLOCKED_MESSAGE =
  "This network blocks tunnel connections (common on corporate networks or VPNs). Same Wi-Fi still works.";

export const TUNNEL_UNSTABLE_MESSAGE =
  "This connection keeps dropping. The phone may connect and then lose the computer. Same Wi-Fi is more reliable on this network.";

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
        lan: false,
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

/** The static "Expires at" text: clock time only, so nothing repaints per second. */
export function formatPairingExpiry(expiresAtMs: number, locale?: string): string {
  return new Date(expiresAtMs).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
}

/**
 * Whether to ask the desktop to call its own LAN address. Only the desktop
 * shell can (web and `npx t3` clients skip it), and only for the address the
 * desktop itself serves.
 */
export function shouldRunLanSelfTest(input: {
  readonly canCheck: boolean;
  readonly endpoint: Pick<PhoneEndpoint, "lan"> | undefined;
}): boolean {
  return input.canCheck && input.endpoint?.lan === true;
}

export const LAN_BLOCKED_MESSAGE =
  "This computer is blocking incoming connections to ViewCode (macOS firewall or security software). Local-network pairing won't work until IT allows ViewCode; running the server with `npx t3` / node may be allowed.";

export const LAN_UNREACHABLE_MESSAGE =
  "The ViewCode server is not reachable, even from this computer. Restart ViewCode and open this again.";

/**
 * The warning for a self-test result, or null when there is nothing to warn
 * about. A result for another address (the network changed mid-test) says
 * nothing about the address on screen.
 */
export function describeLanReachability(
  result: DesktopLanReachability | null,
  shownBaseUrl: string,
): string | null {
  if (result === null || result.url === null) return null;
  try {
    if (new URL(result.url).origin !== new URL(shownBaseUrl).origin) return null;
  } catch {
    return null;
  }
  switch (result.status) {
    case "lan-blocked":
      return LAN_BLOCKED_MESSAGE;
    case "unreachable":
      return LAN_UNREACHABLE_MESSAGE;
    case "ok":
    case "not-applicable":
      return null;
  }
}
