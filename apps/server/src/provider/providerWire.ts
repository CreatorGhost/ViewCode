import type { ServerProvider } from "@t3tools/contracts";

/**
 * Each provider's per-folder catalogs (skills and slash commands for up to 16
 * folders) ride in every config snapshot and provider status update. Those are
 * single WebSocket messages, and Quick connect's relay closes the client's
 * socket on one over 1 MiB, so clients get the most recently scanned catalogs
 * that fit. A composer whose folder fell off sees no catalog until its next
 * scan (the TTL) makes it the newest again. Moving an asked-for catalog to the
 * newest end instead would let two clients on different folders evict each
 * other in a loop of broadcasts.
 */
const WORKSPACE_SNAPSHOTS_WIRE_MAX_BYTES = 384 * 1024;

export function boundWorkspaceSnapshotsForWire(
  providers: ReadonlyArray<ServerProvider>,
  maxBytes: number = WORKSPACE_SNAPSHOTS_WIRE_MAX_BYTES,
): ReadonlyArray<ServerProvider> {
  const withCatalogs = providers.filter(
    (provider) => (provider.workspaceSnapshots?.length ?? 0) > 0,
  ).length;
  if (withCatalogs === 0) return providers;
  const maxBytesPerProvider = maxBytes / withCatalogs;
  let changed = false;
  const bounded = providers.map((provider) => {
    const snapshots = provider.workspaceSnapshots;
    if (snapshots === undefined || snapshots.length <= 1) return provider;
    let kept = 0;
    let bytes = 0;
    // Newest last: keep from the end, and always keep the newest one.
    for (let index = snapshots.length - 1; index >= 0; index -= 1) {
      const size = Buffer.byteLength(JSON.stringify(snapshots[index]), "utf8");
      if (kept > 0 && bytes + size > maxBytesPerProvider) break;
      bytes += size;
      kept += 1;
    }
    if (kept === snapshots.length) return provider;
    changed = true;
    return { ...provider, workspaceSnapshots: snapshots.slice(snapshots.length - kept) };
  });
  return changed ? bounded : providers;
}
