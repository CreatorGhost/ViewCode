// @effect-diagnostics nodeBuiltinImport:off - randomUUID names temporary test fixtures.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type { VoiceModelTier, VoiceModelTierState } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as NodeCrypto from "node:crypto";

import {
  makeVoiceModelStore,
  VOICE_MODEL_COMPLETE_RECORD,
  type VoiceModelStore,
} from "./VoiceModelStore.ts";

const RELEASE = "https://github.test/releases/download/voice-models-v1";
const DICTATION_RELEASE = "https://github.test/releases/download/dictation-models-v1";
const REVISION = "a".repeat(40);
const DICTATION_REVISION = "b".repeat(40);
const HF = `https://huggingface.co/onnx-community/Kokoro/resolve/${REVISION}`;

const contents: Record<string, string> = {
  "config.json": "{}",
  "tokenizer.json": "tokenizer",
  "voices/af_heart.bin": "heart voice",
  "onnx/model_quantized.onnx": "small model bytes",
  "onnx/model_fp16.onnx": "medium model bytes",
  "onnx/model.onnx": "large model bytes",
};
const entry = (path: string) => ({
  path,
  size: Buffer.byteLength(contents[path]!),
  sha256: NodeCrypto.createHash("sha256").update(contents[path]!).digest("hex"),
});
const shared = ["config.json", "tokenizer.json", "voices/af_heart.bin"];
const manifest = JSON.stringify({
  version: 1,
  source: { repo: "onnx-community/Kokoro", revision: REVISION },
  license: "Apache-2.0",
  tiers: {
    small: [...shared, "onnx/model_quantized.onnx"].map(entry),
    medium: [...shared, "onnx/model_fp16.onnx"].map(entry),
    large: [...shared, "onnx/model.onnx"].map(entry),
  },
});
const smallBytes = [...shared, "onnx/model_quantized.onnx"].reduce(
  (sum, path) => sum + Buffer.byteLength(contents[path]!),
  0,
);

// Dictation's model has files named like the voice's; its own release keeps them apart.
const dictationContents: Record<string, string> = {
  "config.json": '{"model_type":"moonshine"}',
  "onnx/encoder_model_quantized.onnx": "encoder bytes",
  "onnx/decoder_model_merged_quantized.onnx": "decoder bytes",
};
const dictationManifest = JSON.stringify({
  version: 1,
  source: { repo: "onnx-community/moonshine-base-ONNX", revision: DICTATION_REVISION },
  license: "MIT",
  tiers: {
    dictation: Object.keys(dictationContents).map((path) => ({
      path,
      size: Buffer.byteLength(dictationContents[path]!),
      sha256: NodeCrypto.createHash("sha256").update(dictationContents[path]!).digest("hex"),
    })),
  },
});

/** Serves the manifest and every file from both mirrors unless `routes` says otherwise. */
const makeHarness = Effect.fn("test.makeVoiceModelStore")(function* (
  options: {
    readonly stateDir?: string;
    readonly routes?: (url: string) => { status: number; body: string } | "hang" | undefined;
    readonly requested?: Deferred.Deferred<void>;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stateDir = options.stateDir ?? (yield* fs.makeTempDirectoryScoped({ prefix: "t3-voice-" }));
  const requests: string[] = [];
  const defaultRoute = (url: string) => {
    if (url === `${RELEASE}/manifest.json`) return { status: 200, body: manifest };
    if (url === `${DICTATION_RELEASE}/manifest.json`) {
      return { status: 200, body: dictationManifest };
    }
    for (const [file, body] of Object.entries(contents)) {
      if (url === `${RELEASE}/${path.basename(file)}` || url === `${HF}/${file}`) {
        return { status: 200, body };
      }
    }
    for (const [file, body] of Object.entries(dictationContents)) {
      if (url === `${DICTATION_RELEASE}/${path.basename(file)}`) return { status: 200, body };
    }
    return { status: 404, body: "" };
  };
  const store = yield* makeVoiceModelStore({
    stateDir,
    releaseUrl: RELEASE,
    dictationReleaseUrl: DICTATION_RELEASE,
  }).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request.url);
          const route = options.routes?.(request.url) ?? defaultRoute(request.url);
          if (route === "hang") {
            if (options.requested) Deferred.doneUnsafe(options.requested, Effect.void);
            const response = HttpClientResponse.fromWeb(request, new Response(null));
            return Object.defineProperty(response, "stream", { value: Stream.never });
          }
          return HttpClientResponse.fromWeb(
            request,
            new Response(route.body, { status: route.status }),
          );
        }),
      ),
    ),
  );
  return { store, fs, path, stateDir, requests, root: path.join(stateDir, "models", "kokoro") };
});

const tierOf = (store: VoiceModelStore["Service"], tier: VoiceModelTier) =>
  store.state.pipe(Effect.map((state) => state.tiers.find((each) => each.tier === tier)!));

const dictationSettled = (store: VoiceModelStore["Service"]) =>
  store.changes.pipe(
    Stream.map((state) => state.dictation!),
    Stream.filter((state) => state.phase !== "downloading"),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

const settled = (store: VoiceModelStore["Service"], tier: VoiceModelTier) =>
  store.changes.pipe(
    Stream.map((state) => state.tiers.find((each) => each.tier === tier)!),
    Stream.filter((state: VoiceModelTierState) => state.phase !== "downloading"),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

it.layer(NodeServices.layer)("VoiceModelStore", (it) => {
  it.effect("downloads a tier from the GitHub release and verifies every file", () =>
    Effect.gen(function* () {
      const { store, fs, path, root, requests } = yield* makeHarness();
      const started = yield* store.download("small");
      expect(started.tiers.find((each) => each.tier === "small")?.phase).toBe("downloading");
      expect(yield* settled(store, "small")).toEqual({
        tier: "small",
        phase: "ready",
        downloadedBytes: smallBytes,
        totalBytes: smallBytes,
        message: null,
      });
      const directory = path.join(root, "small");
      expect(yield* fs.readFileString(path.join(directory, "onnx", "model_quantized.onnx"))).toBe(
        contents["onnx/model_quantized.onnx"],
      );
      expect(yield* fs.readFileString(path.join(directory, "voices", "af_heart.bin"))).toBe(
        contents["voices/af_heart.bin"],
      );
      expect(yield* fs.exists(path.join(directory, VOICE_MODEL_COMPLETE_RECORD))).toBe(true);
      // Only the finished tier remains; the staging directory is gone.
      expect(yield* fs.readDirectory(root)).toEqual(["small"]);
      expect(requests.every((url) => url.startsWith(RELEASE))).toBe(true);
      expect((yield* tierOf(store, "medium")).phase).toBe("absent");
    }),
  );

  it.effect("falls back to Hugging Face for a file the release cannot serve", () =>
    Effect.gen(function* () {
      const { store, requests } = yield* makeHarness({
        routes: (url) =>
          url === `${RELEASE}/tokenizer.json` ? { status: 503, body: "" } : undefined,
      });
      yield* store.download("small");
      expect((yield* settled(store, "small")).phase).toBe("ready");
      expect(requests).toContain(`${HF}/tokenizer.json`);
    }),
  );

  it.effect("rejects a file that fails its SHA-256 check on every mirror", () =>
    Effect.gen(function* () {
      const { store, fs, root } = yield* makeHarness({
        routes: (url) =>
          url.endsWith("model_quantized.onnx")
            ? { status: 200, body: "tampered bytes!!!" }
            : undefined,
      });
      yield* store.download("small");
      const failed = yield* settled(store, "small");
      expect(failed.phase).toBe("failed");
      expect(failed.message).toContain("Couldn't download the voice");
      expect(yield* fs.readDirectory(root)).toEqual([]);
    }),
  );

  it.effect("explains that GitHub is unreachable when the manifest cannot be read", () =>
    Effect.gen(function* () {
      const { store } = yield* makeHarness({
        routes: (url) => (url.endsWith("manifest.json") ? { status: 403, body: "" } : undefined),
      });
      yield* store.download("small");
      const failed = yield* settled(store, "small");
      expect(failed.phase).toBe("failed");
      expect(failed.message).toContain("github.com");
    }),
  );

  it.effect("says the voice is not published yet when the release has no manifest", () =>
    Effect.gen(function* () {
      const { store } = yield* makeHarness({
        routes: (url) => (url.endsWith("manifest.json") ? { status: 404, body: "" } : undefined),
      });
      yield* store.download("small");
      const failed = yield* settled(store, "small");
      expect(failed.phase).toBe("failed");
      expect(failed.message).toContain("hasn't been published");
      expect(failed.message).not.toContain("github.com");
    }),
  );

  it.effect("cancels a download and leaves nothing behind", () =>
    Effect.gen(function* () {
      const requested = yield* Deferred.make<void>();
      const { store, fs, root } = yield* makeHarness({
        requested,
        routes: (url) => (url.endsWith("model_quantized.onnx") ? "hang" : undefined),
      });
      yield* store.download("small");
      yield* Deferred.await(requested);
      const cancelled = yield* store.cancel("small");
      expect(cancelled.tiers.find((each) => each.tier === "small")).toMatchObject({
        phase: "absent",
        downloadedBytes: 0,
        totalBytes: smallBytes,
      });
      expect(yield* fs.readDirectory(root)).toEqual([]);
    }),
  );

  it.effect("starting another tier replaces the running download", () =>
    Effect.gen(function* () {
      const requested = yield* Deferred.make<void>();
      const { store } = yield* makeHarness({
        requested,
        routes: (url) => (url.endsWith("model_quantized.onnx") ? "hang" : undefined),
      });
      yield* store.download("small");
      yield* Deferred.await(requested);
      yield* store.download("medium");
      expect((yield* tierOf(store, "small")).phase).toBe("absent");
      expect((yield* settled(store, "medium")).phase).toBe("ready");
    }),
  );

  it.effect("finds tiers downloaded earlier and removes every tier", () =>
    Effect.gen(function* () {
      const first = yield* makeHarness();
      yield* first.store.download("large");
      expect((yield* settled(first.store, "large")).phase).toBe("ready");

      const { store, fs, root } = yield* makeHarness({ stateDir: first.stateDir });
      expect(yield* tierOf(store, "large")).toMatchObject({
        phase: "ready",
        totalBytes: expect.any(Number),
      });
      const removed = yield* store.remove("read-aloud");
      expect(removed.tiers.every((each) => each.phase === "absent")).toBe(true);
      expect(yield* fs.exists(root)).toBe(false);
    }),
  );

  it.effect("downloads the dictation model from its own release beside a voice download", () =>
    Effect.gen(function* () {
      const requested = yield* Deferred.make<void>();
      const { store, fs, path, stateDir, requests } = yield* makeHarness({
        requested,
        routes: (url) => (url === `${RELEASE}/model_quantized.onnx` ? "hang" : undefined),
      });
      yield* store.download("small");
      yield* Deferred.await(requested);
      yield* store.download("dictation");
      const ready = yield* dictationSettled(store);
      expect(ready).toMatchObject({ phase: "ready", message: null });
      // The voice's download kept running: kinds don't replace each other.
      expect((yield* tierOf(store, "small")).phase).toBe("downloading");
      const directory = path.join(stateDir, "models", "dictation", "moonshine-base");
      expect(yield* fs.readFileString(path.join(directory, "config.json"))).toBe(
        dictationContents["config.json"],
      );
      expect(requests).toContain(`${DICTATION_RELEASE}/encoder_model_quantized.onnx`);
    }),
  );

  it.effect("finds the dictation model downloaded earlier and removes it alone", () =>
    Effect.gen(function* () {
      const first = yield* makeHarness();
      yield* first.store.download("small");
      yield* first.store.download("dictation");
      expect((yield* settled(first.store, "small")).phase).toBe("ready");
      expect((yield* dictationSettled(first.store)).phase).toBe("ready");

      const { store, fs, path, root } = yield* makeHarness({ stateDir: first.stateDir });
      expect((yield* store.state).dictation?.phase).toBe("ready");
      const removed = yield* store.remove("dictation");
      expect(removed.dictation?.phase).toBe("absent");
      expect(removed.tiers.find((each) => each.tier === "small")?.phase).toBe("ready");
      expect(yield* fs.exists(path.join(root, "small"))).toBe(true);
    }),
  );

  it.effect("says the dictation model is not published when its release has no manifest", () =>
    Effect.gen(function* () {
      const { store } = yield* makeHarness({
        routes: (url) =>
          url === `${DICTATION_RELEASE}/manifest.json` ? { status: 404, body: "" } : undefined,
      });
      yield* store.download("dictation");
      const failed = yield* dictationSettled(store);
      expect(failed.phase).toBe("failed");
      expect(failed.message).toContain("dictation model hasn't been published");
    }),
  );
});
