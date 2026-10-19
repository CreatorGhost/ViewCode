import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe } from "vite-plus/test";

import {
  applyAdminProviderPolicy,
  blockedDriversFromPolicy,
  readAdminProviderPolicyFile,
} from "./AdminProviderPolicy.ts";

describe("blockedDriversFromPolicy", () => {
  it("blocks exactly the providers with allowed: false", () => {
    assert.deepStrictEqual(
      blockedDriversFromPolicy({
        providers: { codex: { allowed: false }, claudeAgent: { allowed: true }, cursor: {} },
      }),
      ["codex"],
    );
    assert.deepStrictEqual(blockedDriversFromPolicy({ providers: "codex" }), []);
    assert.deepStrictEqual(blockedDriversFromPolicy(null), []);
  });
});

it.layer(NodeServices.layer)("readAdminProviderPolicyFile", (it) => {
  it.effect("reads a JSON policy, and treats a missing file as none", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "viewcode-policy-" });
      const policyPath = path.join(dir, "policy.json");

      assert.deepStrictEqual(readAdminProviderPolicyFile(policyPath), {
        blockedDrivers: [],
        problem: null,
      });
      yield* fs.writeFileString(policyPath, '{"providers":{"codex":{"allowed":false}}}');
      assert.deepStrictEqual(readAdminProviderPolicyFile(policyPath), {
        blockedDrivers: ["codex"],
        problem: null,
      });
    }).pipe(Effect.scoped),
  );

  it.effect("reports a policy it cannot parse instead of guessing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "viewcode-policy-" });
      const policyPath = path.join(dir, "policy.json");
      yield* fs.writeFileString(policyPath, "{not json");

      const policy = readAdminProviderPolicyFile(policyPath);
      assert.deepStrictEqual(policy.blockedDrivers, []);
      assert.include(policy.problem ?? "", policyPath);
    }).pipe(Effect.scoped),
  );
});

describe("applyAdminProviderPolicy", () => {
  it("also blocks a cached ACP registry runner for the same provider", () => {
    const instanceId = ProviderInstanceId.make("registry_droid");
    const settings = applyAdminProviderPolicy(
      {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("acpRegistry"),
            enabled: true,
            config: { agentId: "factory-droid" },
          },
        },
      },
      ["droid"],
    );
    assert.isFalse(settings.providerInstances[instanceId]?.enabled);
  });
  it("turns off a blocked provider's slot and instances, and nothing else", () => {
    const personal = ProviderInstanceId.make("codex_personal");
    const settings = applyAdminProviderPolicy(
      {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [personal]: { driver: ProviderDriverKind.make("codex"), enabled: true, config: {} },
        },
      },
      ["codex"],
    );
    assert.isFalse(settings.providerInstances[ProviderInstanceId.make("codex")]?.enabled);
    assert.isFalse(settings.providerInstances[personal]?.enabled);
    assert.isUndefined(settings.providerInstances[ProviderInstanceId.make("claudeAgent")]);
  });
});
