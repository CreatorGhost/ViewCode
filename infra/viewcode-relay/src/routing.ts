/**
 * Routing decisions for the relay Worker, kept free of Workers APIs so they
 * run under plain Node tests.
 */
import { RELAY_HOST_PATH, timingSafeEqualBytes } from "@t3tools/shared/viewcodeRelayProtocol";

export type RelayRoute =
  /** The host's own connection: accept the WebSocket and make it the host. */
  | { readonly kind: "host-connect" }
  /** Something at the host path that is not a valid host connection. */
  | { readonly kind: "reject"; readonly status: 401 | 404 | 426 }
  /** Everything else is forwarded to the host, untouched. */
  | { readonly kind: "proxy" };

export interface RouteInput {
  readonly pathname: string;
  readonly upgrade: string | null;
  /** Whether the Authorization header carried the host secret. */
  readonly hostAuthorized: boolean;
}

/**
 * `/__viewcode/*` belongs to the relay. Only the exact host path with the
 * secret upgrades; phones and browsers can never reach relay-internal paths
 * on the host through the proxy.
 */
export function routeRequest(input: RouteInput): RelayRoute {
  if (input.pathname === RELAY_HOST_PATH) {
    if (!input.hostAuthorized) return { kind: "reject", status: 401 };
    if (input.upgrade?.toLowerCase() !== "websocket") return { kind: "reject", status: 426 };
    return { kind: "host-connect" };
  }
  if (input.pathname.startsWith("/__viewcode/")) return { kind: "reject", status: 404 };
  return { kind: "proxy" };
}

const encoder = new TextEncoder();

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

/**
 * Whether `Authorization: Bearer <secret>` matches. Both sides are hashed
 * first so the comparison always sees equal lengths and its timing does not
 * depend on where the values differ.
 */
export async function isHostAuthorized(
  authorization: string | null,
  secret: string | undefined,
): Promise<boolean> {
  if (!secret || !authorization) return false;
  const match = /^Bearer (.+)$/.exec(authorization);
  if (!match?.[1]) return false;
  const [given, expected] = await Promise.all([sha256(match[1]), sha256(secret)]);
  return timingSafeEqualBytes(given, expected);
}

export interface HostSocketRecord {
  readonly id: string;
  readonly connectedAt: number;
}

/** The connection that is the host: the newest one. */
export function currentHost(sockets: ReadonlyArray<HostSocketRecord>): HostSocketRecord | null {
  let newest: HostSocketRecord | null = null;
  for (const socket of sockets) {
    if (newest === null || socket.connectedAt > newest.connectedAt) newest = socket;
  }
  return newest;
}

/**
 * A new host connection replaces the old one: every other connection is
 * closed. Ties on `connectedAt` favour the socket named `incomingId`.
 */
export function socketsToReplace(
  sockets: ReadonlyArray<HostSocketRecord>,
  incomingId: string,
): ReadonlyArray<string> {
  return sockets.filter((socket) => socket.id !== incomingId).map((socket) => socket.id);
}

/**
 * Whether a closing socket ends the host session. A replaced socket closing
 * late must not tear down the host that replaced it.
 */
export function closeEndsHostSession(
  sockets: ReadonlyArray<HostSocketRecord>,
  closingId: string,
): boolean {
  const remaining = sockets.filter((socket) => socket.id !== closingId);
  return remaining.length === 0;
}

export const HOST_DISCONNECTED_MESSAGE = "ViewCode on your computer isn't connected right now.";
