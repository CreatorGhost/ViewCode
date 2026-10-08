// @effect-diagnostics nodeBuiltinImport:off - Effect has no incremental digest.
import {
  VOICE_MODEL_TIERS,
  VoiceModelError,
  type VoiceModelTier,
  type VoiceModelTierState,
  type VoiceModelsState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import * as NodeCrypto from "node:crypto";

import { ServerConfig } from "../config.ts";

/**
 * Where the natural read-aloud voice (Kokoro-82M) is mirrored. Published by
 * .github/workflows/voice-models.yml; managed networks that block Hugging Face
 * usually allow GitHub. Hugging Face stays the fallback for each file.
 */
export const VOICE_MODEL_RELEASE_URL =
  "https://github.com/CreatorGhost/ViewCode/releases/download/voice-models-v1";
/** Written last into a tier's directory: its presence means every file was verified. */
export const VOICE_MODEL_COMPLETE_RECORD = ".complete.json";
const FILE_TIMEOUT = "30 minutes";
const MANIFEST_TIMEOUT = "1 minute";
const PROGRESS_INTERVAL_MS = 250;

/**
 * A path inside the model repository, e.g. `onnx/model.onnx` or
 * `voices/af_heart.bin`. No segment may start with a dot, so no path leaves
 * the tier's directory or reaches its completion record.
 */
export const VOICE_MODEL_FILE_PATH_PATTERN =
  /^(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)?[A-Za-z0-9_-][A-Za-z0-9_.-]*$/u;
const ModelFilePath = Schema.String.check(Schema.isPattern(VOICE_MODEL_FILE_PATH_PATTERN));
const ManifestFile = Schema.Struct({
  path: ModelFilePath,
  size: Schema.Int.check(Schema.isGreaterThan(0)),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
});
type ManifestFile = typeof ManifestFile.Type;
const TierFiles = Schema.Array(ManifestFile).check(Schema.isMinLength(1));
const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  source: Schema.Struct({
    repo: Schema.String.check(Schema.isPattern(/^[\w.-]+\/[\w.-]+$/u)),
    revision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
  }),
  tiers: Schema.Struct({ small: TierFiles, medium: TierFiles, large: TierFiles }),
});
type Manifest = typeof Manifest.Type;
const decodeManifest = Schema.decodeEffect(Schema.fromJsonString(Manifest));
const CompleteRecord = Schema.Struct({ revision: Schema.String, bytes: Schema.Int });
const CompleteRecordJson = Schema.fromJsonString(CompleteRecord);
const decodeCompleteRecord = Schema.decodeEffect(CompleteRecordJson);
const encodeCompleteRecord = Schema.encodeEffect(CompleteRecordJson);
const isVoiceModelError = Schema.is(VoiceModelError);

/** A tier's files, served to clients through the `voice-model` asset. */
export function voiceModelTierDirectory(
  path: Path.Path,
  stateDir: string,
  tier: VoiceModelTier,
): string {
  return path.join(stateDir, "models", "kokoro", tier);
}

interface VoiceModelStoreService {
  readonly state: Effect.Effect<VoiceModelsState>;
  readonly changes: Stream.Stream<VoiceModelsState>;
  /** Starts downloading a tier, replacing any other tier's download. */
  readonly download: (tier: VoiceModelTier) => Effect.Effect<VoiceModelsState>;
  readonly cancel: (tier: VoiceModelTier) => Effect.Effect<VoiceModelsState>;
  /** Deletes every downloaded tier. */
  readonly remove: Effect.Effect<VoiceModelsState, VoiceModelError>;
}

export class VoiceModelStore extends Context.Service<VoiceModelStore, VoiceModelStoreService>()(
  "t3/voiceModels/VoiceModelStore",
) {
  static readonly layer = Layer.effect(
    VoiceModelStore,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      return yield* makeVoiceModelStore({ stateDir: config.stateDir });
    }),
  );
}

export interface VoiceModelStoreOptions {
  readonly stateDir: string;
  readonly releaseUrl?: string;
}

const absent = (tier: VoiceModelTier, totalBytes: number | null = null): VoiceModelTierState => ({
  tier,
  phase: "absent",
  downloadedBytes: 0,
  totalBytes,
  message: null,
});

export const makeVoiceModelStore = Effect.fn("VoiceModelStore.make")(function* (
  options: VoiceModelStoreOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  const serviceScope = yield* Effect.scope;
  const releaseUrl = options.releaseUrl ?? VOICE_MODEL_RELEASE_URL;
  const root = path.dirname(voiceModelTierDirectory(path, options.stateDir, "small"));
  const tierDirectory = (tier: VoiceModelTier) =>
    voiceModelTierDirectory(path, options.stateDir, tier);
  const gate = yield* Semaphore.make(1);
  let running:
    | { readonly id: symbol; readonly tier: VoiceModelTier; readonly fiber: Fiber.Fiber<void> }
    | undefined;

  const state = yield* SubscriptionRef.make<VoiceModelsState>({
    tiers: VOICE_MODEL_TIERS.map((tier) => absent(tier)),
  });
  const updateTier = (
    tier: VoiceModelTier,
    update: (current: VoiceModelTierState) => VoiceModelTierState,
  ) =>
    SubscriptionRef.update(state, (current) => ({
      tiers: current.tiers.map((each) => (each.tier === tier ? update(each) : each)),
    }));
  const tierState = (tier: VoiceModelTier) =>
    SubscriptionRef.get(state).pipe(
      Effect.map((current) => current.tiers.find((each) => each.tier === tier) ?? absent(tier)),
    );

  const fetchManifest = http.execute(HttpClientRequest.get(`${releaseUrl}/manifest.json`)).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.text),
    Effect.flatMap(decodeManifest),
    Effect.timeout(MANIFEST_TIMEOUT),
    Effect.tapError((cause) =>
      Effect.logWarning("Could not read the voice model manifest.", { cause }),
    ),
    Effect.mapError(
      () =>
        new VoiceModelError({
          detail:
            "Couldn't reach ViewCode's GitHub release for the voice. Check that the computer running ViewCode can reach github.com, then try again.",
        }),
    ),
  );

  /** Streams one file to `destination`, rejecting it unless its size and SHA-256 match. */
  const fetchFile = Effect.fn("VoiceModelStore.fetchFile")(function* (
    url: string,
    file: ManifestFile,
    destination: string,
    onBytes: (bytes: number) => Effect.Effect<void>,
  ) {
    const hash = NodeCrypto.createHash("sha256");
    let received = 0;
    const response = yield* http
      .execute(HttpClientRequest.get(url))
      .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
    yield* response.stream.pipe(
      Stream.tap((chunk) =>
        Effect.gen(function* () {
          received += chunk.byteLength;
          if (received > file.size) {
            return yield* new VoiceModelError({ detail: `${file.path} is larger than expected.` });
          }
          hash.update(chunk);
          yield* onBytes(chunk.byteLength);
        }),
      ),
      Stream.run(fs.sink(destination, { flag: "w", mode: 0o644 })),
    );
    if (received !== file.size || hash.digest("hex") !== file.sha256) {
      return yield* new VoiceModelError({ detail: `${file.path} failed its SHA-256 check.` });
    }
  });

  const install = Effect.fn("VoiceModelStore.install")(
    function* (tier: VoiceModelTier) {
      const manifest: Manifest = yield* fetchManifest;
      const files = manifest.tiers[tier];
      const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
      yield* updateTier(tier, (current) => ({ ...current, totalBytes }));
      yield* fs.makeDirectory(root, { recursive: true });
      const staging = yield* fs.makeTempDirectoryScoped({ directory: root, prefix: `.${tier}-` });
      const model = path.join(staging, "model");
      let completedBytes = 0;
      let fileBytes = 0;
      let reportedAt = 0;
      const report = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (now - reportedAt < PROGRESS_INTERVAL_MS) return;
        reportedAt = now;
        yield* updateTier(tier, (current) => ({
          ...current,
          downloadedBytes: completedBytes + fileBytes,
        }));
      });
      for (const file of files) {
        const destination = path.join(model, ...file.path.split("/"));
        yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
        const attempt = (url: string) =>
          Effect.sync(() => {
            fileBytes = 0;
          }).pipe(
            Effect.andThen(
              fetchFile(url, file, destination, (bytes) =>
                Effect.suspend(() => {
                  fileBytes += bytes;
                  return report;
                }),
              ),
            ),
            Effect.timeout(FILE_TIMEOUT),
          );
        // Release assets are flat, so a file is published under its base name.
        yield* attempt(`${releaseUrl}/${path.basename(file.path)}`).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("Voice model file failed from GitHub; trying Hugging Face.", {
              file: file.path,
              cause,
            }),
          ),
          Effect.catch(() =>
            attempt(
              `https://huggingface.co/${manifest.source.repo}/resolve/${manifest.source.revision}/${file.path}`,
            ),
          ),
          Effect.tapError((cause) =>
            Effect.logWarning("Voice model file failed from every mirror.", {
              file: file.path,
              cause,
            }),
          ),
          Effect.mapError(
            () =>
              new VoiceModelError({
                detail:
                  "Couldn't download the voice from ViewCode's GitHub release or Hugging Face. Check the network of the computer running ViewCode, then try again.",
              }),
          ),
        );
        completedBytes += file.size;
        fileBytes = 0;
      }
      yield* fs.writeFileString(
        path.join(model, VOICE_MODEL_COMPLETE_RECORD),
        yield* encodeCompleteRecord({ revision: manifest.source.revision, bytes: totalBytes }),
      );
      const destination = tierDirectory(tier);
      yield* fs.remove(destination, { recursive: true, force: true });
      yield* fs.rename(model, destination);
      yield* updateTier(tier, () => ({
        tier,
        phase: "ready",
        downloadedBytes: totalBytes,
        totalBytes,
        message: null,
      }));
    },
    Effect.scoped,
    Effect.mapError((cause) =>
      isVoiceModelError(cause)
        ? cause
        : new VoiceModelError({
            detail: "Couldn't save the voice. Check free disk space, then try again.",
          }),
    ),
  );

  const download: VoiceModelStoreService["download"] = (tier) =>
    gate
      .withPermit(
        Effect.gen(function* () {
          const current = yield* tierState(tier);
          if (current.phase === "ready" || current.phase === "downloading") {
            return yield* SubscriptionRef.get(state);
          }
          if (running) yield* Fiber.interrupt(running.fiber);
          yield* updateTier(tier, (value) => ({
            ...value,
            phase: "downloading",
            downloadedBytes: 0,
            message: null,
          }));
          const id = Symbol(tier);
          const work = install(tier).pipe(
            Effect.onExit((exit) =>
              Exit.isFailure(exit)
                ? updateTier(tier, (value) => {
                    if (value.phase === "ready") return value;
                    if (Cause.hasInterruptsOnly(exit.cause)) return absent(tier, value.totalBytes);
                    const error = Cause.findErrorOption(exit.cause);
                    return {
                      ...value,
                      phase: "failed",
                      message: Option.isSome(error)
                        ? error.value.detail
                        : "Couldn't download the voice. Try again.",
                    };
                  })
                : Effect.void,
            ),
            Effect.ignoreCause,
            Effect.ensuring(
              Effect.sync(() => {
                if (running?.id === id) running = undefined;
              }),
            ),
          );
          const fiber = yield* Effect.forkIn(Effect.interruptible(work), serviceScope);
          running = { id, tier, fiber };
          return yield* SubscriptionRef.get(state);
        }),
      )
      .pipe(Effect.uninterruptible);

  const cancel: VoiceModelStoreService["cancel"] = (tier) =>
    gate.withPermit(
      Effect.gen(function* () {
        if (running?.tier === tier) yield* Fiber.interrupt(running.fiber);
        return yield* SubscriptionRef.get(state);
      }),
    );

  const remove: VoiceModelStoreService["remove"] = gate
    .withPermit(
      Effect.gen(function* () {
        if (running) yield* Fiber.interrupt(running.fiber);
        yield* fs.remove(root, { recursive: true, force: true });
        yield* SubscriptionRef.set(state, { tiers: VOICE_MODEL_TIERS.map((tier) => absent(tier)) });
        return yield* SubscriptionRef.get(state);
      }),
    )
    .pipe(
      Effect.uninterruptible,
      Effect.mapError(
        () =>
          new VoiceModelError({
            detail: "Couldn't remove the downloaded voice. Stop reading aloud, then try again.",
          }),
      ),
    );

  // Tiers finished in an earlier run are ready; a download cut short by a
  // crash leaves only its dot-prefixed staging directory, removed here.
  for (const entry of yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []))) {
    if (entry.startsWith(".")) {
      yield* fs
        .remove(path.join(root, entry), { recursive: true, force: true })
        .pipe(Effect.ignore);
    }
  }
  for (const tier of VOICE_MODEL_TIERS) {
    const record = yield* fs
      .readFileString(path.join(tierDirectory(tier), VOICE_MODEL_COMPLETE_RECORD))
      .pipe(Effect.flatMap(decodeCompleteRecord), Effect.option);
    if (Option.isSome(record)) {
      const bytes = record.value.bytes;
      yield* updateTier(tier, () => ({
        tier,
        phase: "ready",
        downloadedBytes: bytes,
        totalBytes: bytes,
        message: null,
      }));
    }
  }

  return VoiceModelStore.of({
    state: SubscriptionRef.get(state),
    changes: SubscriptionRef.changes(state),
    download,
    cancel,
    remove,
  });
});
