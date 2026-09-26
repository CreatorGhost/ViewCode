import type { OrchestrationThread } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { buildHandoff, extractKeyFacts } from "./Handoff.ts";

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
  it("carries the whole conversation when it fits in a quarter of the new model's window", () => {
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

    expect(handoff.mode).toBe("full");
    expect(prelude).toContain("### 1. User\nRemember the codeword PINEAPPLE and refactor auth.");
    expect(prelude).toContain("### 1. Assistant\nNoted. Starting with the session store.");
    expect(prelude).not.toContain("search_history tool");
    expect(prelude).toContain("/tmp/transcript.md");
    expect(handoff.summary).toContain("Carried the whole conversation");
  });

  it("compacts a long conversation for a small window, keeping key facts and asking the model to search", () => {
    const filler = "Context about the release process. ".repeat(600);
    const thread = threadWith([
      message(
        "user",
        `${filler}Recheck Randolph's PR https://github.com/acme/app/pull/1541 please.`,
        0,
      ),
      message("assistant", `${"Investigation notes. ".repeat(400)}Verdict: two issues remain.`, 1),
      message("user", "Check if the PR is good enough.", 2),
      message("assistant", "Which PR should I review?", 3),
      message("user", "The one from earlier.", 4),
      message("assistant", "On it.", 5),
    ]);

    const handoff = buildHandoff({
      thread,
      from,
      to,
      recentExchanges: 2,
      targetContextTokens: 8_000,
    });
    const prelude = handoff.prelude("/tmp/t.md");

    expect(handoff.mode).toBe("compact");
    expect(prelude).toContain("link: https://github.com/acme/app/pull/1541");
    expect(prelude).toContain("search_history");
    expect(prelude).toContain("### 3. User\nThe one from earlier.");
    expect(prelude).toContain("### 3. Assistant\nOn it.");
    expect(prelude.length).toBeLessThan(8_000 * 4 * 0.25 + 4_000);
    expect(handoff.summary).toContain("The new model summarizes the rest itself.");
  });

  it("extracts links, PRs, branches, commits and paths, newest first", () => {
    const facts = extractKeyFacts([
      "Started on git checkout -b fix/cordon-rollback",
      "Reviewed PR #1541 at 3e49cf2a3cb4eec9d4b1e3ebd4719a3ac2f383e6, see apps/api/cordon.py",
    ]);
    expect(facts).toContain("PR/issue: PR #1541");
    expect(facts).toContain("commit: 3e49cf2a3cb4eec9d4b1e3ebd4719a3ac2f383e6");
    expect(facts).toContain("path: apps/api/cordon.py");
    expect(facts).toContain("branch: fix/cordon-rollback");
    expect(facts.indexOf("PR/issue: PR #1541")).toBeLessThan(
      facts.indexOf("branch: fix/cordon-rollback"),
    );
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
