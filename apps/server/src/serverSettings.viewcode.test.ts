import { ProviderInstanceId, resolveProjectProviderInstanceEnabled } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as ServerSettingsModule from "./serverSettings.ts";

// ViewCode's provider and mode defaults are applied inside upstream's settings loader, so
// these run the real service: a merge that takes upstream's loader turns every provider on
// and new chats back to Full access, with no conflict and no type error.

const layerServerSettings = () =>
  ServerSettingsModule.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), { prefix: "viewcode-server-settings-guard-" }),
      ),
    ),
  );

const enabledIn =
  (settings: Parameters<typeof resolveProjectProviderInstanceEnabled>[0]) => (instanceId: string) =>
    resolveProjectProviderInstanceEnabled(settings, null, ProviderInstanceId.make(instanceId));

it.layer(NodeServices.layer)("ViewCode server settings defaults", (it) => {
  // 20ae07307, 629e8e780
  it.effect("starts a brand-new install with every built-in provider off", () =>
    Effect.gen(function* () {
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const enabled = enabledIn(yield* service.getSettings);
      for (const instanceId of ["codex", "claudeAgent", "cursor", "opencode", "droid"]) {
        assert.isFalse(enabled(instanceId), instanceId);
      }
    }).pipe(Effect.provide(layerServerSettings())),
  );

  // 629e8e780
  it.effect("keeps every provider an existing install never turned on off", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      yield* fs.writeFileString(
        config.settingsPath,
        '{"providerInstances":{"claudeAgent":{"driver":"claudeAgent","enabled":true,"config":{}}}}',
      );
      const enabled = enabledIn(yield* service.getSettings);
      assert.isTrue(enabled("claudeAgent"));
      assert.isFalse(enabled("codex"));
      assert.isFalse(enabled("cursor"));
    }).pipe(Effect.provide(layerServerSettings())),
  );

  // 7c65d7391
  it.effect("starts new chats in Auto", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const service = yield* ServerSettingsModule.ServerSettingsService;
      yield* fs.writeFileString(config.settingsPath, '{"addProjectBaseDirectory":"~/Existing"}');
      assert.equal((yield* service.getSettings).defaultRuntimeMode, "auto");
    }).pipe(Effect.provide(layerServerSettings())),
  );
});
