/**
 * Learned review styles: an account's own recent review writing, read from GitHub as that
 * account and kept in the state directory, one file per account. A reviewer whose findings will
 * be posted as that account reads the file and writes the way it does (see `ReviewPlaybook.ts`).
 * The samples go nowhere else; the user sees a few of them and how many there are.
 */
import {
  LearnedReviewStyleError,
  LearnedReviewStyleSample,
  type LearnedReviewStyle,
  type LearnedReviewStyleAccount,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import {
  LEARNED_REVIEW_STYLE_QUERY,
  parseLearnedReviewStyleAnswer,
  selectLearnedReviewStyleSamples,
} from "./learnedReviewStyleSamples.ts";

const LEARNED_DIR = "review-style";
/** How many samples the user is shown, and how much of each. */
const PREVIEW_SAMPLES = 5;
const PREVIEW_SAMPLE_CHARS = 280;
/** Fifty reviews of up to twenty comments; a comment can be long. */
const ANSWER_MAX_OUTPUT_BYTES = 8_000_000;

/** What a reviewer reads. Its fields are named in the playbook, so keep them stable. */
const LearnedReviewStyleFile = Schema.Struct({
  host: Schema.String,
  login: Schema.String,
  fetchedAt: Schema.String,
  samples: Schema.Array(LearnedReviewStyleSample),
});
type LearnedReviewStyleFile = typeof LearnedReviewStyleFile.Type;
const decodeFile = Schema.decodeUnknownOption(Schema.fromJsonString(LearnedReviewStyleFile));
const encodeFile = Schema.encodeSync(Schema.fromJsonString(LearnedReviewStyleFile));

/**
 * Where an account's samples live: `<stateDir>/review-style/<host>/<login>.json`, both
 * lowercased as hosts compare them. The contract's patterns keep both a single path segment.
 */
export const learnedReviewStylePath = (
  path: Path.Path,
  stateDir: string,
  account: LearnedReviewStyleAccount,
) =>
  path.join(
    stateDir,
    LEARNED_DIR,
    account.host.toLowerCase().replace(":", "_"),
    `${account.login.toLowerCase()}.json`,
  );

const readLearnedFile = (target: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(target))) return Option.none<LearnedReviewStyleFile>();
    return decodeFile(yield* fs.readFileString(target));
  });

/**
 * The samples file a reviewer should read for an account, or null when nothing was learned for
 * it. Never fails: a review starts without samples rather than not at all.
 */
export const findLearnedReviewStyleFile = Effect.fn("LearnedReviewStyles.find")(function* (input: {
  readonly stateDir: string;
  readonly account: LearnedReviewStyleAccount;
}) {
  const path = yield* Path.Path;
  const target = learnedReviewStylePath(path, input.stateDir, input.account);
  const file = yield* readLearnedFile(target).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not read the learned review style", { detail: error.message }).pipe(
        Effect.as(Option.none<LearnedReviewStyleFile>()),
      ),
    ),
  );
  return Option.isSome(file) && file.value.samples.length > 0 ? target : null;
});

const summarize = (file: LearnedReviewStyleFile): LearnedReviewStyle => ({
  sampleCount: file.samples.length,
  fetchedAt: file.fetchedAt,
  preview: file.samples.slice(0, PREVIEW_SAMPLES).map((sample) => ({
    ...sample,
    text:
      sample.text.length > PREVIEW_SAMPLE_CHARS
        ? `${sample.text.slice(0, PREVIEW_SAMPLE_CHARS - 1).trimEnd()}…`
        : sample.text,
  })),
});

export class LearnedReviewStyles extends Context.Service<
  LearnedReviewStyles,
  {
    /** What was learned for the account, or null when nothing was. */
    readonly status: (
      account: LearnedReviewStyleAccount,
    ) => Effect.Effect<LearnedReviewStyle | null, LearnedReviewStyleError>;
    /**
     * Reads the account's latest review writing from GitHub as that account, whichever account
     * gh has active, and replaces what was learned for it.
     */
    readonly learn: (
      account: LearnedReviewStyleAccount,
    ) => Effect.Effect<LearnedReviewStyle, LearnedReviewStyleError>;
    readonly forget: (
      account: LearnedReviewStyleAccount,
    ) => Effect.Effect<void, LearnedReviewStyleError>;
  }
>()("t3/review/LearnedReviewStyles") {}

const make = Effect.gen(function* () {
  const github = yield* GitHubCli.GitHubCli;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const storeFailure = (cause: unknown) => new LearnedReviewStyleError({ stage: "store", cause });
  const targetOf = (account: LearnedReviewStyleAccount) =>
    learnedReviewStylePath(path, config.stateDir, account);

  const status = Effect.fn("LearnedReviewStyles.status")(function* (
    account: LearnedReviewStyleAccount,
  ) {
    const file = yield* readLearnedFile(targetOf(account)).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.mapError(storeFailure),
    );
    return Option.isSome(file) ? summarize(file.value) : null;
  });

  const learn = Effect.fn("LearnedReviewStyles.learn")(function* (
    account: LearnedReviewStyleAccount,
  ) {
    const host = account.host.toLowerCase();
    const result = yield* github
      .executeAsAccount({
        cwd: config.stateDir,
        host,
        login: account.login,
        args: ["api", "graphql", "--hostname", host, "-f", `query=${LEARNED_REVIEW_STYLE_QUERY}`],
        maxOutputBytes: ANSWER_MAX_OUTPUT_BYTES,
      })
      .pipe(
        Effect.mapError((error) =>
          error._tag === "GitHubCliAuthenticationError"
            ? new LearnedReviewStyleError({ stage: "account", cause: error })
            : new LearnedReviewStyleError({ stage: "fetch", detail: error.detail, cause: error }),
        ),
      );
    const answer = parseLearnedReviewStyleAnswer(result.stdout);
    if (answer === null) {
      return yield* new LearnedReviewStyleError({
        stage: "fetch",
        detail: result.stdoutTruncated
          ? "GitHub's answer was too long to read."
          : "GitHub's answer could not be read.",
      });
    }
    // gh answers as GH_TOKEN when the server has one, whatever account is active.
    if (answer.login.toLowerCase() !== account.login.toLowerCase()) {
      return yield* new LearnedReviewStyleError({ stage: "account" });
    }
    const file: LearnedReviewStyleFile = {
      host,
      login: answer.login,
      fetchedAt: DateTime.formatIso(yield* DateTime.now),
      samples: selectLearnedReviewStyleSamples(answer.candidates),
    };
    // Reviews read the file while it is replaced, so the new one is swapped in by rename.
    const target = targetOf(account);
    yield* Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      const temporary = `${target}.${process.pid}.${(yield* Clock.currentTimeMillis).toString(36)}.tmp`;
      yield* fs.writeFileString(temporary, encodeFile(file));
      yield* fs.rename(temporary, target);
    }).pipe(Effect.mapError(storeFailure));
    return summarize(file);
  });

  const forget = Effect.fn("LearnedReviewStyles.forget")(function* (
    account: LearnedReviewStyleAccount,
  ) {
    yield* fs.remove(targetOf(account), { force: true }).pipe(Effect.mapError(storeFailure));
  });

  return LearnedReviewStyles.of({ status, learn, forget });
});

export const layer = Layer.effect(LearnedReviewStyles, make);
