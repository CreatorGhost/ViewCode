import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveOnboardingAgentDrivers } from "./onboardingAgents.logic";

const driver = (value: string) => ProviderDriverKind.make(value);

function provider(value: string, enabled: boolean): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(value),
    driver: driver(value),
    enabled,
    installed: true,
    version: null,
    status: enabled ? "ready" : "disabled",
    auth: { status: "unknown" },
    checkedAt: "2026-09-26T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

describe("resolveOnboardingAgentDrivers", () => {
  it("shows enabled providers in display order", () => {
    const providers = [
      provider("codex", true),
      provider("grok", true),
      provider("cursor", false),
      provider("claudeAgent", true),
    ];
    expect(resolveOnboardingAgentDrivers(providers)).toEqual([
      driver("claudeAgent"),
      driver("codex"),
      driver("grok"),
    ]);
    expect(resolveOnboardingAgentDrivers(null)).toEqual([]);
  });
});
