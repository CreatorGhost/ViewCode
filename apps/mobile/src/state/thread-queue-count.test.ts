import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("./threads", () => ({ environmentThreadDetails: {} }));

import { countThreadQueuedMessages } from "./use-thread-queue";

describe("canonical mobile queue count", () => {
  it("hands pending transport ownership to the server without double-counting its echo", () => {
    const local = [{ messageId: "one" }, { messageId: "two" }];
    expect(
      countThreadQueuedMessages({ serverQueue: [], localMessages: local, serverMessages: [] }),
    ).toBe(2);
    const serverQueue = [{ messageId: "one" }];
    expect(
      countThreadQueuedMessages({
        serverQueue,
        localMessages: local,
        serverMessages: [{ id: "one" }],
      }),
    ).toBe(2);
    expect(
      countThreadQueuedMessages({
        serverQueue,
        localMessages: [local[1]!],
        serverMessages: [{ id: "one" }],
      }),
    ).toBe(2);
    expect(
      countThreadQueuedMessages({
        serverQueue: [...serverQueue, { messageId: "two" }],
        localMessages: [],
        serverMessages: [{ id: "one" }, { id: "two" }],
      }),
    ).toBe(2);
  });

  it("does not count an admitted active/completed message whose local cleanup is still pending", () => {
    expect(
      countThreadQueuedMessages({
        serverQueue: [{ messageId: "next" }],
        localMessages: [
          { messageId: "active" },
          { messageId: "completed" },
          { messageId: "next" },
          { messageId: "offline" },
        ],
        serverMessages: [{ id: "active" }, { id: "completed" }, { id: "next" }],
      }),
    ).toBe(2);
  });

  it("deduplicates ambiguous retries even before the server's timeline echo arrives", () => {
    expect(
      countThreadQueuedMessages({
        serverQueue: [{ messageId: "same" }],
        localMessages: [{ messageId: "same" }, { messageId: "same" }],
        serverMessages: [],
      }),
    ).toBe(1);
  });
});
