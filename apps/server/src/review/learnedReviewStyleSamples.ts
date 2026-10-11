/**
 * The samples an account's review style is learned from: its own recent review writing on
 * GitHub, read from one GraphQL answer and filtered down to text worth imitating. Pure.
 */
import type { LearnedReviewStyleSample, LearnedReviewStyleSampleState } from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

export const LEARNED_REVIEW_STYLE_MAX_SAMPLES = 40;
export const LEARNED_REVIEW_STYLE_MAX_SAMPLE_CHARS = 1_500;

/**
 * The viewer's latest review contributions, each with its own text and its comments on lines.
 * Contributions cover the past year, newest first, and only repositories the token can see.
 */
export const LEARNED_REVIEW_STYLE_QUERY = `query LearnedReviewStyle {
  viewer {
    login
    contributionsCollection {
      pullRequestReviewContributions(first: 50, orderBy: { direction: DESC }) {
        nodes {
          pullRequestReview {
            body
            state
            createdAt
            comments(first: 20) { nodes { body createdAt } }
          }
        }
      }
    }
  }
}`;

const Comment = Schema.Struct({ body: Schema.String, createdAt: Schema.String });
const Review = Schema.Struct({
  body: Schema.String,
  state: Schema.String,
  createdAt: Schema.String,
  comments: Schema.Struct({ nodes: Schema.Array(Schema.NullOr(Comment)) }),
});
const decodeAnswer = decodeJsonResult(
  Schema.Struct({
    data: Schema.Struct({
      viewer: Schema.Struct({
        login: Schema.String,
        contributionsCollection: Schema.Struct({
          pullRequestReviewContributions: Schema.Struct({
            nodes: Schema.Array(
              Schema.NullOr(Schema.Struct({ pullRequestReview: Schema.NullOr(Review) })),
            ),
          }),
        }),
      }),
    }),
  }),
);

export interface LearnedReviewStyleCandidate extends LearnedReviewStyleSample {
  readonly createdAt: string;
}

const STATES: Record<string, LearnedReviewStyleSampleState> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes-requested",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
};

/**
 * The login GitHub answered as and every review text and line comment in its answer, or null
 * for an answer that is not one. Pending reviews are left out: nobody has read them.
 */
export function parseLearnedReviewStyleAnswer(stdout: string): {
  readonly login: string;
  readonly candidates: ReadonlyArray<LearnedReviewStyleCandidate>;
} | null {
  const decoded = decodeAnswer(stdout);
  if (Result.isFailure(decoded)) return null;
  const { viewer } = decoded.success.data;
  const candidates: Array<LearnedReviewStyleCandidate> = [];
  for (const node of viewer.contributionsCollection.pullRequestReviewContributions.nodes) {
    const review = node?.pullRequestReview;
    const state = review === null || review === undefined ? undefined : STATES[review.state];
    if (review === null || review === undefined || state === undefined) continue;
    candidates.push({ kind: "summary", state, text: review.body, createdAt: review.createdAt });
    for (const comment of review.comments.nodes) {
      if (comment !== null) {
        candidates.push({
          kind: "inline",
          state,
          text: comment.body,
          createdAt: comment.createdAt,
        });
      }
    }
  }
  return { login: viewer.login, candidates };
}

/** Says nothing about how someone writes once punctuation and emoji are gone. */
const TRIVIAL = new Set([
  "",
  "1",
  "lgtm",
  "lgtm thanks",
  "lgtm thank you",
  "looks good",
  "looks good to me",
  "ship it",
  "approve",
  "approved",
  "thanks",
  "thank you",
  "nice",
  "done",
  "ok",
]);

/** Text a tool wrote or a bot is meant to read, not the user's own words. */
const MACHINE_TEXT = [
  /<!--/,
  /\[bot\]/i,
  /\b(generated|posted|written) (by|with)\b/i,
  // Slash commands (`/lgtm`, `/retest`) and bot mentions (`@dependabot rebase`).
  /^\s*\/[a-z][\w-]*(\s|$)/i,
  /^\s*@[\w-]*(bot|ai)\b/i,
];

function trimSample(text: string): string {
  if (text.length <= LEARNED_REVIEW_STYLE_MAX_SAMPLE_CHARS) return text;
  const cut = text.slice(0, LEARNED_REVIEW_STYLE_MAX_SAMPLE_CHARS - 1);
  const space = cut.search(/\s\S*$/);
  return `${(space > LEARNED_REVIEW_STYLE_MAX_SAMPLE_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * The samples worth imitating, newest first: no empty, approval-only or machine-written text,
 * no repeats, each cut to a bounded length.
 */
export function selectLearnedReviewStyleSamples(
  candidates: ReadonlyArray<LearnedReviewStyleCandidate>,
): ReadonlyArray<LearnedReviewStyleSample> {
  const seen = new Set<string>();
  const samples: Array<LearnedReviewStyleSample> = [];
  const newestFirst = candidates.toSorted(
    (left, right) => (Date.parse(right.createdAt) || 0) - (Date.parse(left.createdAt) || 0),
  );
  for (const { kind, state, text: raw } of newestFirst) {
    const text = raw.replace(/\r\n/g, "\n").trim();
    const words = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (TRIVIAL.has(words) || MACHINE_TEXT.some((pattern) => pattern.test(text))) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    samples.push({ kind, state, text: trimSample(text) });
    if (samples.length === LEARNED_REVIEW_STYLE_MAX_SAMPLES) break;
  }
  return samples;
}
