import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProviderChoiceTiles,
  enableAgentsButtonLabel,
  orderedChosenDrivers,
  PROVIDER_CHOICE_DRIVERS,
  providerChoiceDetectionLabel,
  providerSelectionView,
  resolveOnboardingAgentDrivers,
} from "./providerChoice.logic";

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

describe("buildProviderChoiceTiles", () => {
  it("lists every built-in driver as checking before detection returns", () => {
    const tiles = buildProviderChoiceTiles(null);
    expect(tiles.map((tile) => tile.driver)).toEqual(PROVIDER_CHOICE_DRIVERS);
    expect(tiles.every((tile) => tile.detection.kind === "checking")).toBe(true);
  });

  it("marks found and missing drivers, including ones the server omitted", () => {
    const tiles = buildProviderChoiceTiles([
      { driver: driver("codex"), installed: true, path: "/usr/local/bin/codex" },
      { driver: driver("cursor"), installed: false, path: null },
    ]);
    const byDriver = new Map(tiles.map((tile) => [tile.driver, tile.detection]));
    expect(byDriver.get(driver("codex"))).toEqual({ kind: "found", path: "/usr/local/bin/codex" });
    expect(byDriver.get(driver("cursor"))).toEqual({ kind: "missing" });
    expect(byDriver.get(driver("claudeAgent"))).toEqual({ kind: "missing" });
  });
});

describe("labels", () => {
  it("describes detection", () => {
    expect(providerChoiceDetectionLabel({ kind: "found", path: "/bin/claude" })).toBe("Found at");
    expect(providerChoiceDetectionLabel({ kind: "found", path: null })).toBe("Found");
    expect(providerChoiceDetectionLabel({ kind: "missing" })).toBe("Not installed");
  });

  it("counts agents on the enable button", () => {
    expect(enableAgentsButtonLabel(0)).toBe("Enable agents");
    expect(enableAgentsButtonLabel(1)).toBe("Enable 1 agent");
    expect(enableAgentsButtonLabel(3)).toBe("Enable 3 agents");
  });
});

describe("orderedChosenDrivers", () => {
  it("returns the choice in display order", () => {
    expect(orderedChosenDrivers(new Set([driver("cursor"), driver("claudeAgent")]))).toEqual([
      driver("claudeAgent"),
      driver("cursor"),
    ]);
  });
});

describe("providerSelectionView", () => {
  it("is unknown until settings arrive and treats absent as chosen", () => {
    expect(providerSelectionView(null)).toBe("unknown");
    expect(providerSelectionView(DEFAULT_SERVER_SETTINGS)).toBe("chosen");
    expect(
      providerSelectionView({ ...DEFAULT_SERVER_SETTINGS, providerSelection: "pending" }),
    ).toBe("pending");
  });
});

describe("resolveOnboardingAgentDrivers", () => {
  const providers = [provider("codex", true), provider("grok", true), provider("cursor", false)];

  it("prefers what was just chosen, even before providers catch up", () => {
    expect(resolveOnboardingAgentDrivers(providers, [driver("opencode")])).toEqual([
      driver("opencode"),
    ]);
    expect(resolveOnboardingAgentDrivers(providers, [])).toEqual([]);
  });

  it("otherwise shows enabled providers in display order", () => {
    expect(resolveOnboardingAgentDrivers(providers, undefined)).toEqual([
      driver("codex"),
      driver("grok"),
    ]);
    expect(resolveOnboardingAgentDrivers(null, undefined)).toEqual([]);
  });
});
