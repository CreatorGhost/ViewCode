import * as Context from "effect/Context";

/** One scheduler owns automatic continuations; upstream recovery still manages snoozing. */
export const ViewCodeUsageResumeEnabled = Context.Reference<boolean>(
  "viewcode/UsageResumeEnabled",
  { defaultValue: () => true },
);
