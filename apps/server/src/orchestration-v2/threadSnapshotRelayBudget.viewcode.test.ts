import {
  OrchestrationV2RpcSchemas,
  type OrchestrationV2ThreadStreamItem,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { makeGoalThreadProjection } from "./goalThreadFixture.test-support.ts";
import { buildBoundedThreadStreamSnapshot } from "./ThreadStream.ts";
import { selectHistoryPageFromCursor } from "./threadHistoryPaging.ts";
import { projectThreadProjectionForWire } from "./WireProjection.ts";

/** Cloudflare's per-message cap that Quick connect's relay enforces (`relayForwarder.ts`). */
const RELAY_MAX_WS_MESSAGE_BYTES = 1024 * 1024 - 64;

const encodeThreadStreamItem = Schema.encodeSync(
  Schema.toCodecJson(OrchestrationV2RpcSchemas.subscribeThread.output),
);

function rpcChunkBytes(value: OrchestrationV2ThreadStreamItem): number {
  return Buffer.byteLength(
    JSON.stringify({ _tag: "Chunk", requestId: "1", values: [encodeThreadStreamItem(value)] }),
  );
}

describe("thread snapshot over Quick connect", () => {
  it("fits one relay message for a goal thread that ran for hours in one user turn", () => {
    // About eight hours of watchdog wakes; the unbounded turn window was 2.8 MB.
    const projection = makeGoalThreadProjection({ wakeRuns: 120 });
    const snapshot = buildBoundedThreadStreamSnapshot({
      projection,
      snapshotSequence: 1,
      compactTurnItems: true,
    });

    expect(rpcChunkBytes(snapshot)).toBeLessThan(RELAY_MAX_WS_MESSAGE_BYTES);
    expect(snapshot.payloadBudgetExceeded).toBe(false);
    expect(snapshot.hasMoreHistory).toBe(true);
    const visible = snapshot.projection.visibleTurnItems;
    expect(visible.length).toBeGreaterThan(50);
    expect(visible.at(-1)?.sourceItemId).toBe(projection.visibleTurnItems.at(-1)?.sourceItemId);

    // Load earlier continues exactly where the window starts.
    const page = selectHistoryPageFromCursor({
      items: projectThreadProjectionForWire(projection).visibleTurnItems,
      cursor: snapshot.historyCursor!,
      snapshotSequence: 1,
    });
    const windowStart = projection.visibleTurnItems.findIndex(
      (row) => row.sourceItemId === visible[0]?.sourceItemId,
    );
    expect(page.items.at(-1)?.sourceItemId).toBe(
      projection.visibleTurnItems[windowStart - 1]?.sourceItemId,
    );
  });

  it("keeps a short goal thread whole", () => {
    const projection = makeGoalThreadProjection({ wakeRuns: 10 });
    const snapshot = buildBoundedThreadStreamSnapshot({
      projection,
      snapshotSequence: 1,
      compactTurnItems: true,
    });

    expect(snapshot.hasMoreHistory).toBe(false);
    expect(snapshot.projection.visibleTurnItems).toHaveLength(projection.visibleTurnItems.length);
  });
});
