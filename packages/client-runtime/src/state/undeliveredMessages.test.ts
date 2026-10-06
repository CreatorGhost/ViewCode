import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { undeliveredUserMessages } from "./threadDetail.ts";

const activity = (
  kind: string,
  payload: unknown,
  summary = "Provider turn start failed",
): OrchestrationThreadActivity =>
  ({
    id: `activity-${kind}-${JSON.stringify(payload)}`,
    tone: "error",
    kind,
    summary,
    payload,
    turnId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  }) as OrchestrationThreadActivity;

describe("undeliveredUserMessages", () => {
  it("maps each failed turn start to the message it was for, with its reason", () => {
    expect(
      undeliveredUserMessages([
        activity("provider.turn.start.failed", {
          requestId: "message-1",
          detail: "Cursor refused the request.",
        }),
        activity(
          "provider.turn.start.failed",
          { requestId: "message-2" },
          "Queued message was not sent",
        ),
      ]),
    ).toEqual(
      new Map([
        ["message-1", "Cursor refused the request."],
        ["message-2", "Queued message was not sent"],
      ]),
    );
  });

  it("ignores other failures and returns one stable empty map", () => {
    const none = undeliveredUserMessages([
      activity("provider.turn.interrupt.failed", { requestId: "message-1", detail: "x" }),
      activity("provider.turn.start.failed", { detail: "no request id" }),
    ]);
    expect(none.size).toBe(0);
    expect(undeliveredUserMessages([])).toBe(none);
  });
});
