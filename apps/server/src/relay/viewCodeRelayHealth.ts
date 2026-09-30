import type { ViewCodeRelayState, ViewCodeRelayStatus } from "@t3tools/contracts";

import * as NetAddress from "effect/unstable/net/NetAddress";

import { TLS_REFUSALS_BEFORE_BLOCKED } from "../cloud/managedTunnelHealth.ts";

/**
 * ViewCode Quick connect: what a failed attempt to reach the relay says about
 * why. Same idea as `cloud/managedTunnelHealth.ts`: a TLS-inspecting network
 * shows up as an untrusted issuer, or as a connection reset during the TLS
 * handshake (a firewall that drops a host by SNI), several times in a row, and
 * that is a different message from "offline". Everything here is pure.
 */

export type DialFailure =
  /** The relay answered 401: the host secret does not match its Worker secret. */
  | { readonly kind: "auth" }
  /** The certificate chain ended at an issuer this computer does not trust. */
  | { readonly kind: "tls-untrusted"; readonly detail: string }
  /** The connection was reset or closed before TLS finished: a firewall dropping this host. */
  | { readonly kind: "network-reset"; readonly detail: string }
  | { readonly kind: "network"; readonly detail: string };

const UNTRUSTED_ISSUER =
  /SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT|CERT_UNTRUSTED|self[- ]signed certificate|unable to verify the first certificate|unable to get local issuer certificate/iu;

/**
 * Node and undici spell a reset several ways: `ECONNRESET` (`read ECONNRESET`),
 * undici's `SocketError` "other side closed" with code `UND_ERR_SOCKET`, `socket
 * hang up`, and "Client network socket disconnected before secure TLS connection
 * was established". Timeouts, DNS failures and HTTP errors are not resets.
 */
const CONNECTION_RESET =
  /ECONNRESET|ECONNABORTED|UND_ERR_SOCKET|socket hang up|other side closed|disconnected before secure TLS connection/iu;

/** Classifies a low-level connection error (its code and message, joined). */
export function classifyDialError(text: string): DialFailure {
  if (UNTRUSTED_ISSUER.test(text)) return { kind: "tls-untrusted", detail: text };
  if (CONNECTION_RESET.test(text)) return { kind: "network-reset", detail: text };
  return { kind: "network", detail: text };
}

/** Flattens an error and its causes into one searchable string. */
export function describeErrorChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    if (typeof current === "object") {
      const { code, message, cause } = current as {
        code?: unknown;
        message?: unknown;
        cause?: unknown;
      };
      if (typeof code === "string") parts.push(code);
      if (typeof message === "string") parts.push(message);
      current = cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(" ");
}

export const RELAY_REASON = {
  network: "Can't reach your relay right now.",
  dropped: "The connection dropped.",
  silent: "The connection went silent.",
  // The two `blocked` reasons complete "Your network blocked the connection to the relay (...)".
  untrusted: "an untrusted certificate intercepted it",
  untrustedRetrying: "This network's security certificate isn't trusted by this computer.",
  reset: "the network reset the connection to the relay",
  resetRetrying: "The network reset the connection to the relay.",
  auth: "The relay didn't accept this computer's secret. Run the setup command again.",
} as const;

export interface RelayHealth {
  readonly status: ViewCodeRelayStatus;
  readonly reason: string | undefined;
  /** Consecutive attempts refused by the network: an untrusted issuer or a reset. */
  readonly tlsRefusals: number;
  /** A connection has been up since this session started. */
  readonly hasConnected: boolean;
}

export const initialRelayHealth: RelayHealth = {
  status: "off",
  reason: undefined,
  tlsRefusals: 0,
  hasConnected: false,
};

export type RelayHealthEvent =
  | { readonly type: "off" }
  | { readonly type: "attempt" }
  | { readonly type: "connected" }
  | { readonly type: "dropped"; readonly reason: string }
  | { readonly type: "dial-failed"; readonly failure: DialFailure };

export function reduceRelayHealth(health: RelayHealth, event: RelayHealthEvent): RelayHealth {
  switch (event.type) {
    case "off":
      return initialRelayHealth;
    case "attempt":
      // While blocked or unauthorised the reason stays: another try is not news.
      return health.status === "blocked" || health.status === "auth-failed"
        ? health
        : {
            ...health,
            status:
              health.hasConnected || health.reason !== undefined ? "reconnecting" : "connecting",
          };
    case "connected":
      return { status: "connected", reason: undefined, tlsRefusals: 0, hasConnected: true };
    case "dropped":
      return { ...health, status: "reconnecting", reason: event.reason, tlsRefusals: 0 };
    case "dial-failed": {
      const { failure } = event;
      if (failure.kind === "auth") {
        return { ...health, status: "auth-failed", reason: RELAY_REASON.auth, tlsRefusals: 0 };
      }
      if (failure.kind === "tls-untrusted" || failure.kind === "network-reset") {
        const untrusted = failure.kind === "tls-untrusted";
        const tlsRefusals = health.tlsRefusals + 1;
        return tlsRefusals >= TLS_REFUSALS_BEFORE_BLOCKED
          ? {
              ...health,
              status: "blocked",
              reason: untrusted ? RELAY_REASON.untrusted : RELAY_REASON.reset,
              tlsRefusals,
            }
          : {
              ...health,
              status: "reconnecting",
              reason: untrusted ? RELAY_REASON.untrustedRetrying : RELAY_REASON.resetRetrying,
              tlsRefusals,
            };
      }
      return { ...health, status: "reconnecting", reason: RELAY_REASON.network, tlsRefusals: 0 };
    }
  }
}

export function toViewCodeRelayState(
  health: RelayHealth,
  config: { readonly configured: boolean; readonly origin: string | undefined },
): ViewCodeRelayState {
  return {
    status: health.status,
    configured: config.configured,
    ...(health.reason === undefined ? {} : { reason: health.reason }),
    ...(config.origin === undefined ? {} : { httpBaseUrl: config.origin }),
  };
}

export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;
/** A connection that lasted at least this long earns a fresh backoff. */
export const STABLE_CONNECTION_MS = 30_000;

/**
 * Delay before reconnect attempt number `attempt` (0 is the first retry):
 * doubles from 1s to a 30s cap, with up to half of it shaved off at random so
 * many hosts behind one outage do not return in lockstep. `random` is [0, 1).
 */
export function reconnectDelayMs(attempt: number, random: number): number {
  const ceiling = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(attempt, 10));
  return Math.round(ceiling * (1 - 0.5 * random));
}

export type LocalTarget =
  | { readonly kind: "tcp"; readonly host: string; readonly port: number }
  | { readonly kind: "socket"; readonly path: string };

/**
 * Where forwarded requests are sent. A wildcard bind answers on loopback; a
 * bind to one specific interface only answers there. A socket-mode server
 * (desktop with no TCP port) is reached through its Unix socket or pipe.
 */
export function resolveLocalTarget(address: NetAddress.SocketAddress): LocalTarget {
  if (address._tag === "UnixPathAddress") return { kind: "socket", path: address.path };
  return {
    kind: "tcp",
    host: NetAddress.isUnspecified(address.address)
      ? "127.0.0.1"
      : NetAddress.formatIp(address.address),
    port: address.port,
  };
}
