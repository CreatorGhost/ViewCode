import {
  ProviderDriverKind,
  type DetectedProvider,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";

/** Built-in drivers the first-run choice lists, in display order. */
export const PROVIDER_CHOICE_DRIVERS: readonly ProviderDriverKind[] = [
  "claudeAgent",
  "codex",
  "cursor",
  "grok",
  "opencode",
  "antigravity",
  "commandCode",
].map((driver) => ProviderDriverKind.make(driver));

export type ProviderChoiceDetection =
  | { readonly kind: "checking" }
  | { readonly kind: "found"; readonly path: string | null }
  | { readonly kind: "missing" };

export interface ProviderChoiceTile {
  readonly driver: ProviderDriverKind;
  readonly detection: ProviderChoiceDetection;
}

/** One tile per built-in driver; detection is "checking" until a result arrives. */
export function buildProviderChoiceTiles(
  detected: ReadonlyArray<DetectedProvider> | null,
): ProviderChoiceTile[] {
  const byDriver = new Map(detected?.map((provider) => [provider.driver, provider]));
  return PROVIDER_CHOICE_DRIVERS.map((driver) => {
    if (detected === null) return { driver, detection: { kind: "checking" } };
    const provider = byDriver.get(driver);
    return {
      driver,
      detection:
        provider?.installed === true ? { kind: "found", path: provider.path } : { kind: "missing" },
    };
  });
}

export function providerChoiceDetectionLabel(detection: ProviderChoiceDetection): string {
  switch (detection.kind) {
    case "checking":
      return "Checking...";
    case "found":
      return detection.path === null ? "Found" : "Found at";
    case "missing":
      return "Not installed";
  }
}

export function enableAgentsButtonLabel(count: number): string {
  if (count <= 0) return "Enable agents";
  return count === 1 ? "Enable 1 agent" : `Enable ${count} agents`;
}

/** The chosen drivers in display order, so the request is stable. */
export function orderedChosenDrivers(
  chosen: ReadonlySet<ProviderDriverKind>,
): ProviderDriverKind[] {
  return PROVIDER_CHOICE_DRIVERS.filter((driver) => chosen.has(driver));
}

export type ProviderSelectionView = "unknown" | "pending" | "chosen";

/**
 * "unknown" until the environment's settings arrive, so callers can hold off
 * on anything that would probe providers. Absent means settings from before
 * the choice existed, which behave as chosen.
 */
export function providerSelectionView(
  settings: ServerSettings | null | undefined,
): ProviderSelectionView {
  if (settings == null) return "unknown";
  return settings.providerSelection === "pending" ? "pending" : "chosen";
}

/**
 * Drivers the post-choice onboarding cards show: what was just chosen on this
 * screen when known, otherwise every enabled built-in provider.
 */
export function resolveOnboardingAgentDrivers(
  providers: ReadonlyArray<ServerProvider> | null | undefined,
  justChosen: ReadonlyArray<ProviderDriverKind> | undefined,
): ProviderDriverKind[] {
  if (justChosen !== undefined) return orderedChosenDrivers(new Set(justChosen));
  const enabled = new Set(
    (providers ?? [])
      .filter((provider) => provider.enabled && provider.status !== "disabled")
      .map((provider) => provider.driver),
  );
  return orderedChosenDrivers(enabled);
}
