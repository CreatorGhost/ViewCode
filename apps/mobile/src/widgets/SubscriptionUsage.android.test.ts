import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@expo/ui/jetpack-compose", () => ({
  Box: "Box",
  Button: "Button",
  Column: "Column",
  Image: "Image",
  LinearProgressIndicator: "LinearProgressIndicator",
  Row: "Row",
  Spacer: "Spacer",
  Text: "Text",
}));

vi.mock("@expo/ui/jetpack-compose/modifiers", () => ({
  background: (color: string) => ({ background: color }),
  cornerRadius: (value: number) => ({ cornerRadius: value }),
  fillMaxSize: () => "fillMaxSize",
  fillMaxWidth: () => "fillMaxWidth",
  height: (value: number) => ({ height: value }),
  padding: (...values: number[]) => ({ padding: values }),
  paddingAll: (value: number) => ({ paddingAll: value }),
  size: (...values: number[]) => ({ size: values }),
}));

vi.mock("expo-widgets", () => ({
  createWidget: vi.fn((name: string, layout: unknown) => ({ layout, name })),
}));

import { SubscriptionUsage } from "./SubscriptionUsage.android";
import type { SubscriptionUsageSnapshot } from "./subscriptionUsageSnapshot";

const now = new Date(2026, 8, 5, 12, 0).getTime();
const provider = {
  driver: "codex",
  name: "Codex",
  detail: "",
  windows: [
    { kind: "session", label: "5 hours", remaining: 60, resetAt: now + 60 * 60_000 },
    { kind: "weekly", label: "Weekly", remaining: 8, resetAt: now + 3 * 24 * 60 * 60_000 },
  ],
  totalWindows: 2,
} satisfies SubscriptionUsageSnapshot["providers"][number];
const snapshot = {
  checkedAt: now,
  url: "viewcode-dev://settings/usage?tab=limits",
  providers: [provider, { ...provider, driver: "claudeAgent", name: "Claude" }],
} satisfies SubscriptionUsageSnapshot;

function render(
  props: SubscriptionUsageSnapshot,
  options: { at?: number; width?: number; height?: number } = {},
) {
  vi.setSystemTime(options.at ?? now);
  return JSON.stringify(
    SubscriptionUsage(props, {
      colorScheme: "dark",
      configuration: undefined,
      widgetSize: { width: options.width ?? 300, height: options.height ?? 360 },
    }),
  );
}

describe("SubscriptionUsage Android layout", () => {
  it("renders each limit with its logo, share left, bar and refill time", () => {
    const tree = render(snapshot);
    expect(tree).toContain("usage_widget_logo_codex");
    expect(tree).toContain("usage_widget_logo_claudeagent");
    expect(tree).toContain("60%");
    expect(tree).toContain('"progress":0.6');
    expect(tree).toMatch(/5 hours · resets \d/);
    expect(tree).toContain('"color":"#FF6B6B"');
    expect(tree).toContain('"target":"viewcode-dev://settings/usage?tab=limits"');
  });

  it("keeps showing the last reading long after it was taken", () => {
    const tree = render(snapshot, { at: now + 30 * 60_000 });
    expect(tree).toContain("60%");
    expect(tree).not.toMatch(/refresh|Open/);
  });

  it("shows a window as full once its refill time passes", () => {
    const tree = render(snapshot, { at: now + 2 * 60 * 60_000 });
    expect(tree).toContain("5 hours · reset");
    expect(tree).toContain("100%");
    expect(tree).toContain("8%");
  });

  it("keeps the tightest limit when only one per provider fits", () => {
    const tree = render(snapshot, { height: 230 });
    expect(tree).toContain("Weekly · resets");
    expect(tree).not.toContain("5 hours");
  });

  it("falls back to one bar per provider and counts the providers that do not fit", () => {
    const many = {
      ...snapshot,
      providers: ["codex", "claudeAgent", "cursor", "grok", "droid"].map((driver) => ({
        ...provider,
        driver,
        name: driver,
      })),
    };
    const tree = render(many, { height: 200 });
    expect(tree).not.toContain("5 hours");
    expect(tree).toContain("+3 more");
    expect(tree).toContain("8%");
  });

  it("names a provider without a logo or a reading", () => {
    const tree = render({
      ...snapshot,
      providers: [
        { driver: "future", name: "Future", detail: "No data yet", windows: [], totalWindows: 0 },
      ],
    });
    expect(tree).toContain("Future");
    expect(tree).toContain("No data yet");
    expect(tree).not.toContain("usage_widget_logo_");
  });

  it("opens the app when nothing has been published yet", () => {
    vi.setSystemTime(now);
    const tree = JSON.stringify(
      SubscriptionUsage({} as SubscriptionUsageSnapshot, {
        colorScheme: "light",
        configuration: undefined,
      }),
    );
    expect(tree).toContain("Open ViewCode to load your limits.");
    expect(tree).toContain('"target":"launch:"');
    expect(tree).toContain('"containerColor":"#FFFFFF"');
  });
});
