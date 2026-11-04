import { describe, expect, it } from "vite-plus/test";
import { withViewCodeTurnGuidance } from "./ViewCodeTurnGuidance.ts";

const goal = {
  objective: "Ship <all> & pass tests",
  pausedAt: null,
  updatedAt: "2026-10-18T00:00:00.000Z",
};
const input = {
  appThread: { viewcodeGoal: goal, debugMode: true },
  message: { text: "Continue", attachments: ["kept"] },
  appContext: [{ key: "another_app", text: "Keep this" }],
};

describe("ViewCode goal/debug turn guidance", () => {
  it.each([
    "claudeAgent",
    "cursor",
    "grok",
    "opencode",
    "antigravity",
    "commandCode",
    "droid",
    "devin",
    "pi",
    "muse",
  ])("guides ordinary %s turns and retains their message metadata", (driver) => {
    const turn = withViewCodeTurnGuidance(input, {
      driver,
      playbookPath: "/sandbox/debug-mode.md",
    });
    expect(turn.message.text).toContain("Goal: Ship &lt;all&gt; &amp; pass tests");
    expect(turn.message.text).toContain("/sandbox/debug-mode.md");
    expect(turn.message.text).toMatch(/Continue$/);
    expect(turn.message.attachments).toBe(input.message.attachments);
    expect(turn.appContext[0]).toEqual(input.appContext[0]);
  });
  it("uses Codex native context and replaces old keyed guidance after pause, clear and debug off", () => {
    const first = withViewCodeTurnGuidance(input, { driver: "codex", playbookPath: null });
    expect(first.message).toBe(input.message);
    expect(first.appContext).toHaveLength(3);
    const paused = withViewCodeTurnGuidance(
      {
        ...first,
        appThread: { viewcodeGoal: { ...goal, pausedAt: goal.updatedAt }, debugMode: false },
      },
      { driver: "codex", playbookPath: null },
    );
    expect(paused.appContext).toHaveLength(3);
    expect(paused.appContext.find((entry) => entry.key === "viewcode_goal")?.text).toContain(
      "Do not pursue it",
    );
    const cleared = withViewCodeTurnGuidance(
      { ...paused, appThread: { viewcodeGoal: null, debugMode: false } },
      { driver: "codex", playbookPath: null },
    );
    expect(cleared.appContext.find((entry) => entry.key === "viewcode_goal")?.text).toContain(
      "Stop pursuing",
    );
    expect(cleared.appContext.find((entry) => entry.key === "viewcode_debug_mode")?.text).toContain(
      "Debug mode is off",
    );
  });
  it("delivers computer-use help to ordinary turns and replaces stale grants", () => {
    const help = "Use /sandbox/viewcode-computer --help before observing.";
    for (const driver of ["codex", "claudeAgent", "commandCode", "droid", "devin", "pi"]) {
      const enabled = withViewCodeTurnGuidance(input, {
        driver,
        playbookPath: null,
        computerUseText: help,
      });
      expect(enabled.appContext.find((entry) => entry.key === "viewcode_computer_use")?.text).toBe(
        help,
      );
      expect(enabled.message.text.includes(help)).toBe(driver !== "codex");
      const disabled = withViewCodeTurnGuidance(
        { ...input, appContext: enabled.appContext },
        {
          driver,
          playbookPath: null,
          computerUseText: null,
        },
      );
      expect(
        disabled.appContext.filter((entry) => entry.key === "viewcode_computer_use"),
      ).toHaveLength(1);
      expect(
        disabled.appContext.find((entry) => entry.key === "viewcode_computer_use")?.text,
      ).toContain("not enabled");
      expect(disabled.appContext.some((entry) => entry.text === help)).toBe(false);
    }
    const slash = withViewCodeTurnGuidance(
      { ...input, message: { text: "/compact" } },
      {
        driver: "claudeAgent",
        playbookPath: null,
        computerUseText: help,
      },
    );
    expect(slash.message.text).toBe("/compact");
    expect(slash.appContext.some((entry) => entry.text === help)).toBe(true);
  });
  it("keeps Cursor dollar skills at the start while still supplying ViewCode context", () => {
    const text = "$review README.md";
    const turn = withViewCodeTurnGuidance(
      { ...input, message: { text } },
      { driver: "cursor", playbookPath: null, computerUseText: "Computer policy guidance" },
    );
    expect(turn.message.text.startsWith(`${text}\n\n`)).toBe(true);
    expect(turn.message.text).toContain("<viewcode_goal>");
    expect(turn.message.text).toContain("<viewcode_debug_mode>");
    expect(turn.message.text).toContain("Computer policy guidance");
  });
  it("does not rewrite native slash commands or compact control turns", () => {
    for (const message of ["/compact", "  /usage", "/clear"]) {
      const turn = withViewCodeTurnGuidance(
        { ...input, message: { text: message } },
        { driver: "claudeAgent", playbookPath: null },
      );
      expect(turn.message.text).toBe(message);
      expect(turn.appContext).toHaveLength(3);
    }
    expect(
      withViewCodeTurnGuidance(input, { driver: "claudeAgent", compact: true, playbookPath: null })
        .message,
    ).toBe(input.message);
  });
  it("tells only RockBot threads that they are RockBot", () => {
    const rockBot = withViewCodeTurnGuidance(
      { ...input, appThread: { ...input.appThread, kind: "orchestrator" as const } },
      { driver: "claudeAgent", playbookPath: null },
    );
    expect(rockBot.message.text).toContain("<viewcode_rockbot>");
    expect(rockBot.message.text).toContain("t3_attention_list");
    const ordinary = withViewCodeTurnGuidance(input, { driver: "claudeAgent", playbookPath: null });
    expect(ordinary.message.text).not.toContain("RockBot");
  });
});
