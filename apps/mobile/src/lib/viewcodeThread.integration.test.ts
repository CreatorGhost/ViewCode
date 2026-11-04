import { describe, expect, it } from "vite-plus/test";
import { RunId, TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import { viewCodeThread } from "@t3tools/client-runtime/viewcodeThread";
import {
  v2Now,
  v2Projection,
} from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import { buildThreadFeed } from "./threadActivity";

const base = {
  threadId: v2Projection.thread.id,
  runId: RunId.make("run:mobile-v2"),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "completed",
  title: null,
  startedAt: v2Now,
  completedAt: v2Now,
  updatedAt: v2Now,
} as const;

describe("ViewCode mobile v2 feed", () => {
  it("renders native commands and file changes through the unchanged ViewCode worklog", () => {
    const items: OrchestrationV2TurnItem[] = [
      {
        ...base,
        id: TurnItemId.make("mobile-command"),
        type: "command_execution",
        input: "git status",
        output: "working tree clean",
        exitCode: 0,
      },
      {
        ...base,
        id: TurnItemId.make("mobile-file"),
        type: "file_change",
        fileName: "src/kept-screen.tsx",
        additions: 3,
        deletions: 1,
      },
    ];
    const thread = viewCodeThread({
      ...v2Projection,
      turnItems: items,
      visibleTurnItems: items.map((item, position) => ({
        item,
        position,
        visibility: "local",
        sourceThreadId: item.threadId,
        sourceItemId: item.id,
      })),
    });
    const activities = buildThreadFeed(thread).flatMap((entry) =>
      entry.type === "activity-group" ? entry.activities : [],
    );
    expect(activities.some((entry) => entry.workEntry.command === "git status")).toBe(true);
    expect(
      activities.some((entry) => entry.workEntry.changedFiles?.includes("src/kept-screen.tsx")),
    ).toBe(true);
  });
});
