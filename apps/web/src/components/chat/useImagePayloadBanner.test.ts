import { threadImagePayloadBytes } from "@t3tools/client-runtime/state/threads";
import type { OrchestrationMessage } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  CURSOR_IMAGE_PAYLOAD_WARNING_BYTES,
  imagePayloadWarningKey,
} from "./useImagePayloadBanner";

const MB = 1024 * 1024;

const message = (images: ReadonlyArray<number>, files: ReadonlyArray<number> = []) =>
  ({
    id: "m",
    role: "user",
    text: "",
    turnId: null,
    streaming: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    attachments: [
      ...images.map((sizeBytes, index) => ({
        type: "image",
        id: `image-${index}`,
        name: "shot.png",
        mimeType: "image/png",
        sizeBytes,
      })),
      ...files.map((sizeBytes, index) => ({
        type: "file",
        id: `file-${index}`,
        name: "log.txt",
        mimeType: "text/plain",
        sizeBytes,
      })),
    ],
  }) as unknown as OrchestrationMessage;

describe("image payload warning", () => {
  it("counts only images, across every message", () => {
    expect(threadImagePayloadBytes([message([MB, 2 * MB], [9 * MB]), message([MB])])).toBe(4 * MB);
  });

  it("warns from the threshold, and again as the thread keeps growing", () => {
    expect(imagePayloadWarningKey("t", CURSOR_IMAGE_PAYLOAD_WARNING_BYTES - 1)).toBeNull();
    const first = imagePayloadWarningKey("t", CURSOR_IMAGE_PAYLOAD_WARNING_BYTES);
    expect(first).not.toBeNull();
    expect(imagePayloadWarningKey("t", CURSOR_IMAGE_PAYLOAD_WARNING_BYTES + 100)).toBe(first);
    expect(imagePayloadWarningKey("t", 5 * MB)).not.toBe(first);
  });
});
