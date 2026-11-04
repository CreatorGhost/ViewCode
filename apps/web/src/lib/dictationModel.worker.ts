// Dictation's speech-to-text model, Moonshine base, on ONNX Runtime's WASM
// backend, off the UI thread. See dictationModel.ts for the page side.
import { env as transformersEnv, pipeline } from "@huggingface/transformers";
// Emitted with the app (vite.config.ts aliases the runtime's dist folder), so
// nothing is fetched from a CDN and dictation works offline.
import ortWasmGlueUrl from "onnxruntime-web-dist/ort-wasm-simd-threaded.mjs?url";
import ortWasmUrl from "onnxruntime-web-dist/ort-wasm-simd-threaded.wasm?url";

import { DICTATION_SAMPLE_RATE } from "./dictationAudio";
import type { DictationWorkerRequest, DictationWorkerResponse } from "./dictationModel";

const MODEL_ID = "onnx-community/moonshine-base-ONNX";
const HUB_PREFIX = `https://huggingface.co/${MODEL_ID}/resolve/`;
// The paper's guard against runaway repetition is 6 tokens per second of audio;
// the floor keeps a one-word clip from getting none.
const TOKENS_PER_SECOND = 6.5;
const MIN_NEW_TOKENS = 8;

const scope = self as unknown as {
  postMessage(message: DictationWorkerResponse): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<DictationWorkerRequest>) => void,
  ): void;
  fetch: typeof fetch;
};

// The environment serves the model it downloaded; this worker never reaches
// Hugging Face. Transformers.js asks for hub URLs, which are rewritten to the
// environment's signed model URL.
let modelBaseUrl = "";
const nativeFetch = scope.fetch.bind(scope);
scope.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith(HUB_PREFIX)) return nativeFetch(input, init);
  // `<revision>/<path inside the model>`
  const path = url.slice(HUB_PREFIX.length).split("/").slice(1).join("/");
  return nativeFetch(`${modelBaseUrl}/${path}`, init);
};
transformersEnv.allowLocalModels = false;
// The environment keeps the files; a browser copy would store them twice.
transformersEnv.useBrowserCache = false;
const wasm = transformersEnv.backends.onnx.wasm;
if (wasm) wasm.wasmPaths = { mjs: ortWasmGlueUrl, wasm: ortWasmUrl };

type Recognizer = (
  audio: Float32Array,
  options: { readonly max_new_tokens: number },
) => Promise<{ readonly text: string } | ReadonlyArray<{ readonly text: string }>>;

let recognizer: Promise<Recognizer> | null = null;

function reply(message: DictationWorkerResponse): void {
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- A worker posts to its page, which has no origin to name.
  scope.postMessage(message);
}

function load(): Promise<Recognizer> {
  // Bytes fetched per file; the total grows as each file starts.
  const files = new Map<string, { loaded: number; total: number }>();
  return pipeline("automatic-speech-recognition", MODEL_ID, {
    device: "wasm",
    dtype: "q8",
    progress_callback: (info) => {
      if (info.status !== "progress") return;
      files.set(info.file, { loaded: info.loaded, total: info.total });
      let loaded = 0;
      let total = 0;
      for (const file of files.values()) {
        loaded += file.loaded;
        total += file.total;
      }
      if (total > 0) reply({ type: "progress", loaded: loaded / total });
    },
  }) as unknown as Promise<Recognizer>;
}

scope.addEventListener("message", ({ data: request }) => {
  if (request.type === "load") {
    modelBaseUrl = request.modelBaseUrl;
    recognizer ??= load();
    recognizer.then(
      () => reply({ type: "loaded" }),
      (error: unknown) => {
        recognizer = null;
        reply({ type: "failed", id: null, message: errorMessage(error) });
      },
    );
    return;
  }
  if (!recognizer) {
    reply({ type: "failed", id: request.id, message: "The dictation model is not loaded." });
    return;
  }
  const seconds = request.samples.length / DICTATION_SAMPLE_RATE;
  recognizer
    .then((recognize) =>
      recognize(request.samples, {
        max_new_tokens: Math.max(MIN_NEW_TOKENS, Math.ceil(seconds * TOKENS_PER_SECOND)),
      }),
    )
    .then(
      (output) => {
        const text = Array.isArray(output)
          ? output.map((each) => each.text).join(" ")
          : (output as { readonly text: string }).text;
        reply({ type: "text", id: request.id, text });
      },
      (error: unknown) => reply({ type: "failed", id: request.id, message: errorMessage(error) }),
    );
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
