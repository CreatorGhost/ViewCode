import { THREAD_GOAL_MAX_CHARS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { parseThreadSlashCommand, threadGoalUpdate } from "./threadGoal.ts";

describe("parseThreadSlashCommand", () => {
  it("reads /goal as edit, a control word or a new objective", () => {
    expect(parseThreadSlashCommand("/goal")).toEqual({
      command: "goal",
      goal: { action: "edit" },
    });
    expect(parseThreadSlashCommand("  /GOAL Pause ")).toEqual({
      command: "goal",
      goal: { action: "pause" },
    });
    expect(parseThreadSlashCommand("/goal all tests in\npackages/api pass")).toEqual({
      command: "goal",
      goal: { action: "set", objective: "all tests in\npackages/api pass" },
    });
    // `--` makes a control word the objective itself.
    expect(parseThreadSlashCommand("/goal -- clear")).toEqual({
      command: "goal",
      goal: { action: "set", objective: "clear" },
    });
    expect(parseThreadSlashCommand(`/goal ${"x".repeat(THREAD_GOAL_MAX_CHARS + 1)}`)).toEqual({
      command: "goal",
      goal: { action: "too-long" },
    });
  });

  it("reads /debug and /default only as whole messages", () => {
    expect(parseThreadSlashCommand("/debug")).toEqual({ command: "debug" });
    expect(parseThreadSlashCommand("/default ")).toEqual({ command: "default" });
    expect(parseThreadSlashCommand("/debug the login page")).toBeNull();
    expect(parseThreadSlashCommand("please /debug")).toBeNull();
    expect(parseThreadSlashCommand("/goals")).toBeNull();
  });
});

describe("threadGoalUpdate", () => {
  it("turns each action into the meta update that applies it", () => {
    expect(threadGoalUpdate({ action: "set", objective: "Ship" })).toEqual({
      goal: "Ship",
      goalPaused: false,
    });
    expect(threadGoalUpdate({ action: "pause" })).toEqual({ goalPaused: true });
    expect(threadGoalUpdate({ action: "resume" })).toEqual({ goalPaused: false });
    expect(threadGoalUpdate({ action: "clear" })).toEqual({ goal: null });
    expect(threadGoalUpdate({ action: "edit" })).toBeNull();
  });
});
