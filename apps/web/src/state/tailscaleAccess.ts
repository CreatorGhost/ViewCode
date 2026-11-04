import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";

import { serverEnvironment } from "~/state/server";

/** Why a server will not run Tailscale: IT's policy, its environment switch or its setting. */
type TailscaleBlock = "policy" | "environment" | "setting";

function tailscaleBlockOf(
  config: Pick<ServerConfig, "tailscaleBlockedBy" | "settings"> | null,
): TailscaleBlock | null {
  if (config === null) return null;
  if (config.tailscaleBlockedBy !== undefined) return config.tailscaleBlockedBy;
  return config.settings.tailscaleEnabled ? null : "setting";
}

export function describeTailscaleBlock(block: TailscaleBlock): string {
  switch (block) {
    case "policy":
      return "Tailscale is blocked by your organization.";
    case "environment":
      return "Tailscale is turned off on this computer (VIEWCODE_DISABLE_TAILSCALE).";
    case "setting":
      return "Tailscale is turned off in Settings → Connections.";
  }
}

// Derived so a config push re-renders only when the answer changes.
const tailscaleBlockAtom = Atom.family((environmentId: EnvironmentId | null) =>
  Atom.make((get) => tailscaleBlockOf(get(serverEnvironment.configValueAtom(environmentId)))).pipe(
    Atom.withLabel(`tailscale-block:${environmentId ?? "none"}`),
  ),
);

/** Null while the environment may use Tailscale, or before its config arrives. */
export function useTailscaleBlock(environmentId: EnvironmentId | null): TailscaleBlock | null {
  return useAtomValue(tailscaleBlockAtom(environmentId));
}
