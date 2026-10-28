import { describe, expect, it, vi } from "vite-plus/test";

import { createSpeakModeAutoplay, speakModeUtterance } from "./speakMode.logic";

type Thread = Parameters<typeof speakModeUtterance>[1];

const reply = (id: string, turnId: string, text: string, spokenSummary?: string) => ({
  id,
  role: "assistant",
  text,
  turnId,
  streaming: false,
  createdAt: "",
  updatedAt: "",
  ...(spokenSummary === undefined ? {} : { spokenSummary }),
});

/** A thread whose latest turn is `turnId` in `state`, with `messages` so far. */
const thread = (
  turnId: string,
  state: "running" | "completed",
  messages: ReadonlyArray<ReturnType<typeof reply>>,
): Thread =>
  ({
    messages,
    latestTurn: {
      turnId,
      state,
      startedAt: "",
      completedAt: state === "completed" ? "now" : null,
    },
    session: null,
  }) as unknown as Thread;

const running = thread("t2", "running", [reply("a1", "t1", "First reply.", "First.")]);
const finished = thread("t2", "completed", [
  reply("a1", "t1", "First reply.", "First."),
  reply("a2", "t2", "Second reply, in full.", "Second, in short."),
]);

describe("speakModeUtterance", () => {
  it("reads the summary in summary mode and the reply in full mode", () => {
    expect(speakModeUtterance("summary", finished)?.text).toBe("Second, in short.");
    expect(speakModeUtterance("full", finished)?.text).toBe("Second reply, in full.");
    expect(speakModeUtterance("off", finished)).toBeNull();
  });

  it("waits for the summary and for the turn to complete", () => {
    const noSummary = thread("t2", "completed", [reply("a2", "t2", "Second reply.")]);
    expect(speakModeUtterance("summary", noSummary)).toBeNull();
    expect(speakModeUtterance("full", running)).toBeNull();
  });
});

describe("createSpeakModeAutoplay", () => {
  it("speaks once when a turn completes in the open thread", () => {
    const speak = vi.fn();
    const observe = createSpeakModeAutoplay(speak);
    observe({ threadKey: "env:thread", mode: "full", thread: running });
    observe({ threadKey: "env:thread", mode: "full", thread: finished });
    observe({ threadKey: "env:thread", mode: "full", thread: finished });
    expect(speak).toHaveBeenCalledExactlyOnceWith("env:thread:a2", "Second reply, in full.");
  });

  it("speaks the summary once it arrives, in summary mode", () => {
    const speak = vi.fn();
    const observe = createSpeakModeAutoplay(speak);
    const pending = thread("t2", "completed", [reply("a2", "t2", "Second reply, in full.")]);
    observe({ threadKey: "env:thread", mode: "summary", thread: running });
    observe({ threadKey: "env:thread", mode: "summary", thread: pending });
    expect(speak).not.toHaveBeenCalled();
    observe({ threadKey: "env:thread", mode: "summary", thread: finished });
    expect(speak).toHaveBeenCalledExactlyOnceWith("env:thread:a2", "Second, in short.");
  });

  it("stays silent while speak mode is off, and after turning it on for that turn", () => {
    const speak = vi.fn();
    const observe = createSpeakModeAutoplay(speak);
    observe({ threadKey: "env:thread", mode: "off", thread: running });
    observe({ threadKey: "env:thread", mode: "off", thread: finished });
    observe({ threadKey: "env:thread", mode: "full", thread: finished });
    expect(speak).not.toHaveBeenCalled();
  });

  it("never reads a turn that finished before the thread was opened", () => {
    const speak = vi.fn();
    const observe = createSpeakModeAutoplay(speak);
    observe({ threadKey: "env:other", mode: "full", thread: running });
    // The user opens a thread whose turn finished while it was not on screen.
    observe({ threadKey: "env:thread", mode: "full", thread: finished });
    observe({ threadKey: "env:thread", mode: "full", thread: finished });
    expect(speak).not.toHaveBeenCalled();
  });

  it("does not speak for a thread before it has loaded, then baselines it once it does", () => {
    const speak = vi.fn();
    const observe = createSpeakModeAutoplay(speak);
    observe({ threadKey: "env:thread", mode: "full", thread: null });
    observe({ threadKey: "env:thread", mode: "full", thread: finished });
    expect(speak).not.toHaveBeenCalled();
  });

  it("starts over when the user comes back to a thread", () => {
    const speak = vi.fn();
    const observe = createSpeakModeAutoplay(speak);
    observe({ threadKey: "env:thread", mode: "full", thread: running });
    // Away while the turn finishes, then back.
    observe({ threadKey: "env:other", mode: "full", thread: running });
    observe({ threadKey: "env:thread", mode: "full", thread: finished });
    expect(speak).not.toHaveBeenCalled();
  });
});
