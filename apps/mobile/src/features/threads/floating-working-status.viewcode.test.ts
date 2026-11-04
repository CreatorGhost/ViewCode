import { describe, expect, it } from "vite-plus/test";

import { THREAD_TOO_LARGE_FOR_CONNECTION_MESSAGE } from "@t3tools/client-runtime/state/threads";

import { threadSyncNoticeStatus } from "./floating-working-status";

// ViewCode: a chat whose snapshot Quick connect's relay refused is explained, not left syncing.
describe("threadSyncNoticeStatus", () => {
  it("explains a chat held back for being too large instead of syncing forever", () => {
    expect(
      threadSyncNoticeStatus({
        threadSyncError: THREAD_TOO_LARGE_FOR_CONNECTION_MESSAGE,
        onPress: () => {},
      }),
    ).toMatchObject({
      kind: "notice",
      label: "Too large for Quick connect",
      detail: THREAD_TOO_LARGE_FOR_CONNECTION_MESSAGE,
    });
    expect(
      threadSyncNoticeStatus({ threadSyncError: "Thread not found.", onPress: () => {} }),
    ).toBeNull();
    expect(threadSyncNoticeStatus({ threadSyncError: null, onPress: () => {} })).toBeNull();
  });
});
