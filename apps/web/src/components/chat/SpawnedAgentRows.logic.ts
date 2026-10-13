const SPAWNED_AGENTS_OPEN_PREFIX = "agent-spawns-open:";

/** The disclosure key that opens a group of agents a chat started (SpawnedAgentRows). */
export const spawnedAgentsOpenKey = (rowId: string) => `${SPAWNED_AGENTS_OPEN_PREFIX}${rowId}`;

/**
 * The spawn disclosures to remember when the user leaves a chat. A group of started agents is
 * closed by default and opened on demand, and is closed again when the user comes back: most
 * visits are not about the agents, and an open list pushes the conversation down. Other spawn
 * disclosures (one agent's instructions) are remembered as before.
 */
export function rememberedSpawnDisclosures(keys: ReadonlySet<string>): ReadonlySet<string> {
  let kept: Set<string> | null = null;
  for (const key of keys) {
    if (!key.startsWith(SPAWNED_AGENTS_OPEN_PREFIX)) continue;
    kept ??= new Set(keys);
    kept.delete(key);
  }
  return kept ?? keys;
}
