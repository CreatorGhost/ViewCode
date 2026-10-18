/** Provider/project gates must not masquerade as a disconnected environment. */
export function composerAvailabilityDisabledReason(input: {
  readonly projectSelectionRequired: boolean;
  readonly noProviderAvailable: boolean;
  readonly providerCatalogPending: boolean;
}): string | null {
  if (input.projectSelectionRequired) return "Choose a project to send a message";
  if (!input.noProviderAvailable) return null;
  return input.providerCatalogPending
    ? "Loading providers"
    : "Select an enabled provider to send a message";
}
