import type { OrchestrationThread } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { buildHandoff } from "./Handoff.ts";

function message(role: "user" | "assistant", text: string, index: number) {
  const at = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
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
  it("keeps the original ask, condenses older exchanges and carries recent ones verbatim", () => {
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
    expect(prelude).toContain("PINEAPPLE");
    expect(prelude).toContain("## Earlier exchanges (condensed)");
    expect(prelude).toContain("### User\nNow write tests.");
    expect(prelude).toContain("/tmp/transcript.md");
    expect(handoff.summary).toContain("2 carried verbatim");
    expect(handoff.transcript).toContain("Added a token bucket in middleware.ts.");
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
