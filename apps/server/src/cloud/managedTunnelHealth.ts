import type { ManagedTunnelStatus } from "@t3tools/contracts";

/**
 * ViewCode: what cloudflared's output says about whether a phone could use the
 * managed tunnel. Corporate TLS inspection and always-on VPNs leave two
 * signatures: the edge's certificate is refused outright, or a registration
 * succeeds and then starves. Both look like a working tunnel to the relay, so
 * the host has to say so itself.
 */

/** Consecutive refused TLS handshakes before retries pause. */
export const TLS_REFUSALS_BEFORE_BLOCKED = 3;
/** A registration that dies sooner than this counts as a short-lived one. */
export const SHORT_REGISTRATION_MS = 60_000;
/** Short-lived registrations in a row before the tunnel is called unstable. */
export const SHORT_REGISTRATIONS_BEFORE_UNSTABLE = 2;

export type TunnelSignal = "registered" | "tls-refused" | "edge-lost";

export function classifyTunnelSignal(line: string): TunnelSignal | null {
  if (/\bRegistered tunnel connection\b/iu.test(line)) return "registered";
  if (
    /x509: certificate signed by unknown authority|decrypt-untrust|tls: failed to verify certificate/iu.test(
      line,
    )
  ) {
    return "tls-refused";
  }
  if (
    /timeout: no recent network activity|failed to dial to edge with quic: timeout|\bUnregistered tunnel connection\b/iu.test(
      line,
    )
  ) {
    return "edge-lost";
  }
  return null;
}

export interface TunnelHealth {
  readonly status: ManagedTunnelStatus;
  readonly registered: boolean;
  readonly tlsRefusals: number;
  readonly shortRegistrations: number;
  readonly registeredAtMs: number | null;
}

export const initialTunnelHealth: TunnelHealth = {
  status: "connecting",
  registered: false,
  tlsRefusals: 0,
  shortRegistrations: 0,
  registeredAtMs: null,
};

export type TunnelHealthEvent =
  | { readonly type: TunnelSignal; readonly nowMs: number }
  /** The connector process was (re)started, or exited on its own. */
  | { readonly type: "spawned" | "exited"; readonly nowMs: number }
  /** A registration has now been up long enough to count as healthy. */
  | { readonly type: "stable"; readonly nowMs: number }
  /** The user asked to try again after a pause. */
  | { readonly type: "retry"; readonly nowMs: number };

export function reduceTunnelHealth(health: TunnelHealth, event: TunnelHealthEvent): TunnelHealth {
  switch (event.type) {
    case "registered":
      // A refusal streak ends the moment the edge accepts us. Blocked stays
      // blocked: the connector is stopped then, so this is a late stray line.
      return health.status === "blocked-by-network"
        ? health
        : {
            ...health,
            status:
              health.shortRegistrations >= SHORT_REGISTRATIONS_BEFORE_UNSTABLE
                ? "unstable"
                : "connected",
            registered: true,
            tlsRefusals: 0,
            registeredAtMs: health.registeredAtMs ?? event.nowMs,
          };
    case "tls-refused": {
      if (health.status === "blocked-by-network") return health;
      const tlsRefusals = health.tlsRefusals + 1;
      return {
        ...health,
        status: tlsRefusals >= TLS_REFUSALS_BEFORE_BLOCKED ? "blocked-by-network" : health.status,
        registered: false,
        registeredAtMs: null,
        tlsRefusals,
      };
    }
    case "edge-lost":
    case "exited": {
      if (health.status === "blocked-by-network") return health;
      // Several lines report one death; only the first sees a live registration.
      if (health.registeredAtMs === null) {
        return { ...health, registered: false };
      }
      const short = event.nowMs - health.registeredAtMs < SHORT_REGISTRATION_MS;
      const shortRegistrations = short ? health.shortRegistrations + 1 : 0;
      return {
        ...health,
        status:
          shortRegistrations >= SHORT_REGISTRATIONS_BEFORE_UNSTABLE ? "unstable" : "connecting",
        registered: false,
        registeredAtMs: null,
        shortRegistrations,
      };
    }
    case "spawned":
      return health.status === "blocked-by-network"
        ? health
        : {
            ...health,
            status: health.status === "unstable" ? "unstable" : "connecting",
            registered: false,
            registeredAtMs: null,
          };
    case "stable":
      if (
        health.registeredAtMs === null ||
        event.nowMs - health.registeredAtMs < SHORT_REGISTRATION_MS
      ) {
        return health;
      }
      return { ...health, status: "connected", shortRegistrations: 0 };
    case "retry":
      return initialTunnelHealth;
  }
}

/** Only these states have a tunnel a phone can reach right now. */
export function isTunnelReachable(health: TunnelHealth): boolean {
  return health.registered && health.status !== "blocked-by-network";
}
