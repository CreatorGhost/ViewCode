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

/**
 * ViewCode Quick connect setup, run by the server from the app: which part is
 * running. Separate from `ViewCodeRelayState`, which is the connection itself.
 */
export const ViewCodeRelaySetupStep = Schema.Literals([
  "checking-tools",
  "signing-in",
  "deploying",
  "storing-secret",
  "verifying",
  "removing",
]);
export type ViewCodeRelaySetupStep = typeof ViewCodeRelaySetupStep.Type;

/**
 * Why the relay address does not answer yet. `network-refused`: this network
 * reset the connection or broke TLS (common for a brand-new address behind a
 * corporate firewall). `credential-rejected`: the relay refused this
 * computer's secret. `transient`: DNS, timeout or a 5xx; still retrying.
 */
export const ViewCodeRelayProblem = Schema.Literals([
  "network-refused",
  "credential-rejected",
  "transient",
]);
export type ViewCodeRelayProblem = typeof ViewCodeRelayProblem.Type;

/**
 * `idle`: nothing running (never started, cancelled, or removed).
 * `needs-subdomain`: the Cloudflare account has no workers.dev subdomain;
 * continue after creating one. `succeeded`: deployed and the address answered.
 * `unreachable`: deployed and saved, but the address did not answer in time;
 * the connector keeps trying. `remove-failed`: the Worker could not be
 * deleted; nothing local was changed.
 */
export const ViewCodeRelaySetupStatus = Schema.Literals([
  "idle",
  "running",
  "needs-subdomain",
  "succeeded",
  "unreachable",
  "failed",
  "remove-failed",
]);
export type ViewCodeRelaySetupStatus = typeof ViewCodeRelaySetupStatus.Type;

export const ViewCodeRelaySetupState = Schema.Struct({
  status: ViewCodeRelaySetupStatus,
  step: Schema.optional(ViewCodeRelaySetupStep),
  /** While signing in: the device-flow page and code wrangler printed. */
  signIn: Schema.optional(
    Schema.Struct({
      url: Schema.optional(TrimmedNonEmptyString),
      code: Schema.optional(TrimmedNonEmptyString),
      /** The page with the code filled in, for an Open button. */
      openUrl: Schema.optional(TrimmedNonEmptyString),
      /** wrangler's sign-in lines, verbatim and redacted, for when parsing failed. */
      lines: Schema.Array(Schema.String),
    }),
  ),
  /** While verifying, or when it ended unreachable: what the last attempt saw. */
  problem: Schema.optional(ViewCodeRelayProblem),
  /** One sentence for the person about the current step or the outcome. */
  message: Schema.optional(TrimmedNonEmptyString),
  /** Redacted wrangler output, shown under a collapsed "Details". */
  details: Schema.optional(Schema.String),
  /** A failure the person fixes outside ViewCode: offer the matching button. */
  action: Schema.optional(Schema.Literals(["install-node"])),
});
export type ViewCodeRelaySetupState = typeof ViewCodeRelaySetupState.Type;

export const ViewCodeRelaySetupMode = Schema.Literals(["new", "reuse", "redeploy"]);
export type ViewCodeRelaySetupMode = typeof ViewCodeRelaySetupMode.Type;

export const ViewCodeRelaySetupStartInput = Schema.Struct({
  /** `reuse` verifies and turns on the stored relay; `new` and `redeploy` deploy it. */
  mode: ViewCodeRelaySetupMode,
  /** Only with `redeploy`: replace the host secret. Never implied. */
  rotateSecret: Schema.optional(Schema.Boolean),
});
export type ViewCodeRelaySetupStartInput = typeof ViewCodeRelaySetupStartInput.Type;

export const ViewCodeRelayRemoveInput = Schema.Struct({
  /** Clear this computer's settings without deleting the Worker (after a failed delete). */
  localOnly: Schema.optional(Schema.Boolean),
});
export type ViewCodeRelayRemoveInput = typeof ViewCodeRelayRemoveInput.Type;

export class ViewCodeRelaySetupError extends Schema.TaggedError<ViewCodeRelaySetupError>()(
  "ViewCodeRelaySetupError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}
