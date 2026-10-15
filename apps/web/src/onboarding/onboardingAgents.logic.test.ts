import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProviderPickerRows,
  providerPickerPatch,
  resolveOnboardingAgentDrivers,
} from "./onboardingAgents.logic";

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

describe("provider picker", () => {
  it("marks found CLIs once the lookup answers, and none before", () => {
    expect(buildProviderPickerRows(null).every((row) => row.found === null)).toBe(true);
    const rows = buildProviderPickerRows([
      { driver: driver("claudeAgent"), installed: true, path: "/usr/local/bin/claude" },
      { driver: driver("codex"), installed: false, path: null },
    ]);
    expect(rows[0]).toEqual({ driver: driver("claudeAgent"), found: true });
    expect(rows.find((row) => row.driver === "codex")?.found).toBe(false);
    expect(rows.find((row) => row.driver === "grok")?.found).toBe(false);
  });

  it("enables only what was picked", () => {
    expect(providerPickerPatch(new Set([driver("cursor"), driver("claudeAgent")]))).toEqual({
      providers: { claudeAgent: { enabled: true }, cursor: { enabled: true } },
    });
  });
});
