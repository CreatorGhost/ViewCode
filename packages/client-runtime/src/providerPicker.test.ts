import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProviderPickerRows,
  providerPickerPatch,
  resolveOnboardingAgentDrivers,
  selectedProviderPickerDrivers,
} from "./providerPicker";

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
  it("enables a picked legacy config while preserving account settings", () => {
    const instanceId = ProviderInstanceId.make("claudeAgent");
    const patch = providerPickerPatch(new Set([driver("claudeAgent")]), {
      [instanceId]: {
        driver: driver("claudeAgent"),
        enabled: false,
        config: { enabled: false, homePath: "/accounts/work" },
      },
    });
    expect(patch.providerInstances?.[instanceId]).toEqual({
      driver: driver("claudeAgent"),
      enabled: true,
      config: { enabled: true, homePath: "/accounts/work" },
    });
  });
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
      providerInstances: {
        claudeAgent: { driver: driver("claudeAgent"), enabled: true },
        cursor: { driver: driver("cursor"), enabled: true },
      },
    });
  });
  it("preserves other instances and omits an administrator-blocked selection", () => {
    const current = {
      [ProviderInstanceId.make("codex_work")]: { driver: driver("codex"), enabled: false },
    };
    expect(
      providerPickerPatch(new Set([driver("codex"), driver("muse")]), current, [driver("codex")]),
    ).toEqual({
      providerInstances: { ...current, muse: { driver: driver("muse"), enabled: true } },
    });
    expect(
      buildProviderPickerRows([], [driver("codex")]).find((row) => row.driver === "codex")
        ?.blockedByAdmin,
    ).toBe(true);
  });
});

describe("provider selection changes", () => {
  it("drops blocked and unknown selections before counting or enabling providers", () => {
    const picked = new Set([driver("codex"), driver("muse"), driver("unknown")]);
    const rows = buildProviderPickerRows([], [driver("codex")]);
    const selected = selectedProviderPickerDrivers(rows, picked);
    expect([...selected]).toEqual([driver("muse")]);
    expect(providerPickerPatch(selected)).toEqual({
      providerInstances: { muse: { driver: driver("muse"), enabled: true } },
    });
    expect(
      selectedProviderPickerDrivers(
        buildProviderPickerRows([], [driver("codex"), driver("muse")]),
        picked,
      ).size,
    ).toBe(0);
  });
  it("allows a provider again after the administrator removes its restriction", () => {
    const picked = new Set([driver("codex")]);
    expect(
      selectedProviderPickerDrivers(buildProviderPickerRows([], [driver("codex")]), picked).size,
    ).toBe(0);
    expect([...selectedProviderPickerDrivers(buildProviderPickerRows([]), picked)]).toEqual([
      driver("codex"),
    ]);
  });
});
