import { isAccountDriver } from "@t3tools/shared/providerAccounts";
import { isAdminBlockedProvider } from "@t3tools/shared/viewcodeProviderPolicy";
export { isAdminBlockedProvider };

/** Account creation and signing in have different server authorization scopes. */
export function providerAccountActionsAvailable(input: {
  readonly driver: string;
  readonly blocked: boolean;
  readonly canManage: boolean;
  readonly canWrite: boolean;
}) {
  const available = isAccountDriver(input.driver) && !input.blocked;
  return { canAdd: available && input.canWrite, canSignIn: available && input.canManage };
}

/** Setup controls stay inert until the environment policy has been received. */
export function providerSetupUnavailableReason(input: {
  readonly instance: { readonly driver: string; readonly config?: unknown };
  readonly blockedDrivers: ReadonlyArray<string>;
  readonly hasConfiguration: boolean;
  readonly canManage: boolean;
}): string | null {
  if (!input.hasConfiguration) return "Waiting for provider policy.";
  if (isAdminBlockedProvider(input.instance, input.blockedDrivers))
    return "Blocked by your administrator.";
  if (!input.canManage) return "This connection cannot manage providers.";
  return null;
}
