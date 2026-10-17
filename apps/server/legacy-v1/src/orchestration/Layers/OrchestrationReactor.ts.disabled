import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  OrchestrationReactor,
  type OrchestrationReactorShape,
} from "../Services/OrchestrationReactor.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import * as ThreadSettlementReactor from "../ThreadSettlementReactor.ts";
import * as PullRequestSyncReactor from "../PullRequestSyncReactor.ts";
import * as PullRequestWatchReactor from "../PullRequestWatchReactor.ts";
import * as ThreadPullRequestReactor from "../ThreadPullRequestReactor.ts";
import * as TurnStallWatchdog from "../TurnStallWatchdog.ts";
import * as SidechatExpiryReactor from "../SidechatExpiryReactor.ts";
import * as AgentAwarenessRelay from "../../relay/AgentAwarenessRelay.ts";
import * as StorageCleanup from "../../storageCleanup.ts";
import * as AgentMessaging from "../../agents/AgentMessaging.ts";
import * as UsageResume from "../../agents/UsageResume.ts";
import * as PushNotifications from "../../notifications/PushNotifications.ts";

export const makeOrchestrationReactor = Effect.gen(function* () {
  const providerRuntimeIngestion = yield* ProviderRuntimeIngestionService;
  const providerCommandReactor = yield* ProviderCommandReactor;
  const checkpointReactor = yield* CheckpointReactor;
  const threadDeletionReactor = yield* ThreadDeletionReactor;
  const threadSettlementReactor = yield* ThreadSettlementReactor.ThreadSettlementReactor;
  const pullRequestSyncReactor = yield* PullRequestSyncReactor.PullRequestSyncReactor;
  const threadPullRequestReactor = yield* ThreadPullRequestReactor.ThreadPullRequestReactor;
  const agentAwarenessRelay = yield* AgentAwarenessRelay.AgentAwarenessRelay;
  const storageCleanup = yield* StorageCleanup.StorageCleanup;
  const agentMessaging = yield* Effect.serviceOption(AgentMessaging.AgentMessaging);
  const usageResume = yield* Effect.serviceOption(UsageResume.UsageResume);
  const pushNotifications = yield* Effect.serviceOption(PushNotifications.PushNotifications);
  const pullRequestWatchReactor = yield* Effect.serviceOption(
    PullRequestWatchReactor.PullRequestWatchReactor,
  );
  const turnStallWatchdog = yield* Effect.serviceOption(TurnStallWatchdog.TurnStallWatchdog);
  const sidechatExpiry = yield* Effect.serviceOption(SidechatExpiryReactor.SidechatExpiryReactor);

  const start: OrchestrationReactorShape["start"] = Effect.fn("start")(function* () {
    yield* providerRuntimeIngestion.start();
    yield* providerCommandReactor.start();
    yield* checkpointReactor.start();
    yield* threadDeletionReactor.start();
    yield* threadPullRequestReactor.start();
    yield* threadSettlementReactor.start();
    yield* pullRequestSyncReactor.start();
    yield* agentAwarenessRelay.start();
    yield* storageCleanup.start();
    if (agentMessaging._tag === "Some") yield* agentMessaging.value.start();
    if (usageResume._tag === "Some") yield* usageResume.value.start();
    if (pushNotifications._tag === "Some") yield* pushNotifications.value.start();
    if (pullRequestWatchReactor._tag === "Some") yield* pullRequestWatchReactor.value.start();
    if (turnStallWatchdog._tag === "Some") yield* turnStallWatchdog.value.start();
    if (sidechatExpiry._tag === "Some") yield* sidechatExpiry.value.start();
  });

  return {
    start,
  } satisfies OrchestrationReactorShape;
});

export const OrchestrationReactorLive = Layer.effect(
  OrchestrationReactor,
  makeOrchestrationReactor,
);
