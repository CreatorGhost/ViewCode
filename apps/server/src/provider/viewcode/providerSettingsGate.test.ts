import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../../config.ts";
import * as Settings from "../../serverSettings.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { AdminProviderPolicyRef } from "../AdminProviderPolicy.ts";

const encodeSettings = Schema.encodeSync(Schema.fromJsonString(ServerSettings));
const decodeSettings = Schema.decodeEffect(Schema.fromJsonString(ServerSettings));
const layer = Settings.layer.pipe(
  Layer.provide(ServerSecretStore.layer),
  Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
  Layer.provideMerge(
    Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "viewcode-provider-gate-" })),
  ),
  Layer.provideMerge(NodeServices.layer),
);

describe("provider launch settings", () => {
  it.effect(
    "persists every provider off in a brand-new environment and keeps that choice on reload",
    () =>
      Effect.gen(function* () {
        const service = yield* Settings.ServerSettingsService;
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const settings = yield* service.getSettings;
        for (const driver of [
          "codex",
          "claudeAgent",
          "cursor",
          "grok",
          "opencode",
          "antigravity",
          "pi",
          "muse",
          "commandCode",
          "droid",
          "devin",
        ])
          assert.isFalse(settings.providerInstances[ProviderInstanceId.make(driver)]?.enabled);
        const persisted = yield* fs
          .readFileString(config.settingsPath)
          .pipe(Effect.flatMap(decodeSettings));
        assert.deepEqual(persisted.providerInstances, settings.providerInstances);
        yield* service.updateSettings({
          providerInstances: {
            ...settings.providerInstances,
            [ProviderInstanceId.make("codex")]: {
              driver: ProviderDriverKind.make("codex"),
              enabled: true,
            },
          },
        });
        assert.isTrue(
          (yield* service.getSettings).providerInstances[ProviderInstanceId.make("codex")]?.enabled,
        );
        assert.isFalse(
          (yield* service.getSettings).providerInstances[ProviderInstanceId.make("muse")]?.enabled,
        );
      }).pipe(Effect.scoped, Effect.provide(Layer.fresh(layer))),
  );

  it.effect(
    "preserves an existing install and never writes the administrator's override into the user's choice",
    () =>
      Effect.gen(function* () {
        const service = yield* Settings.ServerSettingsService;
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const id = ProviderInstanceId.make("codex_work");
        const original = {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: { [id]: { driver: ProviderDriverKind.make("codex"), enabled: true } },
        };
        yield* fs.writeFileString(config.settingsPath, encodeSettings(original));
        const settings = yield* service.getSettings;
        assert.isFalse(settings.providerInstances[id]?.enabled);
        yield* service.updateSettings({ defaultThreadEnvMode: "worktree" });
        const persisted = yield* fs
          .readFileString(config.settingsPath)
          .pipe(Effect.flatMap(decodeSettings));
        assert.isTrue(persisted.providerInstances[id]?.enabled);
        assert.isFalse((yield* service.getSettings).providerInstances[id]?.enabled);
        const snapshot = yield* service.withSettingsSnapshot(Effect.succeed);
        assert.isFalse(snapshot.providerInstances[id]?.enabled);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.fresh(layer).pipe(
            Layer.provide(
              Layer.succeed(AdminProviderPolicyRef, { blockedDrivers: ["codex"], problem: null }),
            ),
          ),
        ),
      ),
  );
});
