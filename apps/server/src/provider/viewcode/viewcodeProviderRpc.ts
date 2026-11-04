import { ProviderAccountError, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { addProviderAccount, prepareProviderAccountSignIn } from "../providerAccounts.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ServerConfig from "../../config.ts";

/** Account setup shares the same services across local, remote and desktop transports. */
export const makeViewCodeProviderRpcHandlers = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const config = yield* ServerConfig.ServerConfig;
  const currentSettings = (operation: string) =>
    settings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAccountError({
            operation,
            detail: "Could not read provider account settings.",
            cause,
          }),
      ),
    );
  return {
    [WS_METHODS.providerAccountAdd]: (
      account: Parameters<typeof addProviderAccount>[0]["account"],
    ) =>
      Effect.gen(function* () {
        return yield* addProviderAccount({
          settings: yield* currentSettings("add"),
          account,
          stateDir: config.stateDir,
          updateSettings: settings.updateSettings,
        });
      }),
    [WS_METHODS.providerAccountPrepareSignIn]: (input: {
      readonly instanceId: Parameters<typeof prepareProviderAccountSignIn>[0]["instanceId"];
    }) =>
      Effect.gen(function* () {
        return yield* prepareProviderAccountSignIn({
          settings: yield* currentSettings("prepareSignIn"),
          instanceId: input.instanceId,
          stateDir: config.stateDir,
        });
      }),
  };
});
