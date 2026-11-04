import {
  EnvironmentId,
  MessageId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { parseAgentMessage } from "@t3tools/shared/agentMessages";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vite-plus/test";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as RockBotConfirmation from "../rockbot/RockBotConfirmation.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

// ViewCode: two chats the user started separately get one bounded exchange (peerExchange.ts).
// These drive upstream's sendToThread and readThread, where that rule is wired in.

const now = DateTime.makeUnsafe("2026-10-26T12:55:41.000Z");
const projectId = ProjectId.make("project-peer");
const instanceId = ProviderInstanceId.make("codex");
const embedded = ThreadId.make("thread-embedded");
const counterfactual = ThreadId.make("thread-counterfactual");
const embeddedChild = ThreadId.make("thread-embedded-child");

const thread = (id: ThreadId, title: string, root: ThreadId = id) => ({
  id,
  projectId,
  title,
  createdBy: "user" as const,
  creationSource: "web" as const,
  modelSelection: { instanceId, model: "gpt-5.4" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: root },
  archivedAt: null,
  deletedAt: null,
  providerInstanceId: instanceId,
  createdAt: now,
  updatedAt: now,
});

const message = (input: {
  readonly id: string;
  readonly threadId: ThreadId;
  readonly from: ThreadId;
  readonly text: string;
  readonly at: number;
}) => ({
  id: MessageId.make(input.id),
  threadId: input.threadId,
  role: "user",
  text: input.text,
  createdBy: "agent",
  creationSource: "mcp",
  senderThreadId: input.from,
  attachments: [],
  createdAt: DateTime.makeUnsafe(input.at),
  updatedAt: DateTime.makeUnsafe(input.at),
});

const projection = (
  id: ThreadId,
  title: string,
  options: { readonly root?: ThreadId; readonly messages?: ReadonlyArray<unknown> } = {},
) =>
  ({
    thread: thread(id, title, options.root),
    runs: [
      {
        id: RunId.make(`run-${id}`),
        ordinal: 1,
        status: "running",
        modelSelection: { instanceId, model: "gpt-5.4" },
        providerInstanceId: instanceId,
        requestedAt: now,
        startedAt: now,
        completedAt: null,
      },
    ],
    visibleTurnItems: [],
    runtimeRequests: [],
    messages: options.messages ?? [],
    contextTransfers: [],
    subagents: [],
    updatedAt: now,
  }) as unknown as OrchestrationV2ThreadProjection;

const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-peer"),
  requestNamespace: "provider-session-embedded",
  thread: {
    threadId: embedded,
    providerSessionId: "provider-session-embedded",
    providerInstanceId: instanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

function harness(input: {
  readonly projections: ReadonlyArray<OrchestrationV2ThreadProjection>;
  readonly answer: boolean;
}) {
  const sent: Array<string> = [];
  const asked: Array<RockBotConfirmation.RockBotConfirmationRequest> = [];
  const byId = new Map(input.projections.map((entry) => [entry.thread.id, entry]));
  const get = (threadId: ThreadId) => {
    const found = byId.get(threadId);
    return found === undefined
      ? Effect.die(`unexpected thread ${threadId}`)
      : Effect.succeed(found);
  };
  const layer = OrchestratorMcpService.layer.pipe(
    Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) => get(threadId),
          getThreadShell: (threadId) =>
            Effect.succeed(
              (byId.get(threadId)?.thread ?? null) as unknown as OrchestrationV2ThreadShell | null,
            ),
          getProjectThreadRecords: (request) => get(request.threadId),
          getTimelinePage: () => Effect.succeed({ items: [], totalItems: 0, hasMore: false }),
          sendToThread: (request) => {
            sent.push(request.text);
            return Effect.succeed({
              run: { id: "run-sent", status: "queued" },
              delivery: "started",
            } as unknown as ThreadManagementService.ThreadManagementSendResult);
          },
        } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        NodeCrypto.layer,
      ),
    ),
  );
  const run = <A, E>(
    body: (
      service: OrchestratorMcpService.OrchestratorMcpService["Service"],
    ) => Effect.Effect<A, E>,
  ) =>
    Effect.gen(function* () {
      return yield* body(yield* OrchestratorMcpService.OrchestratorMcpService);
    }).pipe(
      Effect.provideService(RockBotConfirmation.RockBotConfirmation, {
        confirm: (request) =>
          Effect.sync(() => {
            asked.push(request);
            return input.answer;
          }),
      }),
      Effect.provide(layer),
      Effect.runPromise,
    );
  return { sent, asked, run };
}

describe("messages between chats the user started separately", () => {
  it("asks the user, then delivers the message as a peer's, not the user's", async () => {
    const { sent, asked, run } = harness({
      projections: [
        projection(embedded, "embedded"),
        projection(counterfactual, "counterfactual-ltr-exposure-bias"),
      ],
      answer: true,
    });
    await run((service) =>
      service.sendToThread(scope, { threadId: counterfactual, message: "I need your artifact." }),
    );
    expect(asked).toMatchObject([
      { threadId: embedded, peer: true, title: "Message counterfactual-ltr-exposure-bias" },
    ]);
    const envelope = parseAgentMessage(sent[0] ?? "");
    expect(envelope).toMatchObject({
      fromThreadId: embedded,
      fromName: "embedded",
      inReplyTo: null,
      body: "I need your artifact.",
    });
    expect(sent[0]).toContain("not from your user");
  });

  it("sends nothing when the user says no", async () => {
    const { sent, run } = harness({
      projections: [projection(embedded, "embedded"), projection(counterfactual, "other")],
      answer: false,
    });
    const error = await run((service) =>
      service
        .sendToThread(scope, { threadId: counterfactual, message: "Yield Docker?" })
        .pipe(Effect.flip),
    );
    expect(error.code).toBe("user_declined");
    expect(sent).toEqual([]);
  });

  it("answers an approved request once without asking again", async () => {
    const request = message({
      id: "request-1",
      threadId: embedded,
      from: counterfactual,
      text: "Can I use Docker for ten minutes?",
      at: 1,
    });
    const { sent, asked, run } = harness({
      projections: [
        projection(embedded, "embedded", { messages: [request] }),
        projection(counterfactual, "other"),
      ],
      answer: false,
    });
    await run((service) =>
      service.sendToThread(scope, { threadId: counterfactual, message: "Yes, it is free." }),
    );
    expect(asked).toEqual([]);
    expect(parseAgentMessage(sent[0] ?? "")?.inReplyTo).toBe("request-1");
    expect(sent[0]).toContain("The exchange is complete");
  });

  it("refuses an unchanged resend without bothering the user", async () => {
    const earlier = message({
      id: "earlier",
      threadId: counterfactual,
      from: embedded,
      text: "Can you yield Docker?",
      at: 1,
    });
    const { sent, asked, run } = harness({
      projections: [
        projection(embedded, "embedded"),
        projection(counterfactual, "other", { messages: [earlier] }),
      ],
      answer: true,
    });
    const error = await run((service) =>
      service
        .sendToThread(scope, { threadId: counterfactual, message: "Can you yield Docker?" })
        .pipe(Effect.flip),
    );
    expect(error.code).toBe("send_loop_guard");
    expect(asked).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("leaves a chat's own subagents and its parent alone", async () => {
    const { sent, asked, run } = harness({
      projections: [
        projection(embedded, "embedded"),
        projection(embeddedChild, "child", { root: embedded }),
      ],
      answer: false,
    });
    await run((service) =>
      service.sendToThread(scope, { threadId: embeddedChild, message: "Carry on." }),
    );
    expect(asked).toEqual([]);
    expect(sent).toEqual(["Carry on."]);
  });

  it("asks once per turn before reading a separate chat's conversation", async () => {
    const { asked, run } = harness({
      projections: [projection(embedded, "embedded"), projection(counterfactual, "other")],
      answer: true,
    });
    await run((service) =>
      Effect.gen(function* () {
        yield* service.readThread(scope, { threadId: counterfactual });
        yield* service.readThread(scope, { threadId: counterfactual, afterPosition: 10 });
      }),
    );
    expect(asked).toMatchObject([{ title: "Read other", acceptLabel: "Allow" }]);
  });
});
