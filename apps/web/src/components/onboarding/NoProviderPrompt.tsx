import { useAtomValue } from "@effect/atom-react";
import { AuthProvidersManageScope, type EnvironmentId } from "@t3tools/contracts";
import { InfoIcon } from "lucide-react";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useSplitPaneFocused } from "../../splitView/SplitPaneContext";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { InlineButton } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { ProviderPicker } from "./ProviderPicker";
import { resolveProviderPickerPrompt, type ProviderPickerPrompt } from "./providerSetup.logic";

// Closing the picker holds for the rest of this page's life, per environment,
// so moving between chats does not reopen it.
const dismissedEnvironmentIdsAtom = Atom.make<ReadonlySet<EnvironmentId>>(
  new Set<EnvironmentId>(),
).pipe(Atom.keepAlive, Atom.withLabel("web-onboarding-provider-picker-dismissed"));

function setPickerDismissed(environmentId: EnvironmentId, dismissed: boolean) {
  appAtomRegistry.update(dismissedEnvironmentIdsAtom, (current) => {
    if (current.has(environmentId) === dismissed) return current;
    const next = new Set(current);
    if (dismissed) next.add(environmentId);
    else next.delete(environmentId);
    return next;
  });
}

/** Whether the chat on this environment needs the provider picker or its notice. */
export function useProviderPickerPrompt(environmentId: EnvironmentId): ProviderPickerPrompt {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const canManage = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const dismissedEnvironmentIds = useAtomValue(dismissedEnvironmentIdsAtom);
  const paneFocused = useSplitPaneFocused();
  const prompt = resolveProviderPickerPrompt({
    environmentId,
    instances: config?.settings.providerInstances ?? null,
    blockedDrivers: config?.adminBlockedProviderDrivers ?? [],
    providers: config?.providers ?? null,
    canManage,
    dismissedEnvironmentIds,
  });
  // With two panes on one environment, only the focused one opens the dialog.
  return prompt === "picker" && !paneFocused ? "inline" : prompt;
}

/**
 * Shows the first-run provider picker over a chat whose server has no AI tool
 * turned on, and a notice in the chat once it is closed. Both go away as soon
 * as a provider is on. The dialog stays mounted (closed) so it can animate out.
 */
export function NoProviderPrompt({
  environmentId,
  prompt,
}: {
  readonly environmentId: EnvironmentId;
  readonly prompt: ProviderPickerPrompt;
}) {
  const { environments } = useEnvironments();
  const machineLabel =
    environments.find((environment) => environment.environmentId === environmentId)?.label ??
    "this computer";

  return (
    <>
      {prompt === "inline" || prompt === "inline-read-only" ? (
        <div data-chat-notice className="pointer-events-auto px-4 pt-3">
          <Alert variant="warning" role="status" surface="glass" controlAlignment="first-line">
            <InfoIcon />
            <AlertTitle>No AI tool is turned on</AlertTitle>
            <AlertDescription>
              {prompt === "inline-read-only" ? (
                <span>
                  This connection cannot change providers. Ask whoever runs {machineLabel} to turn
                  one on in Settings → Providers.
                </span>
              ) : (
                <>
                  <span>Nothing can answer here until you turn one on.</span>
                  <InlineButton onClick={() => setPickerDismissed(environmentId, false)}>
                    Turn one on
                  </InlineButton>
                </>
              )}
            </AlertDescription>
          </Alert>
        </div>
      ) : null}
      <Dialog
        open={prompt === "picker"}
        onOpenChange={(open) => {
          if (!open) setPickerDismissed(environmentId, true);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Turn on an AI tool</DialogTitle>
            <DialogDescription>
              No AI tool is turned on for {machineLabel}, so nothing can answer in this chat yet.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <ProviderPicker environmentId={environmentId} />
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}
