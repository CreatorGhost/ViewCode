import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { shouldRefreshUsage, USAGE_REFRESH_AFTER_MS } from "./composerUsageLimits.logic";

// Shared by header and composer, so opening either panel cannot duplicate a probe.
const attempts = new Map<
  string,
  { at: number; pending: Promise<boolean> | null; failed: boolean }
>();

export function useUsageRefreshOnOpen(
  environmentId: EnvironmentId,
  entries: ReadonlyArray<ProviderInstanceEntry>,
) {
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const [openedAt] = useState(() => Date.now());
  const [initialEntries] = useState(() =>
    entries.filter(
      (entry) =>
        entry.enabled &&
        entry.isAvailable &&
        entry.installed &&
        shouldRefreshUsage(entry.snapshot.usageLimits, openedAt),
    ),
  );
  const [refreshing, setRefreshing] = useState<ReadonlySet<ProviderInstanceId>>(
    () =>
      new Set(
        initialEntries
          .filter((entry) => {
            const attempt = attempts.get(JSON.stringify([environmentId, entry.instanceId]));
            return !attempt || attempt.pending || openedAt - attempt.at >= USAGE_REFRESH_AFTER_MS;
          })
          .map((entry) => entry.instanceId),
      ),
  );
  const [error, setError] = useState<string | null>(() =>
    initialEntries.some((entry) => {
      const attempt = attempts.get(JSON.stringify([environmentId, entry.instanceId]));
      return attempt?.failed && !attempt.pending && openedAt - attempt.at < USAGE_REFRESH_AFTER_MS;
    })
      ? "Could not refresh usage. Showing the last available readings."
      : null,
  );
  useEffect(() => {
    let active = true;
    for (const [key, attempt] of attempts) {
      if (!attempt.pending && openedAt - attempt.at >= USAGE_REFRESH_AFTER_MS) attempts.delete(key);
    }
    for (const entry of initialEntries) {
      const key = JSON.stringify([environmentId, entry.instanceId]);
      let attempt = attempts.get(key);
      if (attempt && !attempt.pending) continue;
      if (!attempt) {
        attempt = { at: openedAt, pending: null, failed: false };
        attempts.set(key, attempt);
        const current = attempt;
        current.pending = refreshProviders({
          environmentId,
          input: { instanceId: entry.instanceId },
        })
          .then(
            (result) => result._tag === "Success",
            () => false,
          )
          .then((success) => {
            current.failed = !success;
            return success;
          })
          .finally(() => {
            current.pending = null;
            current.at = Date.now();
          });
      }
      void attempt.pending?.then((success) => {
        if (!active) return;
        if (!success) setError("Could not refresh usage. Showing the last available readings.");
        setRefreshing((ids) => {
          const next = new Set(ids);
          next.delete(entry.instanceId);
          return next;
        });
      });
    }
    return () => {
      active = false;
    };
  }, [environmentId, initialEntries, openedAt, refreshProviders]);
  return { refreshing, openedAt, error };
}
