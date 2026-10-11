import { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  buildAgentReviewStart,
  formatReviewElapsed,
  reviewStatusText,
  shortReviewError,
} from "./agentReview.ts";

const PROJECT_ID = ProjectId.make("project");
const CHAT = ThreadId.make("chat");
const MODEL = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1" };

describe("buildAgentReviewStart", () => {
  it("starts a pull request review as the asking chat's agent, leaving out empty choices", () => {
    expect(
      buildAgentReviewStart(
        {
          kind: "pull-request",
          reference: { projectId: PROJECT_ID, repository: "acme/web", number: 7 },
          sourceThreadId: CHAT,
        },
        { mode: "deep", modelSelection: MODEL, focus: "  ", scope: { kind: "uncommitted" } },
        { canScope: true },
      ),
    ).toEqual({
      method: "pullRequests.startReview",
      input: {
        projectId: PROJECT_ID,
        repository: "acme/web",
        number: 7,
        mode: "deep",
        modelSelection: MODEL,
        sourceThreadId: CHAT,
      },
    });
  });

  it("sends what to read of local changes only to a server that reads it", () => {
    const request = { kind: "local", projectId: PROJECT_ID, sourceThreadId: CHAT } as const;
    const choices = {
      mode: "quick",
      modelSelection: null,
      focus: " retries ",
      scope: { kind: "commit", sha: "abc1234" },
    } as const;
    expect(buildAgentReviewStart(request, choices, { canScope: true })).toEqual({
      method: "review.startLocal",
      input: {
        projectId: PROJECT_ID,
        mode: "quick",
        focus: "retries",
        sourceThreadId: CHAT,
        scope: { kind: "commit", sha: "abc1234" },
      },
    });
    // An older server would ignore it and review something else.
    expect(buildAgentReviewStart(request, choices, { canScope: false }).input).not.toHaveProperty(
      "scope",
    );
  });
});

describe("reviewStatusText", () => {
  const label = "Deep review · GPT-6.1";
  it("says how long a review has run, and what became of one that stopped", () => {
    const text = (progress: Parameters<typeof reviewStatusText>[0]["progress"], newer = false) =>
      reviewStatusText({ progress, label, elapsedMs: 6 * 60_000 + 30_000, newer });
    expect(text({ kind: "running", partial: false })).toBe(
      "Reviewing… Deep review · GPT-6.1 · 6 min",
    );
    expect(text({ kind: "running", partial: false }, true)).toBe(
      "A new review is running: Deep review · GPT-6.1 · 6 min",
    );
    expect(text({ kind: "failed", error: "Quota exceeded\n  at frame", partial: false })).toBe(
      "Review failed: Quota exceeded",
    );
    expect(text({ kind: "ended", partial: false })).toBe(
      "The review ended without sending findings",
    );
    expect(text({ kind: "ended", partial: true })).toBe(
      "The review ended before sending all its findings",
    );
    expect(text({ kind: "done" })).toBeNull();
  });

  it("counts whole minutes, then hours, and cuts an error to one line", () => {
    expect(formatReviewElapsed(30_000)).toBe("just started");
    expect(formatReviewElapsed(65 * 60_000)).toBe("1 h 5 min");
    expect(formatReviewElapsed(120 * 60_000)).toBe("2 h");
    // A clock a little behind the server's never shows a negative time.
    expect(formatReviewElapsed(-5_000)).toBe("just started");
    expect(shortReviewError("x".repeat(200))).toHaveLength(140);
    expect(shortReviewError(null)).toBe("the reviewer stopped with an error");
  });
});
