import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const AdvertisedEndpointProviderKind = Schema.Literals([
  "core",
  "private-network",
  "tunnel",
  "manual",
]);
export type AdvertisedEndpointProviderKind = typeof AdvertisedEndpointProviderKind.Type;

export const AdvertisedEndpointReachability = Schema.Literals([
  "loopback",
  "lan",
  "private-network",
  "public",
]);
export type AdvertisedEndpointReachability = typeof AdvertisedEndpointReachability.Type;

export const AdvertisedEndpointHostedHttpsCompatibility = Schema.Literals([
  "compatible",
  "mixed-content-blocked",
  "requires-configuration",
  "unknown",
]);
export type AdvertisedEndpointHostedHttpsCompatibility =
  typeof AdvertisedEndpointHostedHttpsCompatibility.Type;

export const AdvertisedEndpointStatus = Schema.Literals(["available", "unavailable", "unknown"]);
export type AdvertisedEndpointStatus = typeof AdvertisedEndpointStatus.Type;

export const AdvertisedEndpointSource = Schema.Literals([
  "desktop-core",
  "desktop-addon",
  "server",
  "user",
]);
export type AdvertisedEndpointSource = typeof AdvertisedEndpointSource.Type;

export const AdvertisedEndpointProvider = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  kind: AdvertisedEndpointProviderKind,
  isAddon: Schema.Boolean,
});
export type AdvertisedEndpointProvider = typeof AdvertisedEndpointProvider.Type;

export const AdvertisedEndpointCompatibility = Schema.Struct({
  hostedHttpsApp: AdvertisedEndpointHostedHttpsCompatibility,
  desktopApp: Schema.Literals(["compatible", "unknown"]),
});
export type AdvertisedEndpointCompatibility = typeof AdvertisedEndpointCompatibility.Type;

export const AdvertisedEndpoint = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  provider: AdvertisedEndpointProvider,
  httpBaseUrl: TrimmedNonEmptyString,
  wsBaseUrl: TrimmedNonEmptyString,
  reachability: AdvertisedEndpointReachability,
  compatibility: AdvertisedEndpointCompatibility,
  source: AdvertisedEndpointSource,
  status: AdvertisedEndpointStatus,
  isDefault: Schema.optional(Schema.Boolean),
  description: Schema.optional(TrimmedNonEmptyString),
});
export type AdvertisedEndpoint = typeof AdvertisedEndpoint.Type;

/**
 * How the managed T3 Connect tunnel is doing, as cloudflared reports it.
 * `blocked-by-network`: the network refused the tunnel's TLS connection
 * repeatedly and retries are paused. `unstable`: registrations keep dying
 * within a minute, so a phone that connects may be cut off.
 */
export const ManagedTunnelStatus = Schema.Literals([
  "connecting",
  "connected",
  "blocked-by-network",
  "unstable",
]);
export type ManagedTunnelStatus = typeof ManagedTunnelStatus.Type;

export const ManagedTunnelState = Schema.Struct({
  status: ManagedTunnelStatus,
  /** A registration with the edge is up right now (false while `unstable` and reconnecting). */
  registered: Schema.Boolean,
  /** Public https origin of the tunnel; absent until the link response provided it. */
  httpBaseUrl: Schema.optional(TrimmedNonEmptyString),
});
export type ManagedTunnelState = typeof ManagedTunnelState.Type;

/**
 * ViewCode Quick connect: how the outbound connection to the user's own
 * relay Worker is doing. `blocked`: the network's TLS inspection presents a
 * certificate this computer does not trust, repeatedly. `auth-failed`: the
 * relay refused the host secret; retrying cannot help until it is fixed.
 */
export const ViewCodeRelayStatus = Schema.Literals([
  "off",
  "connecting",
  "connected",
  "reconnecting",
  "auth-failed",
  "blocked",
]);
export type ViewCodeRelayStatus = typeof ViewCodeRelayStatus.Type;

export const ViewCodeRelayState = Schema.Struct({
  status: ViewCodeRelayStatus,
  /** A relay URL and host secret are stored, so it can be turned on. */
  configured: Schema.Boolean,
  /** Why it is reconnecting or blocked, in words for the person. */
  reason: Schema.optional(TrimmedNonEmptyString),
  /** The relay's https origin: what the phone's pairing QR points at. */
  httpBaseUrl: Schema.optional(TrimmedNonEmptyString),
});
export type ViewCodeRelayState = typeof ViewCodeRelayState.Type;
