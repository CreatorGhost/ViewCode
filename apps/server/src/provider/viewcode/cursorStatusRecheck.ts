/**
 * Re-checks a Cursor provider whose status is not ready when the host wakes or
 * unlocks, when a client comes back to the foreground, and when a client's
 * network comes back. A check that ran during or just after sleep (Keychain
 * still locked, Wi-Fi still joining) otherwise keeps its warning until the next
 * health refresh, which waits for client demand and pauses while the host is
 * constrained.
 *
 * The signals already reach the server: desktop power events through
 * `HostPowerMonitor`, and the clients' focus, visibility and `online` reports
 * through `BackgroundPolicy`. This only turns their edges into a refresh.
 *
 * @module CursorStatusRecheck
 */
import type { BackgroundPolicySnapshot, ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ProviderRegistry from "../ProviderRegistry.ts";

type CursorRecheckTrigger = "wake" | "foreground" | "network";

export function cursorRecheckTrigger(
  previous: BackgroundPolicySnapshot,
  next: BackgroundPolicySnapshot,
): CursorRecheckTrigger | undefined {
  const before = previous.hostPower;
  const after = next.hostPower;
  if (
    (before.suspended && !after.suspended) ||
    (before.locked === "true" && after.locked === "false")
  ) {
    return "wake";
  }
  if (previous.activeForegroundLeaseCount === 0 && next.activeForegroundLeaseCount > 0) {
    return "foreground";
  }
  const offline = new Set(
    previous.leases
      .filter((lease) => lease.networkType === "offline")
      .map((lease) => lease.clientId),
  );
  return next.leases.some((lease) => offline.has(lease.clientId) && lease.networkType !== "offline")
    ? "network"
    : undefined;
}

/** Signed out counts too: a login made in a terminal shows up on the next focus. */
const needsRecheck = (provider: ServerProvider) =>
  provider.driver === "cursor" &&
  provider.enabled &&
  provider.installed &&
  provider.status !== "ready";

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const policy = yield* BackgroundPolicy.BackgroundPolicy;
    const providers = yield* ProviderRegistry.ProviderRegistry;
    const { latest, changes } = yield* policy.subscribe;
    yield* changes.pipe(
      Stream.mapAccum(
        () => latest,
        (previous, next) => {
          const trigger = cursorRecheckTrigger(previous, next);
          return [next, trigger === undefined ? [] : [trigger]] as const;
        },
      ),
      Stream.runForEach((trigger) =>
        Effect.gen(function* () {
          const stale = (yield* providers.getProviders).filter(needsRecheck);
          if (stale.length === 0) return;
          yield* Effect.logInfo("Re-checking Cursor status", { trigger, instances: stale.length });
          yield* Effect.forEach(
            stale,
            (provider) => providers.refreshInstance(provider.instanceId),
            {
              discard: true,
            },
          );
        }),
      ),
      Effect.forkScoped,
    );
  }),
);
