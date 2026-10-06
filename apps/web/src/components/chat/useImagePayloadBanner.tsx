import { threadImagePayloadBytes } from "@t3tools/client-runtime/state/threads";
import type { OrchestrationMessage } from "@t3tools/contracts";
import { ImagesIcon } from "lucide-react";
import { useMemo, useState } from "react";

import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/**
 * Cursor replays every image of the conversation on each turn and rejects
 * every turn once the total passes its limit (a thread died at 5.9 MB; the
 * exact limit is unknown). Warn well before that, while the thread can still
 * be wrapped up and continued in a new one.
 */
export const CURSOR_IMAGE_PAYLOAD_WARNING_BYTES = 3 * 1024 * 1024;

/** One warning per thread and size step, so a thread that keeps growing warns again. */
export function imagePayloadWarningKey(threadId: string, bytes: number): string | null {
  if (bytes < CURSOR_IMAGE_PAYLOAD_WARNING_BYTES) return null;
  return `${threadId}:${Math.floor(bytes / (1024 * 1024))}`;
}

export function useImagePayloadBanner(input: {
  readonly threadId: string | null;
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly providerName: string | null | undefined;
}): ComposerBannerStackItem | null {
  const { threadId, messages, providerName } = input;
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const bytes = useMemo(
    () => (providerName === "cursor" ? threadImagePayloadBytes(messages) : 0),
    [messages, providerName],
  );
  const key = threadId === null ? null : imagePayloadWarningKey(threadId, bytes);

  return useMemo(() => {
    if (key === null || key === dismissedKey) return null;
    const megabytes = (bytes / (1024 * 1024)).toFixed(1);
    return {
      id: `image-payload:${key}`,
      variant: "warning",
      icon: <ImagesIcon />,
      title: `This thread carries ${megabytes} MB of images`,
      description:
        "Cursor resends every image on each turn. Past its size limit it rejects every message in the thread. To keep adding screenshots, continue in a new thread.",
      dismissLabel: "Dismiss image size warning",
      onDismiss: () => setDismissedKey(key),
    };
  }, [bytes, dismissedKey, key]);
}
