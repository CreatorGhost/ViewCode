import {
  type AgentReviewChoices,
  type AgentReviewRequest,
  buildAgentReviewStart,
  canChooseLocalReviewScope,
  localReviewScopeReady,
} from "@t3tools/client-runtime/agent-review";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AGENT_REVIEW_MODES,
  type AgentReviewMode,
  type EnvironmentId,
  type LocalReviewScope,
  type ModelSelection,
  type PullRequestRef,
  type PullRequestStartReviewResult,
  type ReviewBasedOnInput,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { ShieldCheckIcon } from "lucide-react";
import { useCallback, useId, useMemo, useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useRightPanelStore } from "../../rightPanelStore";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useProject, useServerConfigs, useThreadShell } from "../../state/entities";
import { useEnvironmentProviders } from "../../state/environments";
import { pullRequestEnvironment } from "../../state/pullRequests";
import { reviewEnvironment } from "../../state/review";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ModelFastModeToggle } from "../chat/ModelFastModeToggle";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { readReviewStartPreference, writeReviewStartPreference } from "./reviewStartPreference";

export type { AgentReviewChoices, AgentReviewRequest };

/** A review that started, and how thorough it is, for what the start says to the reader. */
export type StartedAgentReview = PullRequestStartReviewResult & { readonly mode: AgentReviewMode };

/**
 * Starts an agent review with given choices: `start` reports a failure itself and resolves to the
 * new review thread, or null. Shared by the start form and a failed review's Try again.
 */
export function useStartAgentReview(
  environmentId: EnvironmentId | null,
  request: AgentReviewRequest | null,
) {
  const startReview = useAtomCommand(pullRequestEnvironment.startReview, { reportFailure: false });
  const startLocalReview = useAtomCommand(reviewEnvironment.startLocal, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const configs = useServerConfigs();
  const capabilities =
    environmentId === null ? undefined : configs.get(environmentId)?.environment.capabilities;
  const canScope = request !== null && canChooseLocalReviewScope(request, capabilities);
  const start = async (choices: AgentReviewChoices): Promise<StartedAgentReview | null> => {
    if (pending || environmentId === null || request === null) return null;
    setPending(true);
    const call = buildAgentReviewStart(request, choices, { canScope });
    const result =
      call.method === "pullRequests.startReview"
        ? await startReview({ environmentId, input: call.input })
        : await startLocalReview({ environmentId, input: call.input });
    setPending(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Could not start the review",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
      return null;
    }
    return { ...result.value, mode: choices.mode };
  };
  return { pending, canScope, start };
}

/**
 * The choices an agent review starts from: how thorough, with which model (the project's default
 * for new threads until the reader picks another), and what to look at. `start` reports a
 * failure itself and resolves to the new review thread, or null; given `basedOn`, it re-reviews
 * only what changed since those findings.
 */
export function useAgentReviewForm(environmentId: EnvironmentId, request: AgentReviewRequest) {
  const starter = useStartAgentReview(environmentId, request);
  const settings = useEnvironmentSettings(environmentId);
  const projectId =
    request.kind === "pull-request" ? request.reference.projectId : request.projectId;
  const project = useProject(scopeProjectRef(environmentId, projectId));
  const providers = useEnvironmentProviders().get(environmentId) ?? EMPTY_SERVER_PROVIDERS;
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings, projectId),
  );
  const [picked, setPicked] = useState<ModelSelection | null>(null);
  const selection =
    picked ??
    resolveDefaultProviderModelSelection(
      providers,
      resolveProjectSettings(settings, projectId, project).settings.defaultModelSelection,
    );
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    selection?.instanceId,
    selection?.model,
  );
  // The form opens on the depth and "What to review" last started on this device.
  const [remembered] = useState(readReviewStartPreference);
  // A security audit is started by its own button, so it is never the depth the form opens on.
  const [mode, setMode] = useState<ReviewDepth>(
    remembered.mode === "security" ? "deep" : remembered.mode,
  );
  const [focus, setFocus] = useState("");
  // What of the local changes to read; null leaves it to the reviewer (uncommitted, else branch).
  const [scope, setScope] = useState<LocalReviewScope | null>(remembered.scope);
  const { pending } = starter;
  const { canScope } = starter;
  const scopeReady = !canScope || localReviewScopeReady(scope);
  // The checkout a local review reads, whose commits and base the scope choices offer.
  const sourceThread = useThreadShell(
    request.kind === "local" ? scopeThreadRef(environmentId, request.sourceThreadId) : null,
  );
  const checkoutCwd =
    request.kind === "local"
      ? (sourceThread?.worktreePath ?? project?.workspaceRoot ?? null)
      : null;
  const start = async (basedOn?: ReviewBasedOnInput, audit?: "security") => {
    const started = await starter.start({
      mode: audit ?? mode,
      modelSelection: selection,
      focus,
      basedOn,
      scope: canScope ? scope : null,
    });
    if (started !== null) {
      writeReviewStartPreference({ mode, scope: canScope ? scope : remembered.scope });
    }
    return started;
  };

  return {
    /** Whether a review of local changes can be told what to read. */
    environmentId,
    canScope,
    scope,
    setScope,
    checkoutCwd,
    entries,
    modelOptions,
    selection,
    setPicked,
    mode,
    setMode,
    focus,
    setFocus,
    pending,
    canStart: !pending && selection !== null && scopeReady,
    start,
  };
}

export type AgentReviewForm = ReturnType<typeof useAgentReviewForm>;

/** How thorough a review is. A security audit is a different job with its own button. */
type ReviewDepth = Exclude<AgentReviewMode, "security">;
const REVIEW_DEPTHS: ReadonlyArray<{
  readonly mode: ReviewDepth;
  readonly label: string;
  readonly description: string;
}> = [
  { mode: "quick", label: "Quick", description: "One agent, one pass over the change." },
  {
    mode: "deep",
    label: "Deep",
    description:
      "Several agents, security included, disprove each other's findings. Uses more of your plan.",
  },
];

/** Mode, model and focus for an agent review, wherever one is started. */
export function AgentReviewFields({ form }: { form: AgentReviewForm }) {
  const id = useId();
  const { selection } = form;
  const selectedEntry =
    selection === null
      ? undefined
      : form.entries.find((entry) => entry.instanceId === selection.instanceId);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <span id={`${id}-depth`} className="font-medium text-xs text-muted-foreground">
          Depth
        </span>
        <ToggleGroup
          aria-labelledby={`${id}-depth`}
          className="w-full *:flex-1"
          value={[form.mode]}
          disabled={form.pending}
          onValueChange={(next) => {
            const depth = REVIEW_DEPTHS.find((entry) => entry.mode === next[0]);
            if (depth) form.setMode(depth.mode);
          }}
        >
          {REVIEW_DEPTHS.map((entry) => (
            <Toggle key={entry.mode} value={entry.mode}>
              {entry.label}
            </Toggle>
          ))}
        </ToggleGroup>
        <span className="text-xs text-muted-foreground">
          {REVIEW_DEPTHS.find((entry) => entry.mode === form.mode)?.description}
        </span>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm">Model</span>
        {selection ? (
          <span className="flex min-w-0 items-center gap-1">
            {selectedEntry ? (
              <ModelFastModeToggle
                selection={selection}
                driverKind={selectedEntry.driverKind}
                models={selectedEntry.models}
                disabled={form.pending}
                onChange={form.setPicked}
              />
            ) : null}
            <ProviderModelPicker
              environmentId={form.environmentId}
              activeInstanceId={selection.instanceId}
              model={selection.model}
              lockedProvider={null}
              instanceEntries={form.entries}
              modelOptionsByInstance={form.modelOptions}
              triggerAriaLabel="Review model"
              disabled={form.pending}
              onInstanceModelChange={(instanceId, model) =>
                form.setPicked(createModelSelection(instanceId, model))
              }
            />
          </span>
        ) : (
          <span className="text-sm text-muted-foreground">No providers available</span>
        )}
      </div>
      <Label className="flex min-w-0 flex-col items-stretch" htmlFor={`${id}-focus`}>
        Focus (optional)
        <Input
          id={`${id}-focus`}
          placeholder="For example: error handling, migrations"
          maxLength={500}
          value={form.focus}
          disabled={form.pending}
          onChange={(event) => form.setFocus(event.target.value)}
        />
      </Label>
    </div>
  );
}

/**
 * Starts a security audit of the same change with the form's model and focus. Apart from the
 * depth: it hunts for vulnerabilities only, and is wanted far less often than a review.
 */
export function SecurityAuditButton({
  disabled,
  onStart,
}: {
  disabled: boolean;
  onStart: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={onStart} />
        }
      >
        <ShieldCheckIcon aria-hidden />
        Security audit
      </TooltipTrigger>
      <TooltipPopup side="top">
        Several agents hunt for vulnerabilities in the change and the code it reaches, instead of a
        review. Uses more of your plan.
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * Says a review started and where it shows: in the chat it was started from (as one of its
 * agents, findings in the Review panel), or in the pull request's Review tab. Nothing navigates.
 */
export function announceReviewStarted(
  started: StartedAgentReview,
  where: "chat" | "pull-request",
): void {
  const label = AGENT_REVIEW_MODES.find((entry) => entry.mode === started.mode)?.label ?? "Review";
  toastManager.add({
    type: "success",
    title: `${label} started`,
    description:
      where === "chat"
        ? "Progress shows in this chat, findings in the Review panel as the review finds them."
        : "Findings appear in the Review tab as the review finds them.",
  });
}

/**
 * What starting a review from the pull request detail does: beside a chat, the reviewer is that
 * chat's agent and the chat's Review panel opens; on the pull request page, `onShow` brings the
 * Review tab forward. The reader stays where they are either way.
 */
export function createReviewStartedHandler(
  besideChat: ScopedThreadRef | null,
  onShow: () => void,
): (started: StartedAgentReview) => void {
  return (started: StartedAgentReview) => {
    if (besideChat !== null) useRightPanelStore.getState().open(besideChat, "review");
    else onShow();
    announceReviewStarted(started, besideChat !== null ? "chat" : "pull-request");
  };
}

/**
 * Starts an agent review of a pull request: a new thread on the project, linked to the pull
 * request. The reader stays where they are; `onStarted` says where the review went. The server
 * words the request and picks the permissions; this only chooses how thorough, with which model,
 * and what to look at.
 */
export function PullRequestAgentReviewDialog({
  environmentId,
  reference,
  sourceThreadId,
  number,
  onStarted,
  onClose,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  /** The chat the detail sits beside, whose agent the reviewer becomes. */
  sourceThreadId?: ThreadId | undefined;
  number: number;
  onStarted: (started: StartedAgentReview) => void;
  onClose: () => void;
}) {
  const form = useAgentReviewForm(environmentId, {
    kind: "pull-request",
    reference,
    sourceThreadId,
  });

  const start = async (audit?: "security") => {
    const started = await form.start(undefined, audit);
    if (started === null) return;
    onClose();
    onStarted(started);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !form.pending) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void start();
          }}
        >
          <DialogHeader>
            <DialogTitle>Review #{number} with an agent</DialogTitle>
            <DialogDescription>
              Starts a thread linked to this pull request; its findings show in the Review tab. The
              agent reads the change without touching your checkout and posts nothing unless you
              ask.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <AgentReviewFields form={form} />
          </DialogPanel>
          <DialogFooter>
            <SecurityAuditButton disabled={!form.canStart} onStart={() => void start("security")} />
            <Button type="button" variant="outline" disabled={form.pending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!form.canStart}>
              {form.pending ? "Starting..." : "Start review"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
