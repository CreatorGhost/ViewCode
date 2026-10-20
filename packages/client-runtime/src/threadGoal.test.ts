import { THREAD_GOAL_MAX_CHARS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  parseThreadSlashCommand,
  THREAD_GOAL_CONTINUE_MESSAGE,
  THREAD_GOAL_START_MESSAGE,
  threadGoalRunMessage,
  threadGoalRunState,
  threadGoalUpdate,
} from "./threadGoal.ts";

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
    expect(parseThreadSlashCommand("/goal Run")).toEqual({
      command: "goal",
      goal: { action: "run" },
    });
    // `--` makes a control word the objective itself.
    expect(parseThreadSlashCommand("/goal -- clear")).toEqual({
      command: "goal",
      goal: { action: "set", objective: "clear" },
    });
    expect(parseThreadSlashCommand("/goal -- run")).toEqual({
      command: "goal",
      goal: { action: "set", objective: "run" },
    });
    expect(parseThreadSlashCommand("/goal run the full test suite")).toEqual({
      command: "goal",
      goal: { action: "set", objective: "run the full test suite" },
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
    expect(threadGoalUpdate({ action: "run" })).toBeNull();
  });
});

describe("threadGoalRunMessage", () => {
  it("starts on a fresh thread or a goal just written, and continues otherwise", () => {
    expect(threadGoalRunMessage({ hasMessages: false, goalChanged: false })).toBe(
      THREAD_GOAL_START_MESSAGE,
    );
    expect(threadGoalRunMessage({ hasMessages: true, goalChanged: true })).toBe(
      THREAD_GOAL_START_MESSAGE,
    );
    expect(threadGoalRunMessage({ hasMessages: true, goalChanged: false })).toBe(
      THREAD_GOAL_CONTINUE_MESSAGE,
    );
  });
});

describe("threadGoalRunState", () => {
  const active = { pausedAt: null };
  const paused = { pausedAt: "2026-10-20T10:00:00.000Z" };

  it("is ready only for an active goal on an idle thread that can send", () => {
    expect(threadGoalRunState({ goal: active, working: false, canSend: true })).toBe("ready");
    expect(threadGoalRunState({ goal: active, working: true, canSend: true })).toBe("working");
    expect(threadGoalRunState({ goal: active, working: false, canSend: false })).toBe("blocked");
    expect(threadGoalRunState({ goal: null, working: false, canSend: true })).toBe("no-goal");
  });

  it("keeps a paused goal paused whatever the thread is doing", () => {
    expect(threadGoalRunState({ goal: paused, working: false, canSend: true })).toBe("paused");
    expect(threadGoalRunState({ goal: paused, working: true, canSend: false })).toBe("paused");
  });
});
