// The natural read-aloud voice: Kokoro-82M on ONNX Runtime's WASM backend, off
// the UI thread. One worker loads one model tier; the page replaces the worker
// to switch tiers. See readAloudKokoro.ts for the page side.
import { env as transformersEnv } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";
// Emitted with the app (vite.config.ts aliases the runtime's dist folder), so
// nothing is fetched from a CDN and the voice works offline.
import ortWasmGlueUrl from "onnxruntime-web-dist/ort-wasm-simd-threaded.mjs?url";
import ortWasmUrl from "onnxruntime-web-dist/ort-wasm-simd-threaded.wasm?url";

import type { KokoroWorkerRequest, KokoroWorkerResponse } from "./readAloudKokoro";

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const HUB_PREFIX = `https://huggingface.co/${MODEL_ID}/resolve/`;
const DTYPE = { small: "q8", medium: "fp16", large: "fp32" } as const;

const scope = self as unknown as {
  postMessage(message: KokoroWorkerResponse, transfer?: Transferable[]): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<KokoroWorkerRequest>) => void,
  ): void;
  fetch: typeof fetch;
};

// The environment serves the model it downloaded; this worker never reaches
// Hugging Face. Transformers.js and kokoro-js (whose voice URLs are fixed) ask
// for hub URLs, which are rewritten to the environment's signed model URL.
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

let model: Promise<KokoroTTS> | null = null;

function reply(message: KokoroWorkerResponse, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}

scope.addEventListener("message", ({ data: request }) => {
  modelBaseUrl = request.modelBaseUrl;
  if (request.type === "load") {
    model ??= KokoroTTS.from_pretrained(MODEL_ID, { dtype: DTYPE[request.tier], device: "wasm" });
    model.then(
      () => reply({ type: "loaded" }),
      (error: unknown) => {
        model = null;
        reply({ type: "failed", id: null, message: errorMessage(error) });
      },
    );
    return;
  }
  if (!model) {
    reply({ type: "failed", id: request.id, message: "The voice is not loaded." });
    return;
  }
  model
    .then((tts) =>
      // kokoro-js rejects a voice it does not know.
      tts.generate(request.text, {
        voice: request.voice as keyof KokoroTTS["voices"],
        speed: request.speed,
      }),
    )
    .then(
      (audio) => {
        const samples = audio.audio;
        reply({ type: "audio", id: request.id, samples, sampleRate: audio.sampling_rate }, [
          samples.buffer,
        ]);
      },
      (error: unknown) => reply({ type: "failed", id: request.id, message: errorMessage(error) }),
    );
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
