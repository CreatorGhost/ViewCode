import type { EnvironmentId } from "@t3tools/contracts";

import { isLoopbackHostname } from "../../environments/primary/target";

/**
 * Codex's browser sign-in redirects to a localhost callback on the machine that
 * runs `codex login`. That only completes when the browser is on that machine,
 * so any other environment, or a primary server reached over the network, needs
 * a warning before the user starts.
 */
export function signInNeedsServerBrowser(input: {
  readonly driver: "codex" | "claudeAgent";
  readonly environmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly isDesktop: boolean;
  readonly locationHostname: string;
}): boolean {
  if (input.driver !== "codex") return false;
  if (input.environmentId !== input.primaryEnvironmentId) return true;
  return !input.isDesktop && !isLoopbackHostname(input.locationHostname);
}
