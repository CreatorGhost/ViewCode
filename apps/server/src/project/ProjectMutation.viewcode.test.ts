import { assert, it } from "@effect/vitest";
import { CommandId, ProjectId, type Project } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { projectMutationOperation } from "./ProjectMutation.ts";
import { type ProjectService } from "./ProjectService.ts";

const projectId = ProjectId.make("project:colour-mapping");
const project = {
  id: projectId,
  title: "Coloured",
  workspaceRoot: "/work/coloured",
  repositoryIdentity: null,
  faviconPath: null,
  projectIcon: null,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  scripts: [],
  createdAt: "2026-10-22T00:00:00.000Z",
  updatedAt: "2026-10-22T00:00:00.000Z",
  deletedAt: null,
} satisfies Project;

// ViewCode's project colour (the Project color dialog, the rail menu, the shell tint) rides the
// upstream project mutation. The mapping dropped it once: the server answered success with the
// colour unchanged, and nothing on screen moved.
it.effect("carries the project colour through create and update, including clearing it", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<unknown>>([]);
    const record = (input: unknown) =>
      Ref.update(calls, (entries) => [...entries, input]).pipe(Effect.as(project));
    const projects: Pick<ProjectService["Service"], "create" | "delete" | "update"> = {
      create: record,
      update: record,
      delete: record,
    };

    yield* projectMutationOperation(projects, {
      type: "project.create",
      commandId: CommandId.make("command:create"),
      projectId,
      title: "Created",
      workspaceRoot: "/work/created",
      projectColor: "violet",
    });
    yield* projectMutationOperation(projects, {
      type: "project.update",
      commandId: CommandId.make("command:update"),
      projectId,
      projectColor: "red",
    });
    yield* projectMutationOperation(projects, {
      type: "project.update",
      commandId: CommandId.make("command:clear"),
      projectId,
      projectColor: null,
    });
    yield* projectMutationOperation(projects, {
      type: "project.update",
      commandId: CommandId.make("command:untouched"),
      projectId,
      title: "Renamed",
    });

    assert.deepEqual(yield* Ref.get(calls), [
      {
        commandId: "command:create",
        projectId,
        title: "Created",
        workspaceRoot: "/work/created",
        projectColor: "violet",
      },
      { commandId: "command:update", projectId, projectColor: "red" },
      { commandId: "command:clear", projectId, projectColor: null },
      { commandId: "command:untouched", projectId, title: "Renamed" },
    ]);
  }),
);
