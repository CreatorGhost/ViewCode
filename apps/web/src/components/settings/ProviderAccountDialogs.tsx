import {
  ProviderInstanceId,
  type EnvironmentId,
  type ProviderAccountAddResult,
  type ProviderAccountSignInPlan,
} from "@t3tools/contracts";
import { deriveAccountInstanceId, validateAccountInstanceId } from "@t3tools/shared/providerAccounts";
import { useAtomValue } from "@effect/atom-react";
import { useMemo, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { AgentInstallTerminal } from "../onboarding/WelcomeWizard";
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
import { toastManager } from "../ui/toast";

export type AccountDriver = "codex" | "claudeAgent";

/**
 * Sign an account in: the server readies the instance's home and an empty cwd,
 * then the instance's own login runs in an embedded terminal on that
 * environment. Closing (or the login exiting) refreshes provider status.
 */
export function ProviderSignInDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly driver: AccountDriver;
  readonly label: string;
  readonly onClose: () => void;
}) {
  const { environmentId, instanceId, driver, label, onClose } = props;
  const prepare = useAtomCommand(serverEnvironment.prepareProviderAccountSignIn, {
    reportFailure: false,
  });
  const refresh = useAtomCommand(serverEnvironment.refreshProviders, { reportFailure: false });
  const keybindings = useAtomValue(serverEnvironment.configValueAtom(environmentId))?.keybindings;
  const [plan, setPlan] = useState<ProviderAccountSignInPlan | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setError(null);
    const result = await prepare({ environmentId, input: { instanceId } });
    if (result._tag === "Success") setPlan(result.value);
    else setError("Could not prepare the sign-in on this environment.");
  };
  const finish = () => {
    onClose();
    void refresh({ environmentId, input: { refreshModels: true } });
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : finish())}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Sign in to {label}</DialogTitle>
          <DialogDescription>
            Runs the login for this account in a terminal on the environment. Close this when it
            finishes.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {plan && keybindings ? (
            <AgentInstallTerminal
              onClose={finish}
              session={{
                environmentId,
                driver,
                providerInstanceId: instanceId,
                cwd: plan.cwd,
                // Enter included: the user asked to sign in, so run it.
                command: `${plan.command}\r`,
                keybindings,
              }}
            />
          ) : (
            <div className="flex items-center gap-3">
              <Button onClick={() => void start()}>Start sign-in</Button>
              {error ? <span className="text-xs text-destructive">{error}</span> : null}
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={finish}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * Add a Codex or Claude account: label -> derived id -> managed home (or an
 * existing directory), then offer to sign it in.
 */
export function AddProviderAccountDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly driver: AccountDriver;
  readonly existingIds: ReadonlySet<string>;
  readonly onClose: () => void;
  readonly onSignIn: (added: ProviderAccountAddResult, label: string) => void;
}) {
  const { environmentId, driver, existingIds, onClose, onSignIn } = props;
  const add = useAtomCommand(serverEnvironment.addProviderAccount, { reportFailure: false });
  const [label, setLabel] = useState("");
  const [useExisting, setUseExisting] = useState(false);
  const [directory, setDirectory] = useState("");
  const [busy, setBusy] = useState(false);

  const instanceId = useMemo(
    () => deriveAccountInstanceId(driver, label, existingIds),
    [driver, existingIds, label],
  );
  const idError = label.trim() ? validateAccountInstanceId(instanceId, existingIds) : null;
  const canAdd =
    !busy && label.trim() !== "" && idError === null && (!useExisting || directory.trim() !== "");
  const driverName = driver === "codex" ? "Codex" : "Claude";

  const submit = async () => {
    setBusy(true);
    const result = await add({
      environmentId,
      input: {
        driver,
        instanceId: ProviderInstanceId.make(instanceId),
        displayName: label.trim(),
        ...(useExisting ? { existingDirectory: directory.trim() } : {}),
      },
    });
    setBusy(false);
    if (result._tag === "Success") {
      onClose();
      onSignIn(result.value, label.trim());
    } else {
      toastManager.add({ type: "error", title: `Could not add the ${driverName} account.` });
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Add {driverName} account</DialogTitle>
          <DialogDescription>
            {driver === "codex"
              ? "The account shares your Codex sessions and keeps its own login."
              : "The account gets its own Claude config directory and login."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-3">
          <label className="grid gap-1 text-sm font-medium">
            Label
            <Input
              autoFocus
              value={label}
              placeholder="Work"
              onChange={(event) => setLabel(event.target.value)}
            />
            <span className="text-xs font-normal text-muted-foreground">
              {idError ?? (instanceId ? `Instance id: ${instanceId}` : " ")}
            </span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={useExisting}
              onChange={(event) => setUseExisting(event.target.checked)}
            />
            Use an existing directory
          </label>
          {useExisting ? (
            <Input
              value={directory}
              placeholder={driver === "codex" ? "/path/to/codex-home" : "/path/to/claude-config"}
              onChange={(event) => setDirectory(event.target.value)}
            />
          ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!canAdd} onClick={() => void submit()}>
            Add and sign in
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** Sign in / add-account buttons shown in a Codex or Claude instance's Setup section. */
export function ProviderAccountActions(props: {
  readonly readOnly: boolean;
  readonly onSignIn: () => void;
  readonly onAddAccount: () => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={props.readOnly} onClick={props.onSignIn}>
        Sign in
      </Button>
      <Button size="sm" variant="outline" disabled={props.readOnly} onClick={props.onAddAccount}>
        Add another account
      </Button>
    </div>
  );
}
