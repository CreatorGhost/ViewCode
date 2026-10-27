import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { SPOKEN_SUMMARY_MAX_WORDS, sanitizeSpokenSummary } from "./spokenSummary.ts";
import { fromRunner, type Runner } from "./textGenerationOperations.ts";

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

const generateSpokenSummary = (reply: string, modelOutput: string) => {
  const prompts: Array<string> = [];
  const runner = ((request) => {
    prompts.push(request.prompt);
    return Effect.succeed({ summary: modelOutput });
  }) as Runner;
  return fromRunner("Test", runner)
    .generateSpokenSummary({
      cwd: "/repo",
      message: reply,
      modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-haiku-5-5" },
    })
    .pipe(Effect.map(({ summary }) => ({ summary, prompt: prompts[0] ?? "" })));
};

describe("fromRunner generateSpokenSummary", () => {
  it.effect("strips markdown and code a small model returned anyway", () =>
    Effect.gen(function* () {
      const { summary } = yield* generateSpokenSummary(
        "irrelevant",
        [
          "## Summary",
          "- **Fixed** the `retry` test in [the suite](https://example.com/x)",
          "- Ran it *twice*",
          "```ts",
          "const x = 1;",
          "```",
          "1. Nothing else to do",
        ].join("\n"),
      );

      assert.equal(
        summary,
        "Summary. Fixed the retry test in the suite. Ran it twice. Nothing else to do.",
      );
      assert.notMatch(summary, /[`*#[\]()]|https?:|const x/);
    }),
  );

  it.effect("caps the summary at four sentences and the word limit", () =>
    Effect.gen(function* () {
      const sentence = "The agent changed one more file in the project.";
      const six = Array.from({ length: 6 }, () => sentence).join(" ");
      assert.equal(
        (yield* generateSpokenSummary("irrelevant", six)).summary,
        Array.from({ length: 4 }, () => sentence).join(" "),
      );

      const runOn = Array.from(
        { length: 30 },
        (_, index) => `Clause ${index} has five words,`,
      ).join(" ");
      const capped = (yield* generateSpokenSummary("irrelevant", runOn)).summary;
      assert.equal(words(capped), SPOKEN_SUMMARY_MAX_WORDS);
      assert.match(capped, /[^,]\.$/);
    }),
  );

  it.effect("keeps both ends of a long reply in the prompt", () =>
    Effect.gen(function* () {
      const { prompt } = yield* generateSpokenSummary(
        `OPENING ${"x".repeat(20_000)} CLOSING`,
        "Done.",
      );
      assert.include(prompt, "OPENING");
      assert.include(prompt, "CLOSING");
      assert.isBelow(prompt.length, 14_000);
    }),
  );
});

describe("sanitizeSpokenSummary", () => {
  it("drops whole sentences past the word limit instead of cutting one mid-way", () => {
    const twentyFive = `Then ${"word ".repeat(23)}end.`;
    const summary = sanitizeSpokenSummary(`${twentyFive} ${twentyFive} ${twentyFive}`);
    assert.equal(words(summary), 50);
    assert.isTrue(summary.endsWith("end."));
  });

  it("returns nothing when the model wrote only code", () => {
    assert.equal(sanitizeSpokenSummary("```\nnpm test\n```"), "");
  });
});
