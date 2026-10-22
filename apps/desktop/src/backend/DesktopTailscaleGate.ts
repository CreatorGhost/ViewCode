import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import { AdminPolicyRef } from "@t3tools/shared/viewcodeAdminPolicy";
import { resolveTailscaleBlock, type TailscaleBlockReason } from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

const TailscaleSettingJson = fromLenientJson(
  Schema.Struct({ tailscaleEnabled: Schema.optional(Schema.Boolean) }),
);
const decodeTailscaleSettingJson = Schema.decodeUnknownOption(TailscaleSettingJson);

/**
 * ViewCode: whether the desktop may run the `tailscale` CLI. It honours the
 * same switches as the server it launches: IT's admin policy (read once, at
 * startup), `VIEWCODE_DISABLE_TAILSCALE`, and the server's `tailscaleEnabled`
 * setting, read from its settings file each time so a change in Settings
 * applies without a restart.
 */
export class DesktopTailscaleGate extends Context.Service<
  DesktopTailscaleGate,
  {
    /** Why Tailscale may not run here, or null when it may. Never spawns. */
    readonly blockReason: Effect.Effect<TailscaleBlockReason | null>;
  }
>()("@t3tools/desktop/backend/DesktopTailscaleGate") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const env = yield* HostProcessEnvironment;
  const policyBlocked = (yield* AdminPolicyRef).tailscaleBlocked;

  const blockReason = fileSystem.readFileString(environment.serverSettingsPath).pipe(
    Effect.option,
    Effect.map((raw) =>
      Option.flatMap(raw, decodeTailscaleSettingJson).pipe(
        Option.flatMap((settings) => Option.fromNullishOr(settings.tailscaleEnabled)),
        Option.getOrElse(() => true),
      ),
    ),
    Effect.map((settingEnabled) => resolveTailscaleBlock({ policyBlocked, env, settingEnabled })),
  );

  return DesktopTailscaleGate.of({ blockReason });
});

export const layer = Layer.effect(DesktopTailscaleGate, make);
