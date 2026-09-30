import { describe, expect, it } from "@effect/vitest";

import {
  type ThreadObservation,
  type ThreadTrack,
  decideThreadNotification,
  decideUsageResumeNotification,
  formatPushNotification,
} from "./pushNotificationRules.ts";

const AUTO = "Trying to continue after the usage limit…";

const observe = (overrides: Partial<ThreadObservation>): ThreadObservation => ({
  phase: "running",
  turnId: "turn-1",
  turnState: "running",
  lastError: null,
  ...overrides,
});

/** Feeds observations in order and returns the notifications they produced. */
const run = (observations: ReadonlyArray<Partial<ThreadObservation>>) => {
  let track: ThreadTrack | undefined;
  const kinds: string[] = [];
  for (const overrides of observations) {
    const decision = decideThreadNotification(track, observe(overrides));
    track = decision.next;
    if (decision.kind) kinds.push(decision.kind);
  }
  return kinds;
};

describe("decideThreadNotification", () => {
  it("finishes a turn once even when the shell drops the turn id after it settles", () => {
    expect(
      run([
        { phase: "running" },
        { phase: "completed", turnState: "completed" },
        { phase: "running", turnId: null },
        { phase: "completed", turnId: null },
      ]),
    ).toEqual(["finished"]);
  });

  it("finishes each new turn", () => {
    expect(
      run([
        { phase: "running" },
        { phase: "completed" },
        { phase: "running", turnId: "turn-2" },
        { phase: "completed", turnId: "turn-2" },
      ]),
    ).toEqual(["finished", "finished"]);
  });

  it("says nothing for a stopped turn, a usage limit or a throttle", () => {
    expect(run([{ phase: "running" }, { phase: "completed", turnState: "interrupted" }])).toEqual(
      [],
    );
    expect(
      run([{ phase: "running" }, { phase: "failed", lastError: "5-hour limit reached" }]),
    ).toEqual([]);
    expect(
      run([{ phase: "running" }, { phase: "failed", lastError: "429 Too Many Requests" }]),
    ).toEqual([]);
    expect(run([{ phase: "running" }, { phase: "failed", lastError: "exit code 1" }])).toEqual([
      "failed",
    ]);
  });

  it("asks for the user on each new wait, not on every event while waiting", () => {
    expect(
      run([
        { phase: "running" },
        { phase: "waiting_for_approval" },
        { phase: "waiting_for_approval" },
        { phase: "waiting_for_input" },
        { phase: "running" },
        { phase: "waiting_for_approval" },
        { phase: "completed" },
      ]),
    ).toEqual(["needs-approval", "needs-input", "needs-approval", "finished"]);
  });

  it("does not fire on the first sighting or from a starting session", () => {
    expect(run([{ phase: "waiting_for_approval" }])).toEqual([]);
    expect(
      run([
        { phase: "starting", turnId: null },
        { phase: "completed", turnId: null },
      ]),
    ).toEqual([]);
  });
});

describe("decideUsageResumeNotification", () => {
  it("notifies a limit once per turn and only an automatic resume", () => {
    let track: ThreadTrack | undefined;
    const kinds: Array<string | null> = [];
    const feed = (state: string, summary = "", turnId: string | null = "turn-1") => {
      const decision = decideUsageResumeNotification(
        track,
        { payload: { state } as never, summary, turnId },
        AUTO,
      );
      track = decision.next;
      kinds.push(decision.kind);
    };
    feed("scheduled");
    feed("scheduled");
    feed("resumed", AUTO);
    feed("resumed", "Resumed by you.");
    feed("rate-limited");
    feed("cancelled");
    feed("gave-up", "", "turn-2");
    expect(kinds).toEqual([
      "usage-limit",
      null,
      "resumed",
      null,
      null,
      null,
      "usage-limit-gave-up",
    ]);
  });
});

describe("formatPushNotification", () => {
  it("names the thread and the event, and titles a child agent with its lead", () => {
    expect(
      formatPushNotification({
        kind: "needs-input",
        threadTitle: "Fix the login flow",
        leadTitle: null,
        payload: null,
        nowMs: 0,
      }),
    ).toEqual({ title: "Fix the login flow", body: "Has a question for you" });
    expect(
      formatPushNotification({
        kind: "usage-limit",
        threadTitle: "Write tests",
        leadTitle: "Ship v2",
        payload: { state: "unknown" },
        nowMs: 0,
      }),
    ).toEqual({
      title: "Ship v2",
      body: "Write tests: Usage limit reached. Send a message to continue.",
    });
  });

  it("clips long titles", () => {
    const { title } = formatPushNotification({
      kind: "finished",
      threadTitle: "x".repeat(200),
      leadTitle: null,
      payload: null,
      nowMs: 0,
    });
    expect(title.length).toBe(80);
    expect(title.endsWith("…")).toBe(true);
  });
});
