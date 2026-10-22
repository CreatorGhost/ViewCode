import * as Schema from "effect/Schema";
import { GitPreparePullRequestThreadInput } from "./git.ts";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  AuthAccessWriteScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  type AuthEnvironmentScope,
} from "./auth.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS } from "./rpc.ts";

/** Incremental client enforcement; the server still authorizes every request. */
export const CLIENT_GUARDED_RPC_SCOPES = {
  [WS_METHODS.serverRunStorageCleanup]: AuthSettingsWriteScope,
  [WS_METHODS.serverCheckOtlpEndpoint]: AuthSettingsWriteScope,
  [WS_METHODS.pullRequestsRunAction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdate]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdateComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSubmitReview]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsReplyToThread]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetThreadResolution]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetReaction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetFilesViewed]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsRequestReviewers]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetLabels]: AuthSourceControlWriteScope,
  // Writing a guide runs a model on this environment's providers, which reading one does not.
  [WS_METHODS.pullRequestsGenerateReviewGuide]: AuthOrchestrationOperateScope,
  [WS_METHODS.sourceControlCloneRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlPublishRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneStart]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneCancel]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneRetry]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPull]: AuthSourceControlWriteScope,
  [WS_METHODS.gitRunStackedAction]: AuthSourceControlWriteScope,
  [WS_METHODS.gitPreparePullRequestThread]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsRemoveWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsSwitchRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsInit]: AuthSourceControlWriteScope,

  [WS_METHODS.scheduledTasksUpsert]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksSetEnabled]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRunNow]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRotateWebhookToken]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: AuthOrchestrationOperateScope,

  [WS_METHODS.providerAccountAdd]: AuthSettingsWriteScope,
  [WS_METHODS.providerAccountPrepareSignIn]: AuthProvidersManageScope,
  [WS_METHODS.pullRequestsStartReview]: AuthOrchestrationOperateScope,
  [WS_METHODS.agentsStop]: AuthOrchestrationOperateScope,
  [WS_METHODS.agentsResume]: AuthOrchestrationOperateScope,
  [WS_METHODS.agentsDiscard]: AuthOrchestrationOperateScope,
  [WS_METHODS.usageResumeCancel]: AuthOrchestrationOperateScope,
  [WS_METHODS.usageResumeNow]: AuthOrchestrationOperateScope,
  [WS_METHODS.rockbotOpen]: AuthOrchestrationOperateScope,
  [WS_METHODS.voiceModelsDownload]: AuthOrchestrationOperateScope,
  [WS_METHODS.voiceModelsCancel]: AuthOrchestrationOperateScope,
  [WS_METHODS.voiceModelsRemove]: AuthOrchestrationOperateScope,
  [WS_METHODS.viewcodeRelaySetupStart]: AuthAccessWriteScope,
  [WS_METHODS.viewcodeRelaySetupCancel]: AuthAccessWriteScope,
  [WS_METHODS.viewcodeRelaySetupContinue]: AuthAccessWriteScope,
  [WS_METHODS.viewcodeRelaySetupChooseAccount]: AuthAccessWriteScope,
  [WS_METHODS.viewcodeRelayRemove]: AuthAccessWriteScope,
  [WS_METHODS.reviewStartFixThread]: AuthOrchestrationOperateScope,
  [WS_METHODS.reviewStartLocal]: AuthOrchestrationOperateScope,
  [WS_METHODS.reviewPostFindings]: AuthOrchestrationOperateScope,
  [WS_METHODS.reviewRateFinding]: AuthOrchestrationOperateScope,
  [WS_METHODS.reviewUndoFixes]: AuthOrchestrationOperateScope,
  [WS_METHODS.reviewLearnStyle]: AuthOrchestrationOperateScope,
  [WS_METHODS.reviewForgetLearnedStyle]: AuthOrchestrationOperateScope,
  // Registration belongs to the authenticated phone session; preserve the server's read grant.
  [WS_METHODS.pushRegister]: AuthOrchestrationReadScope,
  [WS_METHODS.pushUnregister]: AuthOrchestrationReadScope,
} as const;
export type ClientGuardedRpcTag = keyof typeof CLIENT_GUARDED_RPC_SCOPES;

const decodePrepareThread = Schema.decodeUnknownSync(GitPreparePullRequestThreadInput);

export function clientRpcRequiredScopes(
  method: string,
  input: unknown,
): readonly AuthEnvironmentScope[] {
  if (method === WS_METHODS.gitPreparePullRequestThread && input !== undefined) {
    const payload = decodePrepareThread(input);
    if (payload.mode === "worktree" && payload.threadId !== undefined)
      return [AuthSourceControlWriteScope, AuthOrchestrationOperateScope];
  }
  return Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method)
    ? [CLIENT_GUARDED_RPC_SCOPES[method as ClientGuardedRpcTag]]
    : [];
}
