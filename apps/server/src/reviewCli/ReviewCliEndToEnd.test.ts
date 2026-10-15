// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - runs the real CLI as a child process against a real HTTP listener.
/**
 * End to end: the actual `viewcode-review` CLI (a child process, started the
 * way the shim starts it, findings piped to stdin) talks over a real unix
 * socket or TCP port to the real route, the real `McpSessionRegistry`
 * credential check and the real `submit_review_findings` handler. Only the
 * orchestration engine and read model behind it are fake.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServer } from "effect/unstable/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as PullRequestAgentReview from "../pullRequest/PullRequestAgentReview.ts";
import { reviewCliRouteLayer } from "./ReviewCliRoute.ts";

const CLI_ENTRY = NodePath.join(import.meta.dirname, "..", "viewcode-review.ts");
const TEST_TIMEOUT = 60_000;
const threadId = ThreadId.make("thread-review-e2e");
const providerInstanceId = ProviderInstanceId.make("cursor");

const thread = {
  id: threadId,
  projectId: ProjectId.make("project"),
  pullRequests: [],
  session: null,
} as unknown as OrchestrationThreadShell;

const report = {
  verdict: "approve-with-nits",
  mergeConfidence: 4,
  reviewEffort: 2,
  target: "local",
  findings: [
    {
      severity: "nit",
      confidence: 85,
      path: "src/a.ts",
      line: 3,
      title: "Unused import",
      detail: "Nothing reads the import, so it only slows the module down.",
    },
  ],
  needsChecking: [],
};

const makeStack = (listen: "unix" | "tcp") =>
  Effect.gen(function* () {
    const commands: Array<OrchestrationCommand> = [];
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-review-e2e-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
    );
    const listener =
      listen === "unix"
        ? NodeHttpServer.layer(() => NodeHttp.createServer(), {
            path: NodePath.join(directory, "server.sock"),
          })
        : NodeHttpServer.layer(() => NodeHttp.createServer(), { port: 0, host: "127.0.0.1" });
    const httpServer = Context.get(yield* Layer.build(listener), HttpServer.HttpServer);
    const registry = yield* McpSessionRegistry.__testing.make().pipe(
      Effect.provideService(HttpServer.HttpServer, httpServer),
      Effect.provideService(ServerEnvironment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("environment")),
        getDescriptor: Effect.die("unused"),
      }),
      Effect.provide(NodeServices.layer),
    );
    yield* HttpRouter.serve(
      reviewCliRouteLayer.pipe(
        Layer.provide(Layer.succeed(McpSessionRegistry.McpSessionRegistry, registry)),
        Layer.provide(
          Layer.mock(ProjectionSnapshotQuery)({
            getThreadShellById: (id) =>
              Effect.succeed(id === threadId ? Option.some(thread) : Option.none()),
            getThreadDetailById: () => Effect.succeedNone,
          }),
        ),
        Layer.provide(
          Layer.mock(OrchestrationEngineService)({
            readEvents: () => Stream.empty,
            dispatch: (command) =>
              Effect.sync(() => {
                commands.push(command);
                return { sequence: 1 };
              }),
            streamDomainEvents: Stream.empty,
            latestSequence: Effect.succeed(0),
          }),
        ),
        Layer.provide(Layer.mock(PullRequestAgentReview.PullRequestAgentReview)({})),
        Layer.provide(NodeServices.layer),
      ),
      { disableListenLog: true, disableLogger: true },
    ).pipe(Layer.provide(Layer.succeed(HttpServer.HttpServer, httpServer)), Layer.build);

    const config = (yield* registry.issue({
      threadId,
      providerInstanceId,
      capabilities: new Set(["agents"]),
    })).config;
    return { commands, config };
  });

const startCli = (
  config: { readonly reviewEndpoint?: string; readonly authorizationHeader: string },
  stdin: string,
) =>
  Effect.promise<{ code: number | null; json: any }>(
    () =>
      new Promise((resolve, reject) => {
        const child = NodeChildProcess.spawn(process.execPath, [CLI_ENTRY, "submit"], {
          env: {
            PATH: process.env.PATH ?? "",
            VIEWCODE_REVIEW_ENDPOINT: config.reviewEndpoint ?? "",
            VIEWCODE_REVIEW_AUTH: config.authorizationHeader,
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
        child.on("error", reject);
        child.on("close", (code) => {
          try {
            resolve({ code, json: JSON.parse(stdout) });
          } catch {
            reject(new Error(`CLI printed no JSON (exit ${code}): ${stdout}${stderr}`));
          }
        });
        child.stdin.end(stdin);
      }),
  );

describe("viewcode-review end to end", () => {
  for (const listen of ["unix", "tcp"] as const) {
    it.effect(
      `records piped findings on the credential's thread over ${listen}`,
      () =>
        Effect.gen(function* () {
          const stack = yield* makeStack(listen);
          expect(
            stack.config.reviewEndpoint?.startsWith(listen === "unix" ? "unix:" : "http://"),
          ).toBe(true);

          const result = yield* startCli(stack.config, JSON.stringify(report));
          expect(result).toMatchObject({
            code: 0,
            json: { ok: true, result: { target: "local", findings: 1, needsChecking: 0 } },
          });
          expect(stack.commands).toMatchObject([
            {
              type: "thread.activity.append",
              threadId,
              activity: {
                kind: "viewcode.review.findings",
                payload: { target: { kind: "local" }, mode: "fix", complete: true },
              },
            },
          ]);
        }).pipe(Effect.scoped),
      TEST_TIMEOUT,
    );
  }

  it.effect(
    "tells the reviewer what to fix in invalid findings, and refuses a forged credential",
    () =>
      Effect.gen(function* () {
        const stack = yield* makeStack("tcp");
        const invalid = yield* startCli(
          stack.config,
          JSON.stringify({ ...report, findings: [{ ...report.findings[0], severity: "minor" }] }),
        );
        expect(invalid).toMatchObject({
          code: 1,
          json: {
            ok: false,
            error: { code: "usage", message: expect.stringContaining("severity") },
          },
        });

        const forged = yield* startCli(
          { ...stack.config, authorizationHeader: "Bearer forged" },
          JSON.stringify(report),
        );
        expect(forged).toMatchObject({ code: 1, json: { error: { code: "credential" } } });
        expect(stack.commands).toEqual([]);
      }).pipe(Effect.scoped),
    TEST_TIMEOUT,
  );
});
