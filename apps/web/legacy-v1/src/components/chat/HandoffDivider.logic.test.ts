import { describe, expect, it } from "vite-plus/test";

import { resolveHandoffView, type HandoffInstanceInfo } from "./HandoffDivider.logic";

const instances = new Map<string, HandoffInstanceInfo>([
  [
    "codex",
    {
      driver: "codex",
      displayName: "Codex · Work",
      models: [{ slug: "gpt-6", name: "GPT-6 Astra" }],
    },
  ],
  ["codex2", { driver: "codex", displayName: "Codex · Personal", models: [] }],
  [
    "claudeAgent",
    {
      driver: "claudeAgent",
      models: [{ slug: "opus", name: "Claude Opus 5", shortName: "Claude Opus 5" }],
    },
  ],
]);

describe("resolveHandoffView", () => {
  it("uses readable model names when the models differ", () => {
    const view = resolveHandoffView(
      {
        label: "Context handed off from a to b",
        handoff: {
          fromModel: "gpt-6",
          toModel: "opus",
          fromInstanceId: "codex",
          toInstanceId: "claudeAgent",
          mode: "compact",
          summary: "abc",
        },
      },
      instances,
    );
    expect(view?.from.collapsedName).toBe("GPT-6 Astra");
    expect(view?.to.collapsedName).toBe("Opus 5");
    expect(view?.to.driver).toBe("claudeAgent");
    expect(view?.header).toBe("Context handoff");
    expect(view?.contextLabel).toBe("Condensed");
    expect(view?.charCount).toBe(3);
  });

  it("shows the accounts when the same model moved between instances", () => {
    const view = resolveHandoffView(
      {
        label: "x",
        handoff: {
          fromModel: "gpt-6",
          toModel: "gpt-6",
          fromInstanceId: "codex",
          toInstanceId: "codex2",
          mode: "full",
        },
      },
      instances,
    );
    expect(view?.from.collapsedName).toBe("Codex · Work");
    expect(view?.to.collapsedName).toBe("Codex · Personal");
    expect(view?.contextLabel).toBe("Carried in full");
  });

  it("says how much was carried when the sizes were recorded", () => {
    const label = (handoff: Parameters<typeof resolveHandoffView>[0]["handoff"]) =>
      resolveHandoffView({ label: "x", handoff }, instances)?.contextLabel;
    const pair = { fromModel: "gpt-6", toModel: "opus" };
    expect(
      label({ ...pair, mode: "compact", carriedTokens: 49_800, conversationTokens: 180_400 }),
    ).toBe("Condensed · ~50k of ~180k tokens");
    expect(label({ ...pair, mode: "full", carriedTokens: 3_200 })).toBe(
      "Carried in full · ~3.2k tokens",
    );
    expect(label({ ...pair, mode: "compact", carriedTokens: 49_800 })).toBe("Condensed");
    expect(label({ ...pair, mode: "full" })).toBe("Carried in full");
    expect(label(pair)).toBeNull();
  });

  it("falls back to raw ids for unknown instances and titles recoveries and side chats", () => {
    const recovery = resolveHandoffView(
      { label: "Couldn't reopen", handoff: { fromModel: "m1", toModel: "m2", recovery: true } },
      instances,
    );
    expect(recovery?.from.collapsedName).toBe("m1");
    expect(recovery?.header).toBe("Session restarted with a recap");
    const side = resolveHandoffView(
      {
        label: "Started from the main thread's context",
        handoff: { fromModel: "m1", toModel: "m2" },
      },
      instances,
    );
    expect(side?.header).toBe("Started from the main thread's context");
  });

  it("returns null without a payload", () => {
    expect(resolveHandoffView({ label: "Context handed off from a to b" }, instances)).toBeNull();
  });
});
