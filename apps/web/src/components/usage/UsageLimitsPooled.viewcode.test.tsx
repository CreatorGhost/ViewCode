// @vitest-environment jsdom

import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import type { LimitPresentations } from "@t3tools/shared/usageLimits";
import type { ProviderTotals } from "@t3tools/shared/usageMerge";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { consumeResetCredit: null } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../hooks/useSettings", () => ({ usePrimarySettings: () => "24h" }));
vi.mock("../chat/ProviderInstanceIcon", () => ({ ProviderInstanceIcon: () => null }));
vi.mock("../settings/RedactedSensitiveText", () => ({ RedactedSensitiveText: () => null }));

import { UsageLimitsPooled } from "./UsageLimitsPooled";

const NOW = Date.parse("2026-09-03T12:00:00Z");

const codex = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  displayName: "Codex",
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated", email: "alpha@example.com", label: "ChatGPT Pro subscription" },
  checkedAt: "2026-09-03T11:00:00Z",
  models: [],
  slashCommands: [],
  skills: [],
  usageLimits: {
    checkedAt: "2026-09-03T11:00:00Z",
    windows: [
      {
        id: "five_hour",
        kind: "session",
        label: "Session",
        usedPercent: 40,
        windowDurationMins: 300,
        resetsAt: "2026-09-03T14:00:00Z",
      },
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 90,
        windowDurationMins: 7 * 24 * 60,
        resetsAt: "2026-09-08T12:00:00Z",
      },
    ],
  },
} satisfies ServerProvider;

const claude = {
  ...codex,
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driver: ProviderDriverKind.make("claudeAgent"),
  displayName: "Claude",
  auth: { status: "authenticated", email: "beta@example.com", label: "Claude Max subscription" },
} satisfies ServerProvider;

function totals(
  provider: ProviderTotals["provider"],
  totalTokens: number,
  sessions: number,
): ProviderTotals {
  return { provider, costUsd: 0, totalTokens, records: 1, sessions, costShare: 0, tokenShare: 0 };
}

// One read per window serves every card; Claude has no usage in the last day.
const tokenUsage = [
  { label: "24h", providers: [totals("codex", 1_200_000, 3), totals("claude", 0, 0)] },
  { label: "7d", providers: [totals("codex", 8_500_000, 12)] },
  { label: "30d", providers: [totals("codex", 41_000_000, 1), totals("claude", 2_000, 2)] },
];

const presentations: LimitPresentations = new Map([
  [
    EnvironmentId.make("env-a"),
    {
      entry: { target: { label: "Test" } },
      serverConfig: { usageLimitSources: [], providers: [codex, claude] },
    },
  ],
]);

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(() =>
    root.render(
      <UsageLimitsPooled presentations={presentations} now={NOW} tokenUsage={tokenUsage} />,
    ),
  );
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function card(name: string): Element {
  const found = [...container.querySelectorAll("section")].find((section) =>
    section.querySelector("h2")?.textContent?.includes(name),
  );
  if (!found) throw new Error(`No card for ${name}`);
  return found;
}

// ViewCode draws Limits as Synara's provider cards, not upstream's one big percentage per
// window, which an upstream merge can bring back without a conflict.
it("draws one card per provider: name, account and plan, then a row per window", () => {
  expect(container.querySelectorAll("section")).toHaveLength(2);
  const header = card("Codex").querySelector("h2")?.textContent ?? "";
  expect(header).toContain("Default account");
  expect(header).toContain("ChatGPT Pro");
  expect(header).not.toContain("subscription");
  const text = card("Codex").textContent ?? "";
  expect(text.indexOf("Session")).toBeLessThan(text.indexOf("Weekly"));
  expect(text).toContain("60% left");
  expect(text).toContain("10% left");
});

it("marks each window's pace against its reset", () => {
  const codexCard = card("Codex");
  expect(codexCard.textContent).toMatch(/Resets in/);
  // The pace dot beside each window label.
  expect(codexCard.querySelectorAll("h2 ~ div span[aria-hidden].rounded-full")).toHaveLength(2);
});

// The email is revealed on demand in a segment's popover, never printed on the card, so a
// shared screen does not show which accounts are signed in.
it("names a lone account by its instance, not its email", () => {
  expect(card("Codex").textContent).not.toContain("alpha@example.com");
  expect(card("Claude").textContent).not.toContain("beta@example.com");
  expect(card("Claude").querySelector("h2")?.textContent).toContain("Max");
});

// Merge 58e4b0a77 dropped these rows from the Limits cards while keeping them in the rail.
it("lists each provider's 24h, 7d and 30d tokens and sessions under its windows", () => {
  const codexText = card("Codex").textContent ?? "";
  expect(codexText).toContain("24h1.20M tokens3 recent sessions");
  expect(codexText).toContain("7d8.50M tokens12 recent sessions");
  expect(codexText).toContain("30d41M tokens1 recent session");
  expect(codexText.indexOf("Weekly")).toBeLessThan(codexText.indexOf("24h"));

  // A window without usage for the provider is left out, not shown as zero.
  const claudeText = card("Claude").textContent ?? "";
  expect(claudeText).not.toContain("24h");
  expect(claudeText).not.toContain("7d");
  expect(claudeText).toContain("30d2K tokens2 recent sessions");
});
