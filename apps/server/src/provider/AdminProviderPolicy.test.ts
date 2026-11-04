import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { describe } from "vite-plus/test";

import { applyAdminProviderPolicy } from "./AdminProviderPolicy.ts";

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
