import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildUsageSections,
  formatBankedResets,
  formatContextWindowSummary,
  formatTokenCount,
  formatUsageReset,
  formatUsedPercent,
  orderUsageWindows,
  peakUsedPercent,
  resolveUsageRing,
  shortPlanName,
  shouldRefreshUsage,
  type UsageProviderInput,
  usageRingTone,
  usageTone,
} from "./composerUsageLimits.logic";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function window(
  id: string,
  kind: ServerProviderUsageWindow["kind"],
  usedPercent: number,
): ServerProviderUsageWindow {
  return { id, kind, label: id, usedPercent };
}

function limits(
  windows: ReadonlyArray<ServerProviderUsageWindow>,
  extra: Partial<ServerProviderUsageLimits> = {},
): ServerProviderUsageLimits {
  return { checkedAt: new Date(0).toISOString(), windows: [...windows], ...extra };
}

function provider(
  instanceId: string,
  usageLimits: ServerProviderUsageLimits | undefined,
  plan?: string,
): UsageProviderInput {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: instanceId === "codex" ? "Codex" : "Claude",
    plan,
    usageLimits,
  };
}

describe("formatUsageReset", () => {
  const now = new Date(2026, 8, 26, 12, 0).getTime();

  it("counts down within the day", () => {
    expect(formatUsageReset(new Date(now + 8 * MINUTE).toISOString(), now)).toBe("Resets in 8 min");
    expect(formatUsageReset(new Date(now + 3 * HOUR + 12 * MINUTE).toISOString(), now)).toBe(
      "Resets in 3 hr 12 min",
    );
    expect(formatUsageReset(new Date(now + 30_000).toISOString(), now)).toBe("Resets in 1 min");
  });

  it("names the weekday and local time a day or more out", () => {
    // Sunday 4 October 2026, 17:00 local time.
    const sunday = new Date(2026, 9, 4, 17, 0);
    expect(formatUsageReset(sunday.toISOString(), now)).toBe("Resets Sun 17:00");
  });

  it("handles past and missing resets", () => {
    expect(formatUsageReset(new Date(now - MINUTE).toISOString(), now)).toBe("Resets now");
    expect(formatUsageReset(undefined, now)).toBeNull();
    expect(formatUsageReset("not a date", now)).toBeNull();
  });
});

describe("usageTone", () => {
  it("warns from 80% and turns critical when exhausted", () => {
    expect(usageTone(79)).toBe("normal");
    expect(usageTone(80)).toBe("warning");
    expect(usageTone(99.9)).toBe("warning");
    expect(usageTone(100)).toBe("critical");
    expect(formatUsedPercent(42.4)).toBe("42%");
  });
});

describe("orderUsageWindows / peakUsedPercent", () => {
  it("puts the session window before weekly ones and keeps provider order within a kind", () => {
    const ordered = orderUsageWindows([
      window("weekly-all", "weekly", 10),
      window("five-hour", "session", 40),
      window("weekly-fable", "weekly", 90),
    ]);
    expect(ordered.map(({ id }) => id)).toEqual(["five-hour", "weekly-all", "weekly-fable"]);
  });

  it("draws the busiest window, and nothing when limits are unknown", () => {
    expect(peakUsedPercent(limits([window("a", "session", 40), window("b", "weekly", 90)]))).toBe(
      90,
    );
    expect(peakUsedPercent(undefined)).toBeNull();
    expect(peakUsedPercent(limits([], { unavailable: { reason: "unsupported" } }))).toBeNull();
  });
});

describe("buildUsageSections", () => {
  const noRefresh = new Set<ProviderInstanceId>();

  it("titles the lead and each other agent provider once", () => {
    const lead = provider("claudeAgent", limits([window("five-hour", "session", 12)]), "Max");
    const codex = provider("codex", limits([window("primary", "session", 50)]));
    const sections = buildUsageSections({
      lead,
      agentProviders: [codex, lead, codex],
      refreshingInstanceIds: noRefresh,
    });
    expect(sections.map(({ title, subtitle }) => [title, subtitle])).toEqual([
      ["Lead · Claude", "Plan usage limits · Max"],
      ["Agents · Codex", "Plan usage limits"],
    ]);
  });

  it("shows the provider's own reason when limits are unavailable", () => {
    const [section] = buildUsageSections({
      lead: provider(
        "claudeAgent",
        limits([], {
          unavailable: { reason: "unsupported", message: "No plan limits for API-key accounts" },
        }),
      ),
      agentProviders: [],
      refreshingInstanceIds: noRefresh,
    });
    expect(section).toMatchObject({
      status: "message",
      message: "No plan limits for API-key accounts",
      windows: [],
    });
  });

  it("says checking while a probe runs with nothing to show yet", () => {
    const lead = provider("claudeAgent", undefined);
    const [section] = buildUsageSections({
      lead,
      agentProviders: [],
      refreshingInstanceIds: new Set([lead.instanceId]),
    });
    expect(section?.status).toBe("checking");
  });

  it("keeps banked reset credits, including an empty balance the provider reports", () => {
    const [withCredits] = buildUsageSections({
      lead: provider(
        "codex",
        limits([window("primary", "session", 5)], { resetCredits: { availableCount: 2 } }),
      ),
      agentProviders: [],
      refreshingInstanceIds: noRefresh,
    });
    expect(withCredits?.resetCredits?.availableCount).toBe(2);
    const [withoutCredits] = buildUsageSections({
      lead: provider(
        "codex",
        limits([window("primary", "session", 5)], { resetCredits: { availableCount: 0 } }),
      ),
      agentProviders: [],
      refreshingInstanceIds: noRefresh,
    });
    expect(withoutCredits?.resetCredits?.availableCount).toBe(0);
    expect(formatBankedResets({ availableCount: 2 })).toBe("2 available");
    expect(formatBankedResets({ availableCount: 0 })).toBe("None available yet");
    const [unreported] = buildUsageSections({
      lead: provider("claudeAgent", limits([window("five-hour", "session", 5)])),
      agentProviders: [],
      refreshingInstanceIds: noRefresh,
    });
    expect(unreported?.resetCredits).toBeNull();
  });

  it("shortens the plan label in the subtitle", () => {
    expect(shortPlanName("ChatGPT Pro 20x Subscription")).toBe("ChatGPT Pro 20x");
    expect(shortPlanName("Claude Max")).toBe("Claude Max");
  });
});

describe("context window formatting", () => {
  it("formats token counts in k and M with one decimal", () => {
    expect(formatTokenCount(950)).toBe("950");
    expect(formatTokenCount(19_700)).toBe("19.7k");
    expect(formatTokenCount(258_400)).toBe("258.4k");
    expect(formatTokenCount(200_000)).toBe("200k");
    expect(formatTokenCount(999_990)).toBe("1M");
    expect(formatTokenCount(1_200_000)).toBe("1.2M");
  });

  it("summarises used against the window with its percent", () => {
    expect(formatContextWindowSummary(19_700, 258_400)).toBe("19.7k / 258.4k (8%)");
    expect(formatContextWindowSummary(19_700, null)).toBe("19.7k");
  });
});

describe("resolveUsageRing", () => {
  it("draws the context window, falling back to the plan's busiest window", () => {
    expect(resolveUsageRing({ contextPercent: 8, planPeakPercent: 90 })).toEqual({
      source: "context",
      percent: 8,
    });
    expect(resolveUsageRing({ contextPercent: null, planPeakPercent: 90 })).toEqual({
      source: "plan",
      percent: 90,
    });
    expect(resolveUsageRing({ contextPercent: null, planPeakPercent: null })).toBeNull();
  });

  it("warns amber from 80% and red from 95%", () => {
    expect(usageRingTone(79)).toBe("normal");
    expect(usageRingTone(80)).toBe("warning");
    expect(usageRingTone(95)).toBe("critical");
  });
});

describe("shouldRefreshUsage", () => {
  const checkedAt = Date.parse("2026-09-26T12:00:00.000Z");

  it("re-probes a stale read but not a fresh or unsupported one", () => {
    const read = {
      ...limits([window("a", "session", 1)]),
      checkedAt: new Date(checkedAt).toISOString(),
    };
    expect(shouldRefreshUsage(read, checkedAt + 30_000)).toBe(false);
    expect(shouldRefreshUsage(read, checkedAt + 5 * MINUTE)).toBe(true);
    expect(
      shouldRefreshUsage({ ...read, unavailable: { reason: "unsupported" } }, checkedAt + HOUR),
    ).toBe(false);
    expect(shouldRefreshUsage(undefined, checkedAt)).toBe(false);
  });
});
