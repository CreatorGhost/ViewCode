// Standalone entry for the agent-facing review CLI, launched by the
// `viewcode-review` shim: `viewcode-review.mjs <command> [flags]`. The
// executable reaches the same CLI through `__viewcode-review -- <args>`.
import { runReviewCliMain } from "./reviewCli/ReviewCli.ts";

process.exitCode = await runReviewCliMain(process.argv.slice(2));
