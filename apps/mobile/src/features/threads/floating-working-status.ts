import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { THREAD_TOO_LARGE_FOR_CONNECTION_MESSAGE } from "@t3tools/client-runtime/state/threads";

/**
 * What the floating pill says. Connection, syncing, and working share one
 * element so the label swaps in place instead of one pill fading out for
 * another. The connection variant is tappable and triggers a reconnect.
 */
export type FloatingWorkingStatus =
  | { readonly kind: "working"; readonly startedAt: string }
  | { readonly kind: "syncing"; readonly label: string }
  | { readonly kind: "compacting" }
  // A task whose thread the server has not created yet: the worktree may
  // still be checking out, so there is no turn to time.
  | { readonly kind: "preparing"; readonly label: string }
  // A problem with this thread only; tapping shows the full explanation.
  | {
      readonly kind: "notice";
      readonly label: string;
      readonly detail: string;
      readonly onPress: () => void;
    }
  | {
      readonly kind: "connection";
      readonly tone: "reconnecting" | "unavailable";
      /** Short enough to fit the pill on a phone. */
      readonly label: string;
      /** The full sentence, naming the environment and error, for screen readers. */
      readonly detail: string;
      readonly onPress: () => void;
    };

/**
 * The pill's connection variant, or null once the environment is connected and
 * the pill is free to report sync and working state instead.
 */
export function connectionFloatingStatus(input: {
  readonly connectionError: string | null;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly environmentLabel: string | null;
  readonly onReconnect: () => void;
}): FloatingWorkingStatus | null {
  const environmentLabel = input.environmentLabel ?? "Environment";
  const pill = (
    tone: "reconnecting" | "unavailable",
    label: string,
    detail: string,
  ): FloatingWorkingStatus => ({
    kind: "connection",
    tone,
    label,
    detail,
    onPress: input.onReconnect,
  });

  switch (input.connectionState) {
    case "connecting":
    case "reconnecting":
      return input.connectionError === null
        ? pill("reconnecting", "Reconnecting…", `Reconnecting to ${environmentLabel}`)
        : pill(
            "reconnecting",
            "Can't connect · retrying",
            `Failed to connect. Retrying ${environmentLabel}: ${input.connectionError}`,
          );
    case "offline":
      return pill("unavailable", "You are offline", "You are offline");
    case "unsupported":
      return pill("unavailable", "Client not supported", "Client not supported");
    case "error":
      return pill(
        "unavailable",
        "Can't connect",
        input.connectionError
          ? `Failed to connect to ${environmentLabel}: ${input.connectionError}`
          : `Failed to connect to ${environmentLabel}`,
      );
    case "available":
      return pill("unavailable", "Disconnected", `${environmentLabel} is not connected`);
    case "connected":
      return null;
  }
}

/**
 * The thread's catch-up was too big for Quick connect, so it is held back and
 * would otherwise sit on "Syncing messages…" forever over a stale cache.
 */
export function threadSyncNoticeStatus(input: {
  readonly threadSyncError: string | null;
  readonly onPress: () => void;
}): FloatingWorkingStatus | null {
  return input.threadSyncError === THREAD_TOO_LARGE_FOR_CONNECTION_MESSAGE
    ? {
        kind: "notice",
        label: "Too large for Quick connect",
        detail: input.threadSyncError,
        onPress: input.onPress,
      }
    : null;
}
