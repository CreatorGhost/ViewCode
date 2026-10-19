import {
  AcpRegistryOperationError,
  ProviderSetupError,
  TextGenerationError,
  type ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ProviderAdapterProtocolError } from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderAdapterV2SessionRuntime } from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import { AdminPolicyRef } from "@t3tools/shared/viewcodeAdminPolicy";

export const adminProviderBlockReason = (driver: ProviderDriverKind) =>
  Effect.map(AdminPolicyRef, (policy) =>
    policy.blockedDrivers.includes(driver) ? "Blocked by your organization." : null,
  );

/**
 * `executableMissing` re-reads the filesystem on every launch (`resolveInstanceExecutable`), so a
 * provider whose binary is absent, or was removed a moment ago, is refused with a clear reason
 * instead of being spawned. Calls on a session that is already running are not re-checked.
 */
export function guardProviderInstance(
  instance: ProviderInstance,
  blockedByAdmin: boolean,
  executableMissing: Effect.Effect<boolean> = Effect.succeed(false),
): ProviderInstance {
  const reason = (allowDisabled = false, launch = false) =>
    Effect.flatMap(adminProviderBlockReason(instance.driverKind), (admin) => {
      const blocked =
        admin ??
        (blockedByAdmin
          ? "Blocked by your organization."
          : !allowDisabled && !instance.enabled
            ? "Enable this provider in Settings before starting it."
            : null);
      if (blocked !== null || !launch) return Effect.succeed(blocked);
      return Effect.map(executableMissing, (missing) =>
        missing
          ? `The executable for provider instance '${instance.instanceId}' was not found, so it was not launched. Install it or set its binary path in Settings → Providers.`
          : null,
      );
    });
  const adapterGuard = <A, E, R>(
    task: Effect.Effect<A, E, R>,
    launch = false,
  ): Effect.Effect<A, E | ProviderAdapterProtocolError, R> =>
    Effect.flatMap(
      reason(false, launch),
      (detail): Effect.Effect<A, E | ProviderAdapterProtocolError, R> =>
        detail
          ? Effect.fail(new ProviderAdapterProtocolError({ driver: instance.driverKind, detail }))
          : task,
    );
  const driverGuard = <A, E, R>(
    task: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | ProviderDriverError, R> =>
    Effect.flatMap(reason(), (detail): Effect.Effect<A, E | ProviderDriverError, R> =>
      detail
        ? Effect.fail(
            new ProviderDriverError({
              driver: instance.driverKind,
              instanceId: instance.instanceId,
              detail,
            }),
          )
        : task,
    );
  const setupGuard = <A, E, R>(
    task: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | ProviderSetupError, R> =>
    Effect.flatMap(reason(true), (detail): Effect.Effect<A, E | ProviderSetupError, R> =>
      detail
        ? Effect.fail(
            new ProviderSetupError({ instanceId: instance.instanceId, operation: "setup", detail }),
          )
        : task,
    );
  const acpGuard = <A, E, R>(
    task: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | AcpRegistryOperationError, R> =>
    Effect.flatMap(reason(), (detail): Effect.Effect<A, E | AcpRegistryOperationError, R> =>
      detail
        ? Effect.fail(
            new AcpRegistryOperationError({ reason: "runner_unavailable", message: detail }),
          )
        : task,
    );
  const stamp = (snapshot: ServerProvider): ServerProvider =>
    blockedByAdmin
      ? {
          ...snapshot,
          enabled: false,
          status: "disabled",
          disabledByAdmin: true,
          message: "Blocked by your organization.",
        }
      : snapshot;
  const guardedRuntime = (
    runtime: ProviderAdapterV2SessionRuntime,
  ): ProviderAdapterV2SessionRuntime => ({
    ...runtime,
    ensureThread: (input) => adapterGuard(runtime.ensureThread(input)),
    resumeThread: (input) => adapterGuard(runtime.resumeThread(input)),
    // A turn may launch a new process (Claude opens a query per selection).
    startTurn: (input) => adapterGuard(runtime.startTurn(input), true),
    steerTurn: (input) => adapterGuard(runtime.steerTurn(input)),
    respondToRuntimeRequest: (input) => adapterGuard(runtime.respondToRuntimeRequest(input)),
    readThreadSnapshot: (input) => adapterGuard(runtime.readThreadSnapshot(input)),
    rollbackThread: (input) => adapterGuard(runtime.rollbackThread(input)),
    forkThread: (input) => adapterGuard(runtime.forkThread(input)),
    ...(runtime.injectHistory
      ? {
          injectHistory: (input: Parameters<NonNullable<typeof runtime.injectHistory>>[0]) =>
            adapterGuard(runtime.injectHistory!(input)),
        }
      : {}),
    ...(runtime.compactThread
      ? {
          compactThread: (input: Parameters<NonNullable<typeof runtime.compactThread>>[0]) =>
            adapterGuard(runtime.compactThread!(input), true),
        }
      : {}),
  });
  const textGuard = <A, E, R>(
    operation: string,
    task: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | TextGenerationError, R> =>
    Effect.flatMap(reason(false, true), (detail): Effect.Effect<A, E | TextGenerationError, R> =>
      detail ? Effect.fail(new TextGenerationError({ operation, detail })) : task,
    );
  const auth = instance.auth;
  const manager = instance.acpSessionManagement;
  return {
    ...instance,
    enabled: instance.enabled && !blockedByAdmin,
    snapshot: {
      ...instance.snapshot,
      getSnapshot: Effect.map(instance.snapshot.getSnapshot, stamp),
      refresh: Effect.flatMap(reason(), (detail) =>
        detail ? instance.snapshot.getSnapshot : instance.snapshot.refresh,
      ).pipe(Effect.map(stamp)),
      streamChanges: instance.snapshot.streamChanges.pipe(Stream.map(stamp)),
      resolveMaintenance: (options) =>
        Effect.flatMap(reason(true), (detail) =>
          detail
            ? Effect.succeed(
                makeManualOnlyProviderMaintenanceCapabilities({
                  provider: instance.driverKind,
                  packageName: null,
                }),
              )
            : instance.snapshot.resolveMaintenance(options),
        ),
    },
    ...(instance.snapshotForCwd
      ? {
          snapshotForCwd: (cwd: string) =>
            driverGuard(instance.snapshotForCwd!(cwd)).pipe(Effect.map(stamp)),
        }
      : {}),
    ...(instance.refreshModels
      ? { refreshModels: () => driverGuard(instance.refreshModels!()) }
      : {}),
    ...(instance.consumeResetCredit
      ? { consumeResetCredit: () => driverGuard(instance.consumeResetCredit!()) }
      : {}),
    orchestrationAdapter: {
      ...instance.orchestrationAdapter,
      openSession: (input) =>
        adapterGuard(instance.orchestrationAdapter.openSession(input), true).pipe(
          Effect.map(guardedRuntime),
        ),
    },
    textGeneration: {
      generateCommitMessage: (input) =>
        textGuard("generateCommitMessage", instance.textGeneration.generateCommitMessage(input)),
      generatePrContent: (input) =>
        textGuard("generatePrContent", instance.textGeneration.generatePrContent(input)),
      generateBranchName: (input) =>
        textGuard("generateBranchName", instance.textGeneration.generateBranchName(input)),
      generateThreadTitle: (input) =>
        textGuard("generateThreadTitle", instance.textGeneration.generateThreadTitle(input)),
      generateReviewGuide: (input) =>
        textGuard("generateReviewGuide", instance.textGeneration.generateReviewGuide(input)),
    },
    ...(auth
      ? {
          auth: {
            ...auth,
            start: (...args: Parameters<typeof auth.start>) => setupGuard(auth.start(...args)),
            complete: (...args: Parameters<typeof auth.complete>) =>
              setupGuard(auth.complete(...args)),
            logout: (...args: Parameters<typeof auth.logout>) => setupGuard(auth.logout(...args)),
            ...(auth.respond
              ? {
                  respond: (...args: Parameters<NonNullable<typeof auth.respond>>) =>
                    setupGuard(auth.respond!(...args)),
                }
              : {}),
            ...(auth.reconnectProfile
              ? {
                  reconnectProfile: (
                    ...args: Parameters<NonNullable<typeof auth.reconnectProfile>>
                  ) => setupGuard(auth.reconnectProfile!(...args)),
                }
              : {}),
            ...(auth.importProfile
              ? {
                  importProfile: (...args: Parameters<NonNullable<typeof auth.importProfile>>) =>
                    setupGuard(auth.importProfile!(...args)),
                }
              : {}),
            ...(auth.adoptCredentials
              ? {
                  adoptCredentials: (
                    ...args: Parameters<NonNullable<typeof auth.adoptCredentials>>
                  ) => setupGuard(auth.adoptCredentials!(...args)),
                }
              : {}),
            ...(auth.refreshMethods
              ? {
                  refreshMethods: Effect.flatMap(reason(), (detail) =>
                    detail ? Effect.void : auth.refreshMethods!,
                  ),
                }
              : {}),
          },
        }
      : {}),
    ...(manager
      ? {
          acpSessionManagement: {
            listSessions: (input: Parameters<typeof manager.listSessions>[0]) =>
              acpGuard(manager.listSessions(input)),
            logout: (cwd: string) => acpGuard(manager.logout(cwd)),
            deleteSession: (input: Parameters<typeof manager.deleteSession>[0]) =>
              acpGuard(manager.deleteSession(input)),
            listProviders: (cwd: string) => acpGuard(manager.listProviders(cwd)),
            setProvider: (input: Parameters<typeof manager.setProvider>[0]) =>
              acpGuard(manager.setProvider(input)),
            disableProvider: (input: Parameters<typeof manager.disableProvider>[0]) =>
              acpGuard(manager.disableProvider(input)),
          },
        }
      : {}),
  };
}
