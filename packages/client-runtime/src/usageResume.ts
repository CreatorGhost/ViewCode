import {
  USAGE_RESUME_ACTIVITY_KIND,
  UsageResumePayload,
  type OrchestrationLatestTurn,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { formatResumeAt, formatResumeTime } from "@t3tools/shared/usageLimit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * What a thread shows when its provider's usage limit stopped the work. The
 * server records the state as the thread's latest `viewcode.usage-resume`
 * activity; this turns it into text and the actions to offer. Static text on
 * purpose: nothing ticks.
 */
export interface UsageResumeNotice {
  readonly state: "scheduled" | "rate-limited" | "reset-known" | "unknown" | "gave-up";
  readonly text: string;
  /** Only a scheduled resume or retry can be cancelled. */
  readonly canCancel: boolean;
}

const decodePayload = Schema.decodeUnknownOption(UsageResumePayload);

/**
 * "6:01 AM" today, "tomorrow at 9:00 AM", "Thursday at 9:00 AM" within a week,
 * otherwise "Oct 8, 9:00 AM". Web, mobile and the desktop notification all word
 * resume times through this one function.
 */
export function formatUsageResumeTime(
  iso: string,
  nowMs: number,
  locale?: string | undefined,
): string {
  return formatResumeTime(iso, nowMs, locale);
}

/** `formatUsageResumeTime` after a verb: "at 6:01 AM", "tomorrow at 9:00 AM", "on Oct 8, 9:00 AM". */
export function formatUsageResumeAt(
  iso: string,
  nowMs: number,
  locale?: string | undefined,
): string {
  return formatResumeAt(iso, nowMs, locale);
}

/**
 * The desktop notification for a thread stopped on a usage limit. `resumeAt`
 * is the scheduled resume; without one the user has to continue it.
 */
export function usageLimitNotificationBody(
  resumeAt: string | undefined,
  nowMs: number,
  locale?: string | undefined,
): string {
  return resumeAt === undefined
    ? "Usage limit reached. Send a message to continue."
    : `Usage limit reached. Continuing ${formatUsageResumeAt(resumeAt, nowMs, locale)}.`;
}

export function deriveUsageResumeNotice(input: {
  readonly activities: ReadonlyArray<
    Pick<OrchestrationThreadActivity, "kind" | "payload" | "createdAt">
  >;
  /** Clients name session states differently; only "running" and "starting" matter here. */
  readonly session: { readonly status: string } | null;
  readonly latestTurn: Pick<OrchestrationLatestTurn, "requestedAt"> | null;
  readonly nowMs: number;
  readonly locale?: string | undefined;
}): UsageResumeNotice | null {
  const latest = input.activities.findLast((entry) => entry.kind === USAGE_RESUME_ACTIVITY_KIND);
  if (!latest) return null;
  const decoded = decodePayload(latest.payload);
  if (Option.isNone(decoded)) return null;
  const payload = decoded.value;
  if (payload.state === "cancelled" || payload.state === "resumed") return null;
  // Work has started since (the user typed, or the resume ran): the note is stale.
  if (input.session?.status === "running" || input.session?.status === "starting") return null;
  if (input.latestTurn && input.latestTurn.requestedAt > latest.createdAt) return null;

  const at = (iso: string | undefined) =>
    iso === undefined ? null : formatUsageResumeAt(iso, input.nowMs, input.locale);
  switch (payload.state) {
    case "scheduled": {
      const time = at(payload.resumeAt);
      if (time === null) return null;
      return {
        state: "scheduled",
        text: `Out of usage · resumes automatically ${time}`,
        canCancel: true,
      };
    }
    case "rate-limited": {
      const time = at(payload.resumeAt);
      if (time === null) return null;
      return {
        state: "rate-limited",
        text: `Rate limited by the server; retrying ${time}`,
        canCancel: true,
      };
    }
    case "reset-known": {
      const time = at(payload.resetsAt);
      if (time === null) return null;
      return { state: "reset-known", text: `Out of usage · resets ${time}`, canCancel: false };
    }
    case "gave-up":
      return {
        state: "gave-up",
        text: "Out of usage · automatic resume stopped after two tries",
        canCancel: false,
      };
    default:
      return {
        state: "unknown",
        text: "Out of usage; ViewCode can't tell when it resets.",
        canCancel: false,
      };
  }
}
