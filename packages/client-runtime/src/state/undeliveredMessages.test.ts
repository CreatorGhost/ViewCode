import {
  MessageId,
  NodeId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  TurnItemId,
  type OrchestrationV2RunStatus,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { undeliveredRunMessages } from "../viewcodeThreadAtoms.ts";
import { v2Now, v2Projection } from "./orchestrationV2TestFixtures.ts";

const run = (id: string, ordinal: number, status: OrchestrationV2RunStatus, message = id) => ({
  id: RunId.make(id),
  threadId: v2Projection.thread.id,
  ordinal,
  providerInstanceId: v2Projection.thread.providerInstanceId,
  modelSelection: v2Projection.thread.modelSelection,
  providerThreadId: null,
  userMessageId: MessageId.make(`message-${message}`),
  rootNodeId: NodeId.make(`root-${id}`),
  activeAttemptId: RunAttemptId.make(`attempt-${id}`),
  status,
  requestedAt: v2Now,
  startedAt: v2Now,
  completedAt: v2Now,
  checkpointId: null,
  contextHandoffId: null,
});

const attempt = (runId: string) => ({
  id: RunAttemptId.make(`attempt-${runId}`),
  runId: RunId.make(runId),
  attemptOrdinal: 1,
  rootNodeId: NodeId.make(`root-${runId}`),
  providerInstanceId: v2Projection.thread.providerInstanceId,
  providerThreadId: ProviderThreadId.make("provider-thread"),
  providerTurnId: null,
  reason: "initial" as const,
  status: "failed" as const,
  startedAt: v2Now,
  completedAt: v2Now,
});

const providerTurn = (runId: string) => ({
  id: ProviderTurnId.make(`provider-turn-${runId}`),
  providerThreadId: ProviderThreadId.make("provider-thread"),
  nodeId: NodeId.make(`root-${runId}`),
  runAttemptId: RunAttemptId.make(`attempt-${runId}`),
  nativeTurnRef: null,
  ordinal: 1,
  status: "failed" as const,
  startedAt: v2Now,
  completedAt: v2Now,
});

const failure = (runId: string, message: string) => ({
  id: TurnItemId.make(`error-${runId}`),
  threadId: v2Projection.thread.id,
  runId: RunId.make(runId),
  nodeId: NodeId.make(`root-${runId}`),
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 2,
  type: "error" as const,
  status: "failed" as const,
  title: null,
  startedAt: v2Now,
  completedAt: v2Now,
  updatedAt: v2Now,
  failure: { class: "provider_error" as const, message, code: null, retryable: null },
});

describe("undeliveredRunMessages", () => {
  it("marks a failed run's message only when its provider never started a turn", () => {
    const projection = {
      ...v2Projection,
      runs: [run("refused", 1, "failed"), run("broke", 2, "failed"), run("done", 3, "completed")],
      attempts: [attempt("refused"), attempt("broke"), attempt("done")],
      providerTurns: [providerTurn("broke"), providerTurn("done")],
      turnItems: [failure("refused", "Cursor refused the request."), failure("broke", "Crashed")],
    };
    expect(undeliveredRunMessages(projection)).toEqual(
      new Map([["message-refused", "Cursor refused the request."]]),
    );
  });

  it("clears a message once a later run for it got through", () => {
    const projection = {
      ...v2Projection,
      runs: [run("first", 1, "failed", "same"), run("retry", 2, "completed", "same")],
      attempts: [attempt("first"), attempt("retry")],
      providerTurns: [providerTurn("retry")],
    };
    expect(undeliveredRunMessages(projection).size).toBe(0);
  });

  it("falls back to a generic reason and shares one empty map", () => {
    const projection = {
      ...v2Projection,
      runs: [run("refused", 1, "failed")],
      attempts: [attempt("refused")],
    };
    expect(undeliveredRunMessages(projection).get("message-refused")).toBe(
      "The provider never started a turn for this message.",
    );
    expect(undeliveredRunMessages(v2Projection)).toBe(undeliveredRunMessages(v2Projection));
  });
});
