import type { OrchestrationThread } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { buildHandoff } from "./Handoff.ts";

function message(role: "user" | "assistant", text: string, index: number) {
  const at = `2026-01-01T00:${String(index).padStart(2, "0")}:00.000Z`;
  return {
    id: `m-${index}`,
    role,
    text,
    turnId: null,
    streaming: false,
    createdAt: at,
    updatedAt: at,
  };
}

function threadWith(messages: ReturnType<typeof message>[], activities: unknown[] = []) {
  return {
    title: "Refactor auth",
    messages,
    activities,
  } as unknown as OrchestrationThread;
}

const from = { instanceId: "claudeAgent", model: "claude-opus-4-6" };
const to = { instanceId: "codex", model: "gpt-5-codex" };

describe("buildHandoff", () => {
  it("carries every user message verbatim and only the latest replies in full", () => {
    const thread = threadWith([
      message("user", "Remember the codeword PINEAPPLE and refactor auth.", 0),
      message("assistant", "Noted. Starting with the session store.", 1),
      message("user", "Also add rate limiting.", 2),
      message("assistant", "Added a token bucket in middleware.ts.", 3),
      message("user", "Now write tests.", 4),
      message("assistant", "Tests added in auth.test.ts.", 5),
    ]);

    const handoff = buildHandoff({ thread, from, to, recentExchanges: 2 });
    const prelude = handoff.prelude("/tmp/transcript.md");

    expect(prelude).toContain("<handoff>");
    expect(prelude).toContain("### 1. User\nRemember the codeword PINEAPPLE and refactor auth.");
    expect(prelude).toContain("### 1. Assistant (final answer, condensed)");
    expect(prelude).toContain("### 3. User\nNow write tests.");
    expect(prelude).toContain("### 3. Assistant\nTests added in auth.test.ts.");
    expect(prelude).toContain("/tmp/transcript.md");
    expect(handoff.summary).toContain("last 2 replies verbatim");
    expect(handoff.transcript).toContain("Added a token bucket in middleware.ts.");
  });

  it("keeps long user messages whole and compacts long replies", () => {
    const longAsk = `${"Context about the release process. ".repeat(600)}Recheck Randolph's PR https://github.com/acme/app/pull/1541 for the cordon rollback fix.`;
    const longReply = `${"Step-by-step investigation notes. ".repeat(200)}Verdict: two issues remain.`;
    const thread = threadWith([
      message("user", longAsk, 0),
      message("assistant", "Looking at it now.", 1),
      message("assistant", longReply, 2),
      message("user", "Check if the PR is good enough.", 3),
      message("assistant", "Which PR should I review?", 4),
      message("user", "The one from earlier.", 5),
      message("assistant", "On it.", 6),
      message("user", "Keep going.", 7),
      message("assistant", "Still going.", 8),
    ]);

    const prelude = buildHandoff({ thread, from, to, recentExchanges: 2 }).prelude(null);

    expect(prelude).toContain("https://github.com/acme/app/pull/1541");
    expect(prelude).not.toContain("Looking at it now.");
    expect(prelude).not.toContain("Verdict: two issues remain.");
    expect(prelude).toContain(longAsk);
    expect(prelude.length).toBeLessThan(longAsk.length + 3_000);
  });

  it("lists touched files and open plan steps from activities", () => {
    const thread = threadWith(
      [message("user", "Fix the bug", 0), message("assistant", "Done", 1)],
      [
        { kind: "tool.completed", payload: { itemType: "file_change", detail: "src/a.ts" } },
        { kind: "tool.completed", payload: { itemType: "command_execution", detail: "pnpm test" } },
        {
          kind: "turn.plan.updated",
          payload: { plan: [{ step: "Write tests", status: "pending" }] },
        },
      ],
    );

    const prelude = buildHandoff({ thread, from, to, recentExchanges: 3 }).prelude(null);

    expect(prelude).toContain("- src/a.ts");
    expect(prelude).toContain("- pnpm test");
    expect(prelude).toContain("[pending] Write tests");
    expect(prelude).not.toContain("full transcript is at");
  });
});
