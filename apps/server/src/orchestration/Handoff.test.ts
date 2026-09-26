import type { OrchestrationThread } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { buildHandoff, estimateTokens, extractKeyFacts } from "./Handoff.ts";

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
    expect(handoff.summary).toContain("The new model summarizes the rest itself");
  });

  it("extracts links, PRs, branches, commits and paths, newest first", () => {
    const facts = extractKeyFacts([
      "Started on git checkout -b fix/cordon-rollback",
      "Reviewed PR #1541 at commit 3e49cf2a3cb4eec9d4b1e3ebd4719a3ac2f383e6, see apps/api/cordon.py",
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

  it("extracts root-level files and Windows paths, and only treats hex as a commit next to git words", () => {
    const facts = extractKeyFacts([
      "Update README.md and package.json, then open C:\\Users\\dev\\app\\main.ts and .\\scripts\\build.ps1.",
      "Built with Node.js and Next.js; see e.g. example.com.",
      "Color deadbeef1 and request id a1b2c3d4e5 are not commits.",
      "git show abc1234 and cherry-picked 9f8e7d6c5b",
    ]);
    expect(facts).toContain("file: README.md");
    expect(facts).toContain("file: package.json");
    expect(facts).toContain("path: C:\\Users\\dev\\app\\main.ts");
    expect(facts).toContain("path: .\\scripts\\build.ps1");
    expect(facts).toContain("commit: abc1234");
    expect(facts).toContain("commit: 9f8e7d6c5b");
    expect(facts.some((fact) => fact.includes("deadbeef1"))).toBe(false);
    expect(facts.some((fact) => fact.includes("a1b2c3d4e5"))).toBe(false);
    expect(facts.some((fact) => /node\.js|next\.js|example\.com|e\.g/i.test(fact))).toBe(false);
  });

  it("caps the length of each key fact", () => {
    const facts = extractKeyFacts([`see https://example.com/${"q".repeat(50_000)}`]);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.length).toBeLessThan(260);
  });

  describe("budget invariant: the whole prelude fits the budget", () => {
    const path = "/home/user/.t3/userdata/transcripts/thread-1/handoff-2026-01-01T00-00-00-000Z.md";
    const window = 8_000; // 2,000-token budget
    const check = (thread: OrchestrationThread) => {
      const handoff = buildHandoff({
        thread,
        from,
        to,
        recentExchanges: 3,
        targetContextTokens: window,
      });
      const prelude = handoff.prelude(path);
      expect(handoff.budgetTokens).toBe(2_000);
      expect(estimateTokens(prelude)).toBeLessThanOrEqual(handoff.budgetTokens);
      return { handoff, prelude };
    };

    it("1,000 short messages: newest user messages kept, the rest named as omitted", () => {
      const messages = Array.from({ length: 1_000 }, (_, index) => [
        message("user", `User request number ${index} about topic ${index}.`, index * 2),
        message(
          "assistant",
          `Reply ${index}: done with a fair amount of detail. `.repeat(3),
          index * 2 + 1,
        ),
      ]).flat();
      const { handoff, prelude } = check(threadWith(messages));
      expect(handoff.mode).toBe("compact");
      expect(prelude).toContain("User request number 999 about topic 999.");
      expect(prelude).toContain("of the user's 1000 messages are left out");
      expect(prelude).toContain("viewcode_search_history");
      expect(prelude).toContain(path);
      // The user's words win over the model's: the newest message survives before any reply is added.
      const userLines = prelude.split("\n").filter((line) => line.startsWith("User request"));
      expect(userLines.length).toBeGreaterThan(10);
    });

    it("prioritizes the user's messages over replies when both cannot fit", () => {
      const thread = threadWith([
        message("user", "Constraint: never touch the billing module. ".repeat(20), 0),
        message("assistant", "Long analysis. ".repeat(2_000), 1),
        message("user", "Codeword PINEAPPLE; keep it in mind. ".repeat(20), 2),
        message("assistant", "More analysis. ".repeat(2_000), 3),
      ]);
      const { handoff, prelude } = check(thread);
      expect(handoff.mode).toBe("compact");
      expect(prelude).toContain("Constraint: never touch the billing module. ".repeat(20).trim());
      expect(prelude).toContain("Codeword PINEAPPLE; keep it in mind. ".repeat(20).trim());
      expect(prelude).toContain("(final answer, condensed)");
    });

    it("a huge URL in a tool result", () => {
      const thread = threadWith(
        [message("user", "Fetch it", 0), message("assistant", "Fetched.", 1)],
        [
          {
            kind: "tool.completed",
            createdAt: "2026-01-01T00:00:30.000Z",
            payload: {
              itemType: "command_execution",
              detail: `curl https://x.test/${"a".repeat(100_000)}`,
            },
          },
        ],
      );
      const { prelude } = check(thread);
      expect(prelude).toContain("Fetch it");
    });

    it("huge tool results", () => {
      const activities = Array.from({ length: 200 }, (_, index) => ({
        kind: "tool.completed",
        createdAt: `2026-01-01T01:${String(index % 60).padStart(2, "0")}:00.000Z`,
        payload: {
          itemType: "command_execution",
          detail: `pnpm test --filter pkg-${index} ${"-v ".repeat(500)}`,
          output: `apps/pkg${index}/src/file${index}.ts failed\n${"log line\n".repeat(5_000)}`,
        },
      }));
      const { prelude } = check(
        threadWith(
          [message("user", "Run the tests", 0), message("assistant", "Ran them.", 1)],
          activities,
        ),
      );
      expect(prelude).toContain("Run the tests");
    });

    it("a window too small for the header carries only the header and the omission note", () => {
      const handoff = buildHandoff({
        thread: threadWith([message("user", "x".repeat(10_000), 0), message("assistant", "ok", 1)]),
        from,
        to,
        recentExchanges: 3,
        targetContextTokens: 1_000,
      });
      const prelude = handoff.prelude(path);
      expect(prelude).toContain("1 of the user's 1 messages are left out");
      expect(estimateTokens(prelude)).toBeLessThan(600);
    });

    it("one huge user message is clipped, never summarized, and points at the rest", () => {
      const { handoff, prelude } = check(
        threadWith([
          message("user", `START ${"x".repeat(200_000)} END`, 0),
          message("assistant", "ok", 1),
        ]),
      );
      expect(handoff.mode).toBe("compact");
      expect(prelude).toContain("START xxx");
      expect(prelude).not.toContain("END");
      expect(prelude).toContain("more chars; viewcode_search_history or the transcript");
    });
  });
});
