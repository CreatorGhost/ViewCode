import { CommandId, EventId, ProjectId, type OrchestrationEvent } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-1");

function makeEvent(input: {
  readonly sequence: number;
  readonly type: OrchestrationEvent["type"];
  readonly payload: unknown;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.make(`event-${input.sequence}`),
    type: input.type,
    aggregateKind: "project",
    aggregateId: projectId,
    occurredAt: now,
    commandId: CommandId.make(`command-${input.sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

it.effect("projects a project colour, keeps it across older meta events and clears it", () =>
  Effect.gen(function* () {
    const created = yield* projectEvent(
      createEmptyReadModel(now),
      makeEvent({
        sequence: 1,
        type: "project.created",
        payload: {
          projectId,
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    expect(created.projects[0]?.projectColor).toBeNull();

    const coloured = yield* projectEvent(
      created,
      makeEvent({
        sequence: 2,
        type: "project.meta-updated",
        payload: { projectId, projectColor: "blue", updatedAt: now },
      }),
    );
    expect(coloured.projects[0]?.projectColor).toBe("blue");

    // Events persisted before colours existed carry no field and leave it alone.
    const renamed = yield* projectEvent(
      coloured,
      makeEvent({
        sequence: 3,
        type: "project.meta-updated",
        payload: { projectId, title: "Renamed", updatedAt: now },
      }),
    );
    expect(renamed.projects[0]?.projectColor).toBe("blue");

    const cleared = yield* projectEvent(
      renamed,
      makeEvent({
        sequence: 4,
        type: "project.meta-updated",
        payload: { projectId, projectColor: null, updatedAt: now },
      }),
    );
    expect(cleared.projects[0]?.projectColor).toBeNull();
  }),
);
