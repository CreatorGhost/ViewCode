export type DictationWorkerRequest =
  | { readonly type: "load"; readonly modelBaseUrl: string }
  | { readonly type: "transcribe"; readonly id: number; readonly samples: Float32Array };

export type DictationWorkerResponse =
  | { readonly type: "progress"; readonly loaded: number }
  | { readonly type: "loaded" }
  | { readonly type: "text"; readonly id: number; readonly text: string }
  | { readonly type: "failed"; readonly id: number | null; readonly message: string };

/** The model stays loaded this long after the last transcription, then its memory is freed. */
const IDLE_UNLOAD_MS = 5 * 60_000;

interface Session {
  readonly worker: Worker;
  readonly loaded: Promise<void>;
  isLoaded: boolean;
  readonly progressListeners: Set<(loaded: number) => void>;
  readonly pending: Map<number, { resolve(text: string): void; reject(error: Error): void }>;
}

let session: Session | null = null;
let nextRequestId = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function send(
  worker: Worker,
  request: DictationWorkerRequest,
  transfer: Transferable[] = [],
): void {
  worker.postMessage(request, transfer);
}

function touch(): void {
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = setTimeout(closeDictationModel, IDLE_UNLOAD_MS);
}

/** Whether the model is already in memory, so dictation can transcribe at once. */
export function isDictationModelLoaded(): boolean {
  return session?.isLoaded ?? false;
}

/**
 * Loads the model from `modelBaseUrl` (the environment's signed copy), once per
 * page. `onProgress` hears how much of it has been fetched, from 0 to 1.
 */
export function loadDictationModel(
  modelBaseUrl: string,
  onProgress: (loaded: number) => void,
): Promise<void> {
  touch();
  if (session) {
    if (!session.isLoaded) {
      const current = session;
      current.progressListeners.add(onProgress);
      void current.loaded.then(
        () => current.progressListeners.delete(onProgress),
        () => current.progressListeners.delete(onProgress),
      );
    }
    return session.loaded;
  }
  // Created on first use only, so neither the worker nor the model touch startup.
  const worker = new Worker(new URL("./dictationModel.worker.ts", import.meta.url), {
    type: "module",
    name: "dictation-model",
  });
  const pending: Session["pending"] = new Map();
  const progressListeners = new Set([onProgress]);
  let resolve = () => {};
  let reject: (error: Error) => void = () => {};
  const loaded = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  // A failed load surfaces through the caller; this keeps it from being unhandled meanwhile.
  loaded.catch(() => {});
  const created: Session = { worker, loaded, isLoaded: false, progressListeners, pending };
  const fail = (error: Error) => {
    reject(error);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    if (session === created) closeDictationModel();
  };
  worker.addEventListener("message", ({ data }: MessageEvent<DictationWorkerResponse>) => {
    if (data.type === "progress") {
      for (const listener of progressListeners) listener(data.loaded);
    } else if (data.type === "loaded") {
      created.isLoaded = true;
      progressListeners.clear();
      resolve();
    } else if (data.type === "text") {
      pending.get(data.id)?.resolve(data.text);
      pending.delete(data.id);
    } else if (data.id === null) {
      fail(new Error(data.message));
    } else {
      pending.get(data.id)?.reject(new Error(data.message));
      pending.delete(data.id);
    }
  });
  worker.addEventListener("error", (event) => {
    fail(new Error(event.message || "The dictation worker stopped."));
  });
  send(worker, { type: "load", modelBaseUrl });
  session = created;
  return loaded;
}

/** Transcribes 16 kHz mono audio. Requests run in order on one worker. */
export async function transcribeDictation(samples: Float32Array): Promise<string> {
  touch();
  const current = session;
  if (!current) throw new Error("The dictation model is not loaded.");
  await current.loaded;
  return new Promise((resolve, reject) => {
    const id = (nextRequestId += 1);
    current.pending.set(id, { resolve, reject });
    send(current.worker, { type: "transcribe", id, samples }, [samples.buffer]);
  });
}

/** Stops the worker and frees the model's memory. */
export function closeDictationModel(): void {
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = null;
  if (!session) return;
  const closing = session;
  session = null;
  closing.worker.terminate();
  const error = new Error("The dictation model was unloaded.");
  for (const request of closing.pending.values()) request.reject(error);
}
