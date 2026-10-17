const REGISTRY_DRIVER_ALIASES: Readonly<Record<string, string>> = {
  "claude-code": "claudeAgent",
  "claude-agent": "claudeAgent",
  claude: "claudeAgent",
  "codex-acp": "codex",
  "factory-droid": "droid",
  "command-code": "commandCode",
};

export const driverForRegistryAgent = (agentId: string): string =>
  REGISTRY_DRIVER_ALIASES[agentId] ?? agentId;

export function isAdminBlockedProvider(
  instance: { readonly driver: string; readonly config?: unknown },
  blockedDrivers: ReadonlyArray<string>,
): boolean {
  if (blockedDrivers.includes(instance.driver)) return true;
  if (
    instance.driver !== "acpRegistry" ||
    typeof instance.config !== "object" ||
    instance.config === null
  )
    return false;
  const agentId = Reflect.get(instance.config, "agentId");
  return typeof agentId === "string" && blockedDrivers.includes(driverForRegistryAgent(agentId));
}
