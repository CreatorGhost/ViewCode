import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";
import { forkThreadTitle, sliceForkMessages, THREAD_FORKED_ACTIVITY_KIND } from "./ThreadFork.ts";

const at = "2026-08-24T10:00:00.000Z";
const message = (id: string, role: "user" | "assistant" | "system", text: string) => ({
  id: MessageId.make(id),
  role,
  text,
  createdAt: at,
});

it("slices up to and including the chosen message, skipping empty and system ones", () => {
  const messages = [
    message("m1", "user", "hi"),
    message("m2", "system", "note"),
    message("m3", "assistant", "  "),
    message("m4", "assistant", "hello"),
    message("m5", "user", "later"),
  ];
  const carried = sliceForkMessages(messages, "m4", "fork-1");
  expect(carried?.map((m) => m.messageId)).toEqual(["fork:fork-1:m1", "fork:fork-1:m4"]);
  expect(sliceForkMessages(messages, "missing", "fork-1")).toBeNull();
});

it("titles forks without stacking prefixes", () => {
  expect(forkThreadTitle("Fix bug")).toBe("Fork of Fix bug");
  expect(forkThreadTitle("Fork of Fork of Fix bug")).toBe("Fork of Fix bug");
  expect(forkThreadTitle("  ")).toBe("Fork of thread");
});

it.layer(NodeServices.layer)("thread.create with forkFrom", (it) => {
  it.effect("emits the thread, the copied history and the forked-from marker", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-1");
      const readModel = yield* projectEvent(createEmptyReadModel(at), {
        sequence: 1,
        eventId: EventId.make("event-project-created"),
        aggregateKind: "project",
        aggregateId: projectId,
        type: "project.created",
        occurredAt: at,
        commandId: CommandId.make("command-project-created"),
        causationEventId: null,
        correlationId: CommandId.make("command-project-created"),
        metadata: {},
        payload: {
          projectId,
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: at,
          updatedAt: at,
        },
      });
      const events = yield* decideOrchestrationCommand({
        command: {
          type: "thread.create",
          commandId: CommandId.make("command-fork"),
          threadId: ThreadId.make("fork-1"),
          projectId,
          title: "Fork of Source",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: at,
          forkFrom: {
            threadId: ThreadId.make("source"),
            messageId: MessageId.make("m1"),
            sourceTitle: "Source",
            messages: [
              {
                messageId: MessageId.make("fork:fork-1:m1"),
                role: "user",
                text: "hi",
                createdAt: at,
              },
            ],
          },
        },
        readModel,
      });
      const list = Array.isArray(events) ? events : [events];
      expect(list.map((event) => event.type)).toEqual([
        "thread.created",
        "thread.message-sent",
        "thread.activity-appended",
      ]);
      expect(list[2]).toMatchObject({
        payload: { activity: { kind: THREAD_FORKED_ACTIVITY_KIND, summary: "Forked from Source" } },
      });
      // Strictly before the first copied message: clients sort messages first on a tie.
      const divider = list[2] as Extract<
        (typeof list)[number],
        { readonly type: "thread.activity-appended" }
      >;
      expect(Date.parse(divider.payload.activity.createdAt)).toBe(Date.parse(at) - 1);
    }),
  );
});
