import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";

/** Built-in drivers onboarding lists, in display order. */
const ONBOARDING_AGENT_DRIVERS: readonly ProviderDriverKind[] = [
  "claudeAgent",
  "codex",
  "cursor",
  "grok",
  "opencode",
  "antigravity",
  "commandCode",
].map((driver) => ProviderDriverKind.make(driver));

/** Drivers the onboarding cards show: every enabled built-in provider, in display order. */
export function resolveOnboardingAgentDrivers(
  providers: ReadonlyArray<ServerProvider> | null | undefined,
): ProviderDriverKind[] {
  const enabled = new Set(
    (providers ?? [])
      .filter((provider) => provider.enabled && provider.status !== "disabled")
      .map((provider) => provider.driver),
  );
  return ONBOARDING_AGENT_DRIVERS.filter((driver) => enabled.has(driver));
}
