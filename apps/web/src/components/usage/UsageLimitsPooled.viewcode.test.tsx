// @vitest-environment jsdom

import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import type { LimitPresentations } from "@t3tools/shared/usageLimits";
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

const presentations: LimitPresentations = new Map([
  [
    EnvironmentId.make("env-a"),
    {
      entry: { target: { label: "Test" } },
      serverConfig: { usageLimitSources: [], providers: [codex] },
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
  await act(() => root.render(<UsageLimitsPooled presentations={presentations} now={NOW} />));
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

// ViewCode draws Limits as Synara's provider cards, not upstream's one big percentage per
// window, which an upstream merge can bring back without a conflict.
it("draws one card per provider: name, account and plan, then a row per window", () => {
  const cards = container.querySelectorAll("section");
  expect(cards).toHaveLength(1);
  const card = cards[0]!;
  const header = card.querySelector("h2")?.textContent ?? "";
  expect(header).toContain("Codex");
  expect(header).toContain("alpha@example.com");
  expect(header).toContain("ChatGPT Pro subscription");

  const text = card.textContent ?? "";
  expect(text.indexOf("Session")).toBeLessThan(text.indexOf("Weekly"));
  expect(text).toContain("60% left");
  expect(text).toContain("10% left");
});

it("marks each window's pace against its reset", () => {
  const card = container.querySelector("section")!;
  expect(card.textContent).toMatch(/Resets in/);
  // The pace dot beside each window label.
  expect(card.querySelectorAll("h2 ~ div span[aria-hidden].rounded-full")).toHaveLength(2);
});
