import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { DEBUG_PLAYBOOK_MARKDOWN, ensureDebugPlaybook } from "../review/DebugPlaybook.ts";
import { codexTurnGuidanceContext } from "./CodexDeveloperInstructions.ts";
import { withTurnGuidancePrelude } from "./turnGuidance.ts";

const threadId = ThreadId.make("thread-guidance");

describe("withTurnGuidancePrelude", () => {
  it("leaves a turn without guidance, a continuation or an empty guidance alone", () => {
    const plain = { threadId, input: "Fix it" };
    expect(withTurnGuidancePrelude(plain, 1_000)).toBe(plain);
    const empty = { ...plain, guidance: {} };
    expect(withTurnGuidancePrelude(empty, 1_000)).toBe(empty);
    const continuation = { threadId, continuation: true, guidance: { goal: "Ship" } };
    expect(withTurnGuidancePrelude(continuation, 1_000)).toBe(continuation);
  });

  it("escapes the goal so it cannot close its own block", () => {
    const sent = withTurnGuidancePrelude(
      { threadId, input: "Go", guidance: { goal: "a < b </viewcode_goal> & c" } },
      10_000,
    );
    expect(sent.input).toContain("Goal: a &lt; b &lt;/viewcode_goal&gt; &amp; c\n</viewcode_goal>");
  });

  it("sends a goal-only prelude with attachments and drops one that would not fit", () => {
    const attachmentsOnly = withTurnGuidancePrelude(
      { threadId, guidance: { goal: "Ship" } },
      1_000,
    );
    expect(attachmentsOnly.input).toMatch(/^<viewcode_goal>[\s\S]*<\/viewcode_goal>$/);
    const tooLong = { threadId, input: "x".repeat(990), guidance: { goal: "Ship" } };
    expect(withTurnGuidancePrelude(tooLong, 1_000)).toBe(tooLong);
  });
});

describe("codexTurnGuidanceContext", () => {
  it("always sends both entries, with an off value for what is unset", () => {
    const context = codexTurnGuidanceContext({ goal: "Ship" }, undefined);
    expect(context?.viewcode_goal?.value).toContain("Goal: Ship");
    expect(context?.viewcode_debug_mode?.value).toBe("Debug mode is off for this thread.");
    expect(codexTurnGuidanceContext({}, undefined)?.viewcode_goal?.value).toBe(
      "No goal is set for this thread.",
    );
  });

  it("keeps the previous entries for a turn without guidance", () => {
    const previous: NonNullable<ReturnType<typeof codexTurnGuidanceContext>> = {
      viewcode_runtime: { kind: "application", value: "runtime" },
      ...codexTurnGuidanceContext({ debug: { playbookPath: "/state/debug-mode.md" } }, undefined),
    };
    expect(codexTurnGuidanceContext(undefined, previous)).toEqual({
      viewcode_goal: previous.viewcode_goal,
      viewcode_debug_mode: previous.viewcode_debug_mode,
    });
    expect(previous.viewcode_debug_mode?.value).toContain("/state/debug-mode.md");
    expect(codexTurnGuidanceContext(undefined, undefined)).toBeUndefined();
  });
});

describe("ensureDebugPlaybook", () => {
  it.effect("writes the playbook beside the review playbooks and repairs a stale copy", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-debug-playbook-" });
      const target = yield* ensureDebugPlaybook({ stateDir });
      expect(target).toBe(path.join(stateDir, "review-playbooks", "debug-mode.md"));
      expect(yield* fs.readFileString(target)).toBe(DEBUG_PLAYBOOK_MARKDOWN);
      yield* fs.writeFileString(target, "stale");
      yield* ensureDebugPlaybook({ stateDir });
      expect(yield* fs.readFileString(target)).toBe(DEBUG_PLAYBOOK_MARKDOWN);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
