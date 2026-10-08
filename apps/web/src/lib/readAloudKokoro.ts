import type { VoiceModelTier } from "@t3tools/contracts";

export type KokoroWorkerRequest =
  | { readonly type: "load"; readonly tier: VoiceModelTier; readonly modelBaseUrl: string }
  | {
      readonly type: "speak";
      readonly id: number;
      readonly text: string;
      readonly voice: string;
      readonly speed: number;
      readonly modelBaseUrl: string;
    };

export type KokoroWorkerResponse =
  | { readonly type: "loaded" }
  | {
      readonly type: "audio";
      readonly id: number;
      readonly samples: Float32Array;
      readonly sampleRate: number;
    }
  | { readonly type: "failed"; readonly id: number | null; readonly message: string };

export interface KokoroClip {
  readonly samples: Float32Array;
  readonly sampleRate: number;
}

/** The model stays loaded this long after the last reply, then its memory is freed. */
const IDLE_UNLOAD_MS = 5 * 60_000;

interface Session {
  readonly worker: Worker;
  readonly tier: VoiceModelTier;
  readonly loaded: Promise<void>;
  readonly pending: Map<number, { resolve(clip: KokoroClip): void; reject(error: Error): void }>;
}

let session: Session | null = null;
let nextRequestId = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

/** Whether this browser can run the natural voice at all. */
export function isKokoroSupported(): boolean {
  return (
    typeof Worker === "function" &&
    typeof WebAssembly === "object" &&
    typeof globalThis.AudioContext === "function"
  );
}

function send(worker: Worker, request: KokoroWorkerRequest): void {
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Workers take no target origin.
  worker.postMessage(request);
}

function openSession(tier: VoiceModelTier, modelBaseUrl: string): Session {
  if (session?.tier === tier) return session;
  closeKokoro();
  // Created on first use only, so neither the worker nor the model touch startup.
  const worker = new Worker(new URL("./readAloudKokoro.worker.ts", import.meta.url), {
    type: "module",
    name: "read-aloud-voice",
  });
  const pending: Session["pending"] = new Map();
  let settleLoaded: { resolve(): void; reject(error: Error): void } | null = null;
  const loaded = new Promise<void>((resolve, reject) => {
    settleLoaded = { resolve, reject };
  });
  // A failed load surfaces through `synthesizeKokoro`; this keeps it from being unhandled meanwhile.
  loaded.catch(() => {});
  const fail = (error: Error) => {
    settleLoaded?.reject(error);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    if (session?.worker === worker) closeKokoro();
  };
  worker.addEventListener("message", ({ data }: MessageEvent<KokoroWorkerResponse>) => {
    if (data.type === "loaded") {
      settleLoaded?.resolve();
    } else if (data.type === "audio") {
      pending.get(data.id)?.resolve({ samples: data.samples, sampleRate: data.sampleRate });
      pending.delete(data.id);
    } else if (data.id === null) {
      fail(new Error(data.message));
    } else {
      pending.get(data.id)?.reject(new Error(data.message));
      pending.delete(data.id);
    }
  });
  worker.addEventListener("error", (event) => {
    fail(new Error(event.message || "The voice worker stopped."));
  });
  send(worker, { type: "load", tier, modelBaseUrl });
  session = { worker, tier, loaded, pending };
  return session;
}

/**
 * Synthesizes one chunk with the natural voice, loading the tier's model from
 * `modelBaseUrl` on first use. Requests run in order on one worker.
 */
export async function synthesizeKokoro(
  source: { readonly tier: VoiceModelTier; readonly modelBaseUrl: string },
  text: string,
  voice: string,
  speed: number,
): Promise<KokoroClip> {
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = setTimeout(closeKokoro, IDLE_UNLOAD_MS);
  const current = openSession(source.tier, source.modelBaseUrl);
  await current.loaded;
  return new Promise((resolve, reject) => {
    const id = (nextRequestId += 1);
    current.pending.set(id, { resolve, reject });
    send(current.worker, {
      type: "speak",
      id,
      text,
      voice,
      speed,
      // Signed URLs expire; each request carries a fresh one for the voice files.
      modelBaseUrl: source.modelBaseUrl,
    });
  });
}

/** Stops the voice worker and frees the model's memory. */
export function closeKokoro(): void {
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = null;
  if (!session) return;
  const closing = session;
  session = null;
  closing.worker.terminate();
  const error = new Error("The voice was unloaded.");
  for (const request of closing.pending.values()) request.reject(error);
}
