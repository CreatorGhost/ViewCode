import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { ThreadId, type OrchestrationV2ServerCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as TestClock from "effect/testing/TestClock";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import { OrchestratorDispatchError } from "./Orchestrator.ts";
import * as Expiry from "./ViewCodeSidechatExpiry.ts";
import { findExpiredSidechats, SIDECHAT_IDLE_EXPIRY_MS } from "./viewcodeSidechatExpiryPolicy.ts";

const now = Date.parse("2026-10-18T12:00:00Z");
const expired = {
  ...liveThreadShell(ThreadId.make("sidechat:expired")),
  kind: "sidechat" as const,
  status: "idle" as const,
  activeRunId: null,
  updatedAt: DateTime.makeUnsafe(now - SIDECHAT_IDLE_EXPIRY_MS),
  latestUserMessageAt: null,
};
it("expires only idle side chats after a full day, preserving main, active, requested and archived threads", () => {
  const candidates = [
    expired,
    {
      ...expired,
      id: ThreadId.make("recent"),
      updatedAt: DateTime.makeUnsafe(now - SIDECHAT_IDLE_EXPIRY_MS + 1),
    },
    { ...expired, id: ThreadId.make("main"), kind: null },
    { ...expired, id: ThreadId.make("running"), status: "running" as const },
    { ...expired, id: ThreadId.make("queued"), status: "queued" as const },
    { ...expired, id: ThreadId.make("archived"), archivedAt: DateTime.makeUnsafe(now) },
    {
      ...expired,
      id: ThreadId.make("recent-user"),
      latestUserMessageAt: DateTime.makeUnsafe(now - 1),
    },
  ];
  expect(findExpiredSidechats(candidates, now).map((thread) => thread.id)).toEqual([expired.id]);
});

it.effect(
  "rechecks stale sweep candidates and closes terminals only after the native archive succeeds",
  () => {
    const changed = { ...expired, id: ThreadId.make("sidechat:changed") };
    const refused = { ...expired, id: ThreadId.make("sidechat:refused") };
    const commands: Extract<OrchestrationV2ServerCommand, { type: "thread.archive" }>[] = [];
    const closed: string[] = [];
    const layer = Expiry.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getShellSnapshot: () =>
              Effect.succeed({
                threads: [expired, changed, refused],
                archivedThreads: [],
                schemaVersion: 2,
                snapshotSequence: 0,
              }),
            getThreadShell: (id) =>
              Effect.succeed(
                id === changed.id
                  ? { ...changed, status: "running", activeRunId: null }
                  : id === refused.id
                    ? refused
                    : expired,
              ),
            dispatch: (command) => {
              if (command.type !== "thread.archive") return Effect.die("Unexpected expiry command");
              return Effect.sync(() => void commands.push(command)).pipe(
                Effect.andThen(
                  command.threadId === refused.id
                    ? Effect.fail(
                        new OrchestratorDispatchError({
                          commandId: command.commandId,
                          commandType: command.type,
                          cause: "A new run won the command lock",
                        }),
                      )
                    : Effect.succeed({ sequence: 1, storedEvents: [] }),
                ),
              );
            },
          }),
          Layer.mock(TerminalManager.TerminalManager)({
            close: ({ threadId }) => Effect.sync(() => void closed.push(threadId)),
          }),
          NodeCrypto.layer,
        ),
      ),
    );
    return Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const expiry = yield* Expiry.ViewCodeSidechatExpiry;
      yield* expiry.sweep;
      expect(commands.map((command) => command.threadId)).toEqual([expired.id, refused.id]);
      expect(commands[0]).toMatchObject({
        type: "thread.archive",
        expectedUpdatedAt: expired.updatedAt,
      });
      expect(closed).toEqual([expired.id]);
    }).pipe(Effect.provide(layer));
  },
);
