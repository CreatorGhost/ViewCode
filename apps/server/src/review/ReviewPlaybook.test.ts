import * as NodeServices from "@effect/platform-node/NodeServices";
import { AGENT_REVIEW_MODES } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { ensureReviewPlaybook, reviewPlaybookMarkdown } from "./ReviewPlaybook.ts";

describe("ensureReviewPlaybook", () => {
  it.effect("writes each mode's playbook to an absolute path and repairs a stale copy", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-playbook-" });
      for (const { mode, label } of AGENT_REVIEW_MODES) {
        const target = yield* ensureReviewPlaybook({ stateDir, mode });
        expect(path.isAbsolute(target)).toBe(true);
        expect(path.dirname(target)).toBe(path.join(stateDir, "review-playbooks"));
        const text = yield* fs.readFileString(target);
        expect(text).toBe(reviewPlaybookMarkdown(mode));
        expect(text).toContain(`# ViewCode ${label}`);
        // Findings reach the reader while the review goes on, then as one final set.
        expect(text).toContain("`complete: false`");
        expect(text).toContain("once more without `complete`");
      }

      // An older release's text is replaced, not trusted.
      const quick = yield* ensureReviewPlaybook({ stateDir, mode: "quick" });
      yield* fs.writeFileString(quick, "stale");
      yield* ensureReviewPlaybook({ stateDir, mode: "quick" });
      expect(yield* fs.readFileString(quick)).toBe(reviewPlaybookMarkdown("quick"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
