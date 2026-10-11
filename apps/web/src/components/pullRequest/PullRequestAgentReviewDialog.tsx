import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AGENT_REVIEW_MODES,
  type AgentReviewMode,
  type EnvironmentId,
  type ModelSelection,
  type PullRequestRef,
  type PullRequestStartReviewResult,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useCallback, useId, useMemo, useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useProject } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { pullRequestEnvironment } from "../../state/pullRequests";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
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
import { Radio, RadioGroup } from "../ui/radio-group";
import { toastManager } from "../ui/toast";

/**
 * The choices an agent review starts from: how thorough, with which model (the project's default
 * for new threads until the reader picks another), and what to look at. `start` reports a
 * failure itself and resolves to the new review thread, or null.
 */
export function useAgentReviewForm(environmentId: EnvironmentId, reference: PullRequestRef) {
  const startReview = useAtomCommand(pullRequestEnvironment.startReview, { reportFailure: false });
  const settings = useEnvironmentSettings(environmentId);
  const project = useProject(scopeProjectRef(environmentId, reference.projectId));
  const { environments } = useEnvironments();
  const providers =
    environments.find((environment) => environment.environmentId === environmentId)?.serverConfig
      ?.providers ?? EMPTY_SERVER_PROVIDERS;
  const entries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ),
    [providers, settings],
  );
  const [picked, setPicked] = useState<ModelSelection | null>(null);
  const selection =
    picked ??
    resolveDefaultProviderModelSelection(
      providers,
      resolveProjectSettings(settings, reference.projectId, project).settings.defaultModelSelection,
    );
  const modelOptions = useMemo(
    () =>
      getCustomModelOptionsByInstance(settings, providers, selection?.instanceId, selection?.model),
    [providers, selection?.instanceId, selection?.model, settings],
  );
  const [mode, setMode] = useState<AgentReviewMode>("quick");
  const [focus, setFocus] = useState("");
  const [pending, setPending] = useState(false);

  const start = async (): Promise<PullRequestStartReviewResult | null> => {
    if (pending) return null;
    setPending(true);
    const trimmedFocus = focus.trim();
    const result = await startReview({
      environmentId,
      input: {
        ...reference,
        mode,
        ...(selection ? { modelSelection: selection } : {}),
        ...(trimmedFocus ? { focus: trimmedFocus } : {}),
      },
    });
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
    return result.value;
  };

  return {
    entries,
    modelOptions,
    selection,
    setPicked,
    mode,
    setMode,
    focus,
    setFocus,
    pending,
    canStart: !pending && selection !== null,
    start,
  };
}

export type AgentReviewForm = ReturnType<typeof useAgentReviewForm>;

/** Mode, model and focus for an agent review, wherever one is started. */
export function AgentReviewFields({ form }: { form: AgentReviewForm }) {
  const id = useId();
  const { selection } = form;
  return (
    <div className="flex flex-col gap-4">
      <RadioGroup
        aria-label="Review mode"
        value={form.mode}
        onValueChange={(value) => {
          const next = AGENT_REVIEW_MODES.find((entry) => entry.mode === value);
          if (next) form.setMode(next.mode);
        }}
      >
        {AGENT_REVIEW_MODES.map((entry) => (
          <label
            key={entry.mode}
            className="flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 text-sm"
          >
            <Radio value={entry.mode} className="mt-0.5" />
            <span className="flex min-w-0 flex-col">
              <span className="font-medium">{entry.label}</span>
              <span className="text-xs text-muted-foreground">{entry.description}</span>
            </span>
          </label>
        ))}
      </RadioGroup>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm">Model</span>
        {selection ? (
          <ProviderModelPicker
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
 * What starting a review from the pull request page does: the reader stays, a toast offers the
 * review's chat, and `onShow` brings the Review tab forward, where its findings will appear.
 */
export function useReviewStartedHandler(
  environmentId: EnvironmentId,
  onShow: () => void,
): (started: PullRequestStartReviewResult) => void {
  const navigate = useNavigate();
  return useCallback(
    (started: PullRequestStartReviewResult) => {
      onShow();
      toastManager.add({
        type: "success",
        title: "Review started",
        description: "Its findings appear in the Review tab when it is done.",
        actionProps: {
          children: "Open chat",
          onClick: () => {
            void navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId, threadId: started.threadId },
            });
          },
        },
      });
    },
    [environmentId, navigate, onShow],
  );
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
  number,
  onStarted,
  onClose,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  number: number;
  onStarted: (started: PullRequestStartReviewResult) => void;
  onClose: () => void;
}) {
  const form = useAgentReviewForm(environmentId, reference);

  const start = async () => {
    const started = await form.start();
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
