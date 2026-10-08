import {
  AUTH_PAIRING_CREDENTIAL_MAX_TTL_SECONDS,
  type AdvertisedEndpoint,
  type DesktopLanReachability,
  type DesktopServerExposureMode,
  type ViewCodeRelaySetupState,
  type ViewCodeRelaySetupStep,
  type ViewCodeRelayState,
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

/**
 * `quick` and `tailscale` are the ways to reach this computer from anywhere;
 * the dialog shows them under one "Anywhere" tab, Quick connect first. ViewCode
 * does not offer upstream's hosted T3 Connect tunnel: Quick connect does that
 * job on the user's own Cloudflare account.
 */
export type ConnectMode = "local" | "quick" | "tailscale";

/** The methods under the Anywhere tab, in the order they are offered. */
export const ANYWHERE_MODES = ["quick", "tailscale"] as const;
export type AnywhereMode = (typeof ANYWHERE_MODES)[number];

export function isAnywhereMode(mode: ConnectMode): mode is AnywhereMode {
  return mode !== "local";
}

/**
 * The methods to offer. Same Wi-Fi and Quick connect are always there (Quick
 * connect explains its own setup). Tailscale appears only when the desktop
 * found the Tailscale CLI on disk (found is not running; that check waits
 * until the user turns it on), so people without Tailscale never see it.
 */
export function resolveConnectModes(input: {
  readonly tailscaleInstalled: boolean;
}): ReadonlyArray<ConnectMode> {
  return ["local", "quick", ...(input.tailscaleInstalled ? (["tailscale"] as const) : [])];
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

export type QuickConnectView =
  /** The connection state has not arrived yet. */
  | { readonly kind: "loading" }
  /** No relay address and secret are stored: offer setup. */
  | { readonly kind: "not-set-up" }
  /** Set up but switched off. */
  | { readonly kind: "off" }
  | { readonly kind: "connecting" }
  | { readonly kind: "reconnecting"; readonly reason: string | null }
  /** The network refuses the relay's certificate; retries continue quietly. */
  | { readonly kind: "blocked"; readonly reason: string | null }
  /** The relay refused this computer's secret; only setup again helps. */
  | { readonly kind: "auth-failed"; readonly reason: string | null }
  | { readonly kind: "ready"; readonly baseUrl: string; readonly host: string };

/** What the Quick connect tab shows. The QR appears only while the relay connection is up. */
export function resolveQuickConnectView(relay: ViewCodeRelayState | null): QuickConnectView {
  if (relay === null) return { kind: "loading" };
  if (!relay.configured) return { kind: "not-set-up" };
  const reason = relay.reason ?? null;
  switch (relay.status) {
    case "off":
      return { kind: "off" };
    case "connecting":
      return { kind: "connecting" };
    case "reconnecting":
      return { kind: "reconnecting", reason };
    case "blocked":
      return { kind: "blocked", reason };
    case "auth-failed":
      return { kind: "auth-failed", reason };
    case "connected": {
      if (relay.httpBaseUrl === undefined) return { kind: "connecting" };
      try {
        return { kind: "ready", baseUrl: relay.httpBaseUrl, host: new URL(relay.httpBaseUrl).host };
      } catch {
        return { kind: "not-set-up" };
      }
    }
  }
}

/** One line for Settings → Connections; a running setup says which step it is on. */
export function describeQuickConnectStatus(
  view: QuickConnectView,
  setup: ViewCodeRelaySetupState | null = null,
): string {
  if (setup?.status === "running") return setup.message ?? "Setting up…";
  if (setup?.status === "needs-subdomain" || setup?.status === "failed") {
    return setup.message ?? "Setup did not finish.";
  }
  switch (view.kind) {
    case "loading":
      return "Checking…";
    case "not-set-up":
      return "Not set up. Connect it to your own free Cloudflare account.";
    case "off":
      return "Off.";
    case "connecting":
      return "Connecting to your relay…";
    case "reconnecting":
      return view.reason ? `Reconnecting. ${view.reason}` : "Reconnecting to your relay…";
    case "blocked":
      return view.reason ?? "This network's certificate is not trusted; still trying.";
    case "auth-failed":
      return view.reason ?? "The relay did not accept this computer's secret.";
    case "ready":
      return `Connected through ${view.host}.`;
  }
}

/** The setup checklist as the person sees it; tool checks count as signing in. */
export const QUICK_CONNECT_SETUP_STEPS: ReadonlyArray<{
  readonly label: string;
  readonly steps: ReadonlyArray<ViewCodeRelaySetupStep>;
}> = [
  { label: "Signing in to Cloudflare", steps: ["checking-tools", "signing-in"] },
  { label: "Setting up your relay", steps: ["deploying"] },
  { label: "Securing it", steps: ["storing-secret"] },
  { label: "Checking it works", steps: ["verifying"] },
];

/**
 * Each checklist row's state for the step that is running now. The running
 * step's message becomes the current row's `note` when it says more than the
 * label (creating a workers.dev address, waiting for the network).
 */
export function resolveSetupChecklist(
  step: ViewCodeRelaySetupStep | undefined,
  message?: string,
): ReadonlyArray<{
  readonly label: string;
  readonly state: "done" | "current" | "pending";
  readonly note?: string;
}> {
  const current = step ?? "checking-tools";
  const currentIndex = QUICK_CONNECT_SETUP_STEPS.findIndex((row) => row.steps.includes(current));
  return QUICK_CONNECT_SETUP_STEPS.map((row, index) => {
    const state = index < currentIndex ? "done" : index === currentIndex ? "current" : "pending";
    const saysMore =
      state === "current" && message !== undefined && message.replace(/…$/u, "") !== row.label;
    return { label: row.label, state, ...(saysMore ? { note: message } : {}) };
  });
}

export const CLOUDFLARE_SIGN_UP_URL = "https://dash.cloudflare.com/sign-up";
/** Workers & Pages of whichever account the person picks, where the workers.dev subdomain is chosen. */
export const CLOUDFLARE_WORKERS_URL = "https://dash.cloudflare.com/?to=/:account/workers-and-pages";
export const NODE_DOWNLOAD_URL = "https://nodejs.org";

export const QUICK_CONNECT_STABLE_NOTE = "Stable address: pair once, reconnects automatically.";

/** Shown wherever a Quick connect code is: the relay is not end-to-end encrypted. */
export const QUICK_CONNECT_TRAFFIC_NOTE =
  "Traffic passes through your own Cloudflare Worker, which can read it, and your company's network may inspect it. It is not end-to-end encrypted. Check your company's policy on remote-access tools before using this on a work computer.";

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
export function canTestLanReachability(input: {
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
