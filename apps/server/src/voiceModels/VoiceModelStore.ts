// @effect-diagnostics nodeBuiltinImport:off - Effect has no incremental digest.
import {
  DICTATION_MODEL_KEY,
  VOICE_MODEL_TIERS,
  VoiceModelError,
  type VoiceModelDownloadState,
  type VoiceModelKey,
  type VoiceModelRemoveInput,
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
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as NodeCrypto from "node:crypto";

import { ServerConfig } from "../config.ts";

/**
 * Where the natural read-aloud voice (Kokoro-82M) and dictation's speech model
 * (Moonshine base) are mirrored, one release each. Published by
 * .github/workflows/voice-models.yml; managed networks that block Hugging Face
 * usually allow GitHub. Hugging Face stays the fallback for each file.
 */
const VOICE_MODEL_RELEASE_URL =
  "https://github.com/CreatorGhost/ViewCode/releases/download/voice-models-v1";
const DICTATION_MODEL_RELEASE_URL =
  "https://github.com/CreatorGhost/ViewCode/releases/download/dictation-models-v1";
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
  /** Files by model key: `small`, `medium` and `large` for the voice, `dictation` for dictation. */
  tiers: Schema.Record(Schema.String, TierFiles),
});
type Manifest = typeof Manifest.Type;
const decodeManifest = Schema.decodeEffect(Schema.fromJsonString(Manifest));
const CompleteRecord = Schema.Struct({ revision: Schema.String, bytes: Schema.Int });
const CompleteRecordJson = Schema.fromJsonString(CompleteRecord);
const decodeCompleteRecord = Schema.decodeEffect(CompleteRecordJson);
const encodeCompleteRecord = Schema.encodeEffect(CompleteRecordJson);
const isVoiceModelError = Schema.is(VoiceModelError);

type ModelKind = NonNullable<VoiceModelRemoveInput["kind"]>;

/** What differs between the read-aloud voice and the dictation model. */
const MODEL_KINDS: Record<
  ModelKind,
  {
    /** The directory under `models/` that holds this kind's downloads. */
    readonly root: string;
    /** In the user's words, for messages. */
    readonly noun: string;
    readonly unpublished: string;
  }
> = {
  "read-aloud": {
    root: "kokoro",
    noun: "voice",
    unpublished:
      "The natural voice hasn't been published to ViewCode's GitHub release yet, so there is nothing to download. The system voice reads until it is.",
  },
  dictation: {
    root: "dictation",
    noun: "dictation model",
    unpublished:
      "The dictation model hasn't been published to ViewCode's GitHub release yet, so there is nothing to download.",
  },
};

const kindOf = (key: VoiceModelKey): ModelKind =>
  key === DICTATION_MODEL_KEY ? "dictation" : "read-aloud";
const keysOf = (kind: ModelKind): ReadonlyArray<VoiceModelKey> =>
  kind === "dictation" ? [DICTATION_MODEL_KEY] : VOICE_MODEL_TIERS;
const MODEL_KEYS: ReadonlyArray<VoiceModelKey> = [...VOICE_MODEL_TIERS, DICTATION_MODEL_KEY];

/** A model's files, served to clients through the `voice-model` asset. */
export function voiceModelDirectory(path: Path.Path, stateDir: string, key: VoiceModelKey): string {
  return key === DICTATION_MODEL_KEY
    ? path.join(stateDir, "models", MODEL_KINDS.dictation.root, "moonshine-base")
    : path.join(stateDir, "models", MODEL_KINDS["read-aloud"].root, key);
}

interface VoiceModelStoreService {
  readonly state: Effect.Effect<VoiceModelsState>;
  readonly changes: Stream.Stream<VoiceModelsState>;
  /**
   * Starts downloading a model. A read-aloud tier replaces any other tier's
   * download; the dictation model downloads beside them.
   */
  readonly download: (key: VoiceModelKey) => Effect.Effect<VoiceModelsState>;
  readonly cancel: (key: VoiceModelKey) => Effect.Effect<VoiceModelsState>;
  /** Deletes every downloaded read-aloud tier, or the dictation model. */
  readonly remove: (kind: ModelKind) => Effect.Effect<VoiceModelsState, VoiceModelError>;
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
  readonly dictationReleaseUrl?: string;
}

const absent = (totalBytes: number | null = null): VoiceModelDownloadState => ({
  phase: "absent",
  downloadedBytes: 0,
  totalBytes,
  message: null,
});

const initialState = (): VoiceModelsState => ({
  tiers: VOICE_MODEL_TIERS.map((tier) => ({ tier, ...absent() })),
  dictation: absent(),
});

function modelState(state: VoiceModelsState, key: VoiceModelKey): VoiceModelDownloadState {
  if (key === DICTATION_MODEL_KEY) return state.dictation ?? absent();
  const { tier: _tier, ...rest } = state.tiers.find((each) => each.tier === key) ?? {
    tier: key,
    ...absent(),
  };
  return rest;
}

function withModelState(
  state: VoiceModelsState,
  key: VoiceModelKey,
  update: (current: VoiceModelDownloadState) => VoiceModelDownloadState,
): VoiceModelsState {
  if (key === DICTATION_MODEL_KEY) {
    return { ...state, dictation: update(state.dictation ?? absent()) };
  }
  return {
    ...state,
    tiers: state.tiers.map((each) => {
      if (each.tier !== key) return each;
      const { tier, ...rest } = each;
      return { tier, ...update(rest) };
    }),
  };
}

export const makeVoiceModelStore = Effect.fn("VoiceModelStore.make")(function* (
  options: VoiceModelStoreOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  const serviceScope = yield* Effect.scope;
  const releaseUrls: Record<ModelKind, string> = {
    "read-aloud": options.releaseUrl ?? VOICE_MODEL_RELEASE_URL,
    dictation: options.dictationReleaseUrl ?? DICTATION_MODEL_RELEASE_URL,
  };
  const kindRoot = (kind: ModelKind) =>
    path.join(options.stateDir, "models", MODEL_KINDS[kind].root);
  const modelDirectory = (key: VoiceModelKey) => voiceModelDirectory(path, options.stateDir, key);
  const gate = yield* Semaphore.make(1);
  // One download per kind: a read-aloud tier never waits on dictation's model.
  const running = new Map<
    ModelKind,
    { readonly id: symbol; readonly key: VoiceModelKey; readonly fiber: Fiber.Fiber<void> }
  >();

  const state = yield* SubscriptionRef.make<VoiceModelsState>(initialState());
  const updateModel = (
    key: VoiceModelKey,
    update: (current: VoiceModelDownloadState) => VoiceModelDownloadState,
  ) => SubscriptionRef.update(state, (current) => withModelState(current, key, update));
  const currentModelState = (key: VoiceModelKey) =>
    SubscriptionRef.get(state).pipe(Effect.map((current) => modelState(current, key)));

  // A 404 means the release exists without the files (or not at all): the
  // mirror workflow has not run. Saying "can't reach GitHub" then sends the
  // user chasing a network problem they don't have.
  const fetchManifest = Effect.fn("VoiceModelStore.fetchManifest")(function* (kind: ModelKind) {
    const releaseUrl = releaseUrls[kind];
    const { noun } = MODEL_KINDS[kind];
    const unreachable = new VoiceModelError({
      detail: `Couldn't reach ViewCode's GitHub release for the ${noun}. Check that the computer running ViewCode can reach github.com, then try again.`,
    });
    const response = yield* http.execute(HttpClientRequest.get(`${releaseUrl}/manifest.json`)).pipe(
      Effect.timeout(MANIFEST_TIMEOUT),
      Effect.tapError((cause) =>
        Effect.logWarning("Could not reach the voice model release.", { cause }),
      ),
      Effect.mapError(() => unreachable),
    );
    if (response.status === 404) {
      return yield* new VoiceModelError({ detail: MODEL_KINDS[kind].unpublished });
    }
    if (response.status < 200 || response.status >= 300) {
      yield* Effect.logWarning("The voice model release refused the request.", {
        status: response.status,
      });
      return yield* unreachable;
    }
    return yield* response.text.pipe(
      Effect.flatMap(decodeManifest),
      Effect.timeout(MANIFEST_TIMEOUT),
      Effect.tapError((cause) =>
        Effect.logWarning("Could not read the voice model manifest.", { cause }),
      ),
      Effect.mapError(
        () =>
          new VoiceModelError({
            detail: `ViewCode's GitHub release answered, but its list of ${noun} files couldn't be read. Try again later.`,
          }),
      ),
    );
  });

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
    function* (key: VoiceModelKey) {
      const kind = kindOf(key);
      const { noun } = MODEL_KINDS[kind];
      const releaseUrl = releaseUrls[kind];
      const manifest: Manifest = yield* fetchManifest(kind);
      const files = manifest.tiers[key];
      if (!files) return yield* new VoiceModelError({ detail: MODEL_KINDS[kind].unpublished });
      const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
      yield* updateModel(key, (current) => ({ ...current, totalBytes }));
      const root = kindRoot(kind);
      yield* fs.makeDirectory(root, { recursive: true });
      const staging = yield* fs.makeTempDirectoryScoped({ directory: root, prefix: `.${key}-` });
      const model = path.join(staging, "model");
      let completedBytes = 0;
      let fileBytes = 0;
      let reportedAt = 0;
      const report = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (now - reportedAt < PROGRESS_INTERVAL_MS) return;
        reportedAt = now;
        yield* updateModel(key, (current) => ({
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
              model: key,
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
              model: key,
              file: file.path,
              cause,
            }),
          ),
          Effect.mapError(
            () =>
              new VoiceModelError({
                detail: `Couldn't download the ${noun} from ViewCode's GitHub release or Hugging Face. Check the network of the computer running ViewCode, then try again.`,
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
      const destination = modelDirectory(key);
      yield* fs.remove(destination, { recursive: true, force: true });
      yield* fs.rename(model, destination);
      yield* updateModel(key, () => ({
        phase: "ready",
        downloadedBytes: totalBytes,
        totalBytes,
        message: null,
      }));
    },
    Effect.scoped,
    (effect, key) =>
      Effect.mapError(effect, (cause) =>
        isVoiceModelError(cause)
          ? cause
          : new VoiceModelError({
              detail: `Couldn't save the ${MODEL_KINDS[kindOf(key)].noun}. Check free disk space, then try again.`,
            }),
      ),
  );

  const download: VoiceModelStoreService["download"] = (key) =>
    gate
      .withPermit(
        Effect.gen(function* () {
          const current = yield* currentModelState(key);
          if (current.phase === "ready" || current.phase === "downloading") {
            return yield* SubscriptionRef.get(state);
          }
          const kind = kindOf(key);
          const previous = running.get(kind);
          if (previous) yield* Fiber.interrupt(previous.fiber);
          yield* updateModel(key, (value) => ({
            ...value,
            phase: "downloading",
            downloadedBytes: 0,
            message: null,
          }));
          const id = Symbol(key);
          const work = install(key).pipe(
            Effect.onExit((exit) =>
              Exit.isFailure(exit)
                ? updateModel(key, (value) => {
                    if (value.phase === "ready") return value;
                    if (Cause.hasInterruptsOnly(exit.cause)) return absent(value.totalBytes);
                    const error = Cause.findErrorOption(exit.cause);
                    return {
                      ...value,
                      phase: "failed",
                      message: Option.isSome(error)
                        ? error.value.detail
                        : `Couldn't download the ${MODEL_KINDS[kind].noun}. Try again.`,
                    };
                  })
                : Effect.void,
            ),
            Effect.ignoreCause,
            Effect.ensuring(
              Effect.sync(() => {
                if (running.get(kind)?.id === id) running.delete(kind);
              }),
            ),
          );
          const fiber = yield* Effect.forkIn(Effect.interruptible(work), serviceScope);
          running.set(kind, { id, key, fiber });
          return yield* SubscriptionRef.get(state);
        }),
      )
      .pipe(Effect.uninterruptible);

  const cancel: VoiceModelStoreService["cancel"] = (key) =>
    gate.withPermit(
      Effect.gen(function* () {
        const current = running.get(kindOf(key));
        if (current?.key === key) yield* Fiber.interrupt(current.fiber);
        return yield* SubscriptionRef.get(state);
      }),
    );

  const remove: VoiceModelStoreService["remove"] = (kind) =>
    gate
      .withPermit(
        Effect.gen(function* () {
          const current = running.get(kind);
          if (current) yield* Fiber.interrupt(current.fiber);
          yield* fs.remove(kindRoot(kind), { recursive: true, force: true });
          for (const key of keysOf(kind)) yield* updateModel(key, () => absent());
          return yield* SubscriptionRef.get(state);
        }),
      )
      .pipe(
        Effect.uninterruptible,
        Effect.mapError(
          () =>
            new VoiceModelError({
              detail:
                kind === "dictation"
                  ? "Couldn't remove the dictation model. Stop dictating, then try again."
                  : "Couldn't remove the downloaded voice. Stop reading aloud, then try again.",
            }),
        ),
      );

  // Models finished in an earlier run are ready; a download cut short by a
  // crash leaves only its dot-prefixed staging directory, removed here.
  for (const kind of ["read-aloud", "dictation"] as const) {
    const root = kindRoot(kind);
    for (const entry of yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []))) {
      if (entry.startsWith(".")) {
        yield* fs
          .remove(path.join(root, entry), { recursive: true, force: true })
          .pipe(Effect.ignore);
      }
    }
  }
  for (const key of MODEL_KEYS) {
    const record = yield* fs
      .readFileString(path.join(modelDirectory(key), VOICE_MODEL_COMPLETE_RECORD))
      .pipe(Effect.flatMap(decodeCompleteRecord), Effect.option);
    if (Option.isSome(record)) {
      const bytes = record.value.bytes;
      yield* updateModel(key, () => ({
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
