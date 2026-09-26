import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettingsPatch,
  type ServerSettings,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import { deriveProviderInstanceConfigMap } from "./Layers/ProviderInstanceRegistryHydration.ts";
import {
  applyProviderSelectionRules,
  decideProviderSelection,
  makeChooseProvidersPatch,
} from "./providerSelection.ts";

const driver = ProviderDriverKind.make;
const encodeSettingsPatch = Schema.encodeEffect(Schema.fromJsonString(ServerSettingsPatch));
const pending: ServerSettings = { ...DEFAULT_SERVER_SETTINGS, providerSelection: "pending" };
const workClaudeId = ProviderInstanceId.make("claude_work");
const withWorkClaude = (settings: ServerSettings): ServerSettings => ({
  ...settings,
  providerInstances: {
    [workClaudeId]: { driver: driver("claudeAgent"), config: {} },
  } as ServerSettings["providerInstances"],
});

const update = (current: ServerSettings, patch: Parameters<typeof applyServerSettingsPatch>[1]) =>
  applyProviderSelectionRules(current, patch, applyServerSettingsPatch(current, patch));

const enabledInstances = (settings: ServerSettings) =>
  Object.entries(deriveProviderInstanceConfigMap(settings))
    .filter(([, entry]) => {
      const config = entry.config as { readonly enabled?: boolean } | undefined;
      return entry.enabled !== false && config?.enabled !== false;
    })
    .map(([instanceId]) => instanceId)
    .toSorted();

describe("decideProviderSelection", () => {
  const decide = (
    input: Partial<Parameters<typeof decideProviderSelection>[1]>,
    settings: ServerSettings = DEFAULT_SERVER_SETTINGS,
  ) =>
    decideProviderSelection(settings, {
      rawSettingsJson: undefined,
      settingsFileTrusted: true,
      hasHistory: false,
      ...input,
    }).providerSelection;

  it("keeps a fresh or never-used environment pending", () => {
    assert.strictEqual(decide({}), "pending");
    assert.strictEqual(decide({ rawSettingsJson: '{"defaultAutoPull":true}' }), "pending");
  });

  it("marks a used environment chosen", () => {
    assert.strictEqual(decide({ hasHistory: true }), "chosen");
  });

  it("does not mistake persisted default flags for a provider choice", () => {
    assert.strictEqual(
      decide({
        rawSettingsJson:
          '{"providers":{"codex":{"enabled":false},"cursor":{"enabled":true},"grok":{"enabled":false},"opencode":{"enabled":false}}}',
      }),
      "pending",
    );
  });

  it("migrates explicit provider instances as an existing choice", () => {
    assert.strictEqual(
      decide({ rawSettingsJson: '{"providerInstances":{"codex_work":{"driver":"codex"}}}' }),
      "chosen",
    );
  });

  it("does not treat an unreadable settings file as permission", () => {
    assert.strictEqual(decide({ settingsFileTrusted: false, hasHistory: true }), "pending");
  });

  it("decides only once", () => {
    assert.strictEqual(decide({ hasHistory: true }, pending), "pending");
  });
});

describe("applyProviderSelectionRules", () => {
  it("gates every instance while pending", () => {
    assert.deepStrictEqual(enabledInstances(withWorkClaude(pending)), []);
    // The schema defaults (Codex on) still apply once chosen.
    assert.include(
      enabledInstances(withWorkClaude({ ...pending, providerSelection: "chosen" })),
      "codex",
    );
  });

  it("enables every instance of the chosen drivers and nothing else", () => {
    const next = update(withWorkClaude(pending), makeChooseProvidersPatch([driver("claudeAgent")]));
    assert.strictEqual(next.providerSelection, "chosen");
    assert.deepStrictEqual(enabledInstances(next), ["claudeAgent", "claude_work"]);
    assert.strictEqual(next.providers.codex.enabled, false);
    assert.strictEqual(next.providerInstances[workClaudeId]?.enabled, true);
  });

  it("closes with everything off when nothing is chosen", () => {
    const next = update(withWorkClaude(pending), makeChooseProvidersPatch([]));
    assert.strictEqual(next.providerSelection, "chosen");
    assert.deepStrictEqual(enabledInstances(next), []);
  });

  it("ignores a stale second choice", () => {
    const first = update(pending, makeChooseProvidersPatch([driver("claudeAgent")]));
    const second = update(first, makeChooseProvidersPatch([driver("codex")]));
    assert.strictEqual(second, first);
  });

  it("treats switching one provider on while pending as the first choice", () => {
    const next = update(withWorkClaude(pending), {
      providers: { cursor: { enabled: true } },
    });
    assert.strictEqual(next.providerSelection, "chosen");
    assert.deepStrictEqual(enabledInstances(next), ["cursor"]);
    assert.strictEqual(next.providerInstances[workClaudeId]?.enabled, false);
  });

  it("leaves pending alone for changes that switch nothing on", () => {
    const next = update(pending, { providers: { codex: { binaryPath: "/opt/codex" } } });
    assert.strictEqual(next.providerSelection, "pending");
  });
});

const makeSettingsLayer = <E, R>(baseDir: Layer.Layer<ServerConfig.ServerConfig, E, R>) =>
  ServerSettingsModule.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
    Layer.provideMerge(baseDir),
  );

const freshConfig = () =>
  Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3-provider-selection-" }));

it.layer(NodeServices.layer)("settings load", (it) => {
  it.effect("persists pending for a fresh home and keeps it across a restart", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const first = yield* ServerSettingsModule.ServerSettingsService.pipe(
        Effect.flatMap((service) => service.getSettings),
        Effect.provide(makeSettingsLayer(Layer.succeed(ServerConfig.ServerConfig, config))),
      );
      assert.strictEqual(first.providerSelection, "pending");
      assert.include(yield* fs.readFileString(config.settingsPath), '"pending"');

      // A project created before choosing (e.g. bootstrapped from cwd) must
      // not flip the next boot to "chosen".
      const second = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES ('p1', 'p', '/tmp', '[]', '2026-09-26T00:00:00.000Z', '2026-09-26T00:00:00.000Z')`;
        const service = yield* ServerSettingsModule.ServerSettingsService;
        return yield* service.getSettings;
      }).pipe(Effect.provide(makeSettingsLayer(Layer.succeed(ServerConfig.ServerConfig, config))));
      assert.strictEqual(second.providerSelection, "pending");
    }).pipe(Effect.provide(freshConfig())),
  );

  it.effect("keeps app-written default flags and a bootstrap project pending", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(
        config.settingsPath,
        '{"providers":{"codex":{"enabled":true},"cursor":{"enabled":false},"grok":{"enabled":false},"opencode":{"enabled":false}}}',
      );
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES ('p1', 'p', '/tmp', '[]', '2026-09-26T00:00:00.000Z', '2026-09-26T00:00:00.000Z')`;
        const service = yield* ServerSettingsModule.ServerSettingsService;
        const settings = yield* service.getSettings;
        assert.strictEqual(settings.providerSelection, "pending");
        assert.deepStrictEqual(enabledInstances(settings), []);
      }).pipe(Effect.provide(makeSettingsLayer(Layer.succeed(ServerConfig.ServerConfig, config))));
    }).pipe(Effect.provide(freshConfig())),
  );

  it.effect("migrates a previously used provider and keeps its explicit enabled set", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES ('p1', 'p', '/tmp', '[]', '2026-09-26T00:00:00.000Z', '2026-09-26T00:00:00.000Z')`;
      yield* sql`INSERT INTO projection_thread_sessions (thread_id, status, provider_name, updated_at) VALUES ('t1', 'ready', 'claudeAgent', '2026-09-26T00:00:00.000Z')`;
      const settings = yield* ServerSettingsModule.ServerSettingsService.pipe(
        Effect.flatMap((service) => service.getSettings),
      );
      assert.strictEqual(settings.providerSelection, "chosen");
      // Existing provider sessions retain the pre-gate defaults.
      assert.includeMembers(enabledInstances(settings), ["claudeAgent", "codex"]);
    }).pipe(Effect.provide(makeSettingsLayer(freshConfig()))),
  );

  it.effect("preserves the managed-mode explicit choice on first boot", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(
        config.settingsPath,
        yield* encodeSettingsPatch(
          makeChooseProvidersPatch([driver("claudeAgent"), driver("cursor")]),
        ),
      );
      const settings = yield* ServerSettingsModule.ServerSettingsService.pipe(
        Effect.flatMap((service) => service.getSettings),
        Effect.provide(makeSettingsLayer(Layer.succeed(ServerConfig.ServerConfig, config))),
      );
      assert.strictEqual(settings.providerSelection, "chosen");
      assert.deepStrictEqual(enabledInstances(settings), ["claudeAgent", "cursor"]);
    }).pipe(Effect.provide(freshConfig())),
  );

  it.effect("persists an explicit choice and restores only those providers after restart", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const settingsLayer = () =>
        makeSettingsLayer(Layer.succeed(ServerConfig.ServerConfig, config));
      yield* ServerSettingsModule.ServerSettingsService.pipe(
        Effect.flatMap((service) =>
          service.updateSettings(makeChooseProvidersPatch([driver("cursor")])),
        ),
        Effect.provide(settingsLayer()),
      );
      const restarted = yield* ServerSettingsModule.ServerSettingsService.pipe(
        Effect.flatMap((service) => service.getSettings),
        Effect.provide(settingsLayer()),
      );
      assert.strictEqual(restarted.providerSelection, "chosen");
      assert.deepStrictEqual(enabledInstances(restarted), ["cursor"]);
    }).pipe(Effect.provide(freshConfig())),
  );

  it.effect("respects explicit provider instances as an existing choice", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(
        config.settingsPath,
        '{"providerInstances":{"claude_work":{"driver":"claudeAgent","enabled":true}}}',
      );
      const settings = yield* ServerSettingsModule.ServerSettingsService.pipe(
        Effect.flatMap((service) => service.getSettings),
        Effect.provide(makeSettingsLayer(Layer.succeed(ServerConfig.ServerConfig, config))),
      );
      assert.strictEqual(settings.providerSelection, "chosen");
      assert.include(enabledInstances(settings), "claude_work");
    }).pipe(Effect.provide(freshConfig())),
  );

  it.effect("keeps providers off for a malformed settings file and leaves it on disk", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const malformed = '{"providers": {"codex": {"enabled": "yes"}}';
      yield* fs.writeFileString(config.settingsPath, malformed);
      const settings = yield* ServerSettingsModule.ServerSettingsService.pipe(
        Effect.flatMap((service) => service.getSettings),
        Effect.provide(makeSettingsLayer(Layer.succeed(ServerConfig.ServerConfig, config))),
      );
      assert.strictEqual(settings.providerSelection, "pending");
      assert.deepStrictEqual(enabledInstances(settings), []);
      assert.strictEqual(yield* fs.readFileString(config.settingsPath), malformed);
    }).pipe(Effect.provide(freshConfig())),
  );

  it.effect("keeps providers off for the run when the decision cannot be persisted", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // A used environment would be marked chosen, but the write fails.
      yield* sql`INSERT INTO projection_thread_sessions (thread_id, status, provider_name, updated_at) VALUES ('t1', 'ready', 'claudeAgent', '2026-09-26T00:00:00.000Z')`;
      yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES ('p1', 'p', '/tmp', '[]', '2026-09-26T00:00:00.000Z', '2026-09-26T00:00:00.000Z')`;
      const settings = yield* ServerSettingsModule.ServerSettingsService.pipe(
        Effect.flatMap((service) => service.getSettings),
      );
      assert.strictEqual(settings.providerSelection, "pending");
      assert.deepStrictEqual(enabledInstances(settings), []);
    }).pipe(
      Effect.provide(
        makeSettingsLayer(freshConfig()).pipe(
          Layer.provide(
            Layer.effect(
              FileSystem.FileSystem,
              FileSystem.FileSystem.pipe(
                Effect.map((fs) => ({
                  ...fs,
                  rename: () =>
                    Effect.fail(
                      PlatformError.systemError({
                        _tag: "PermissionDenied",
                        module: "FileSystem",
                        method: "rename",
                      }),
                    ),
                })),
              ),
            ),
          ),
        ),
      ),
    ),
  );

  it.effect("closes the selection through a settings toggle, in one write", () =>
    Effect.gen(function* () {
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const next = yield* service.updateSettings({ providers: { claudeAgent: { enabled: true } } });
      assert.strictEqual(next.providerSelection, "chosen");
      assert.deepStrictEqual(enabledInstances(next), ["claudeAgent"]);
      const stale = yield* service.updateSettings(makeChooseProvidersPatch([driver("codex")]));
      assert.deepStrictEqual(enabledInstances(stale), ["claudeAgent"]);
    }).pipe(Effect.provide(makeSettingsLayer(freshConfig()))),
  );
});
