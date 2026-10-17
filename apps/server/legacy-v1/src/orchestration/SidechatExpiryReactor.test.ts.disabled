import type { OrchestrationCommand, OrchestrationThreadShell } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { TerminalManager } from "../terminal/Manager.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { make } from "./SidechatExpiryReactor.ts";

const shell = (id: string, overrides: Record<string, unknown> = {}) =>
  ({
    id,
    parentThreadId: null,
    archivedAt: null,
    // The test clock starts at the epoch; a day later is far enough past this.
    updatedAt: "1969-12-30T00:00:00.000Z",
    latestUserMessageAt: null,
    latestTurn: null,
    session: null,
    ...overrides,
  }) as unknown as OrchestrationThreadShell;

describe("SidechatExpiryReactor", () => {
  it.effect(
    "archives an expired side chat like a client would: stops it and closes terminals",
    () =>
      Effect.gen(function* () {
        const dispatched: OrchestrationCommand[] = [];
        const closed: string[] = [];
        const threads = [
          shell("main", { updatedAt: "1970-01-01T00:00:00.000Z" }),
          shell("side", {
            parentThreadId: "main",
            kind: "sidechat",
            session: { threadId: "side", status: "ready", activeTurnId: null },
          }),
        ];
        const snapshot = (list: ReadonlyArray<OrchestrationThreadShell>) =>
          Effect.succeed({ snapshotSequence: 1, projects: [], threads: list, updatedAt: "" });
        const dependencies = Layer.mergeAll(
          Layer.mock(ProjectionSnapshotQuery)({
            getShellSnapshot: () => snapshot(threads),
            getArchivedShellSnapshot: () => snapshot([]),
          }),
          Layer.mock(OrchestrationEngineService)({
            dispatch: (command) => {
              dispatched.push(command);
              return Effect.succeed({ sequence: dispatched.length });
            },
          }),
          Layer.mock(TerminalManager)({
            close: (input) => {
              closed.push(input.threadId);
              return Effect.void;
            },
          }),
        );
        const reactor = yield* make.pipe(
          Effect.provide(Layer.merge(dependencies, NodeServices.layer)),
        );
        yield* reactor.sweep;

        assert.deepEqual(
          dispatched.map((command) => [
            command.type,
            "threadId" in command ? command.threadId : "",
          ]),
          [
            ["thread.archive", "side"],
            ["thread.session.stop", "side"],
          ],
        );
        assert.deepEqual(closed, ["side"]);
      }),
  );
});
