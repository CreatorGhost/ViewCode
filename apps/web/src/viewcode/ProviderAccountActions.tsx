import { useAtomValue } from "@effect/atom-react";
import {
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  type EnvironmentId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { providerAccountActionsAvailable } from "./providerPolicyUi";
import { isAccountDriver } from "@t3tools/shared/providerAccounts";
import { useState } from "react";
import {
  AddProviderAccountDialog,
  ProviderSignInDialog,
} from "../components/settings/ProviderAccountDialogs";
import { SettingsSection, SettingsRow } from "../components/settings/settingsLayout";
import { Button } from "../components/ui/button";
import { serverEnvironment } from "../state/server";
import { useEnvironmentScope } from "../state/session";

/** Accounts remain ordinary upstream provider instances, including in the model picker. */
export function ProviderAccountActions(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly driver: string;
  readonly label: string;
  readonly blocked: boolean;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const canManage = useEnvironmentScope(props.environmentId, AuthProvidersManageScope);
  const canWrite = useEnvironmentScope(props.environmentId, AuthSettingsWriteScope);
  const [adding, setAdding] = useState(false);
  const [signingIn, setSigningIn] = useState<{
    readonly instanceId: ProviderInstanceId;
    readonly label: string;
  } | null>(null);
  const actions = providerAccountActionsAvailable({
    driver: props.driver,
    blocked: props.blocked,
    canManage,
    canWrite,
  });
  if (!isAccountDriver(props.driver) || (!actions.canAdd && !actions.canSignIn)) return null;
  return (
    <SettingsSection title="Accounts">
      {actions.canSignIn ? (
        <SettingsRow
          title="Sign in to this account"
          description="Use a separate login for this provider instance."
        >
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSigningIn({ instanceId: props.instanceId, label: props.label })}
          >
            Sign in
          </Button>
        </SettingsRow>
      ) : null}
      {actions.canAdd ? (
        <SettingsRow
          title="Add another account"
          description="Switch accounts from the model picker while keeping your conversation."
        >
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            Add account
          </Button>
        </SettingsRow>
      ) : null}
      {adding && actions.canAdd ? (
        <AddProviderAccountDialog
          environmentId={props.environmentId}
          driver={props.driver}
          existingIds={new Set(Object.keys(config?.settings.providerInstances ?? {}))}
          onClose={() => setAdding(false)}
          onSignIn={(added, label) => {
            if (actions.canSignIn) setSigningIn({ instanceId: added.instanceId, label });
          }}
        />
      ) : null}
      {signingIn && actions.canSignIn ? (
        <ProviderSignInDialog
          environmentId={props.environmentId}
          instanceId={signingIn.instanceId}
          label={signingIn.label}
          driver={props.driver}
          onClose={() => setSigningIn(null)}
        />
      ) : null}
    </SettingsSection>
  );
}
