import type {
  GitCommandError,
  GitConflictFile,
  GitConflictHunk,
  GitGraphCommit,
  GitGraphLane,
  GitPullRequestGraph,
  GitPullRequestGraphInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

/**
 * A pull request's branch as a small commit graph, read from the checkout's own refs: its commits
 * since it left the base, the base's commits since then, and where the two clash. Every read is
 * bounded, and nothing writes to the checkout: conflicts come from `git merge-tree`, which merges
 * in the object store only. No fetch either; `<remote>/<base>` is as fresh as the git status
 * poll's background fetch left it.
 */

const SHOWN_COMMITS = 12;
/** How far back the branch's own first-parent line is followed to find where it left the base. */
const OWN_COMMIT_SCAN = 200;
const CONFLICT_FILES = 20;
/** Conflicted files whose merged copy is read for counts and hunks; the rest count as one. */
const CONFLICT_FILES_READ = 8;
const HUNKS_PER_FILE = 3;
const HUNK_SIDE_LINES = 6;
const HUNK_LINE_CHARS = 160;
const UNRESOLVED_PATHS = 50;
const PAYLOAD_BUDGET_CHARS = 16 * 1024;
const GIT_TIMEOUT_MS = 10_000;

const FIELD = "\x1f";
const RECORD = "\x1e";
const LOG_FORMAT = `--format=${RECORD}%H${FIELD}%an${FIELD}%aI${FIELD}%P${FIELD}%D${FIELD}%s`;

interface ParsedCommit {
  readonly sha: string;
  readonly authorName: string;
  readonly authoredAt: string;
  readonly parents: ReadonlyArray<string>;
  readonly refs: ReadonlyArray<string>;
  readonly subject: string;
}

/** Branch names a log decoration lists, the remote's prefix dropped and duplicates folded. */
function parseDecorations(decoration: string, remote: string): ReadonlyArray<string> {
  const names = decoration
    .split(", ")
    .map((entry) => entry.trim().replace(/^HEAD -> /, ""))
    .filter((entry) => entry.length > 0 && entry !== "HEAD" && !entry.startsWith("tag: "))
    .map((entry) => (entry.startsWith(`${remote}/`) ? entry.slice(remote.length + 1) : entry))
    .filter((entry) => entry !== "HEAD");
  return [...new Set(names)];
}

function parseLog(stdout: string, remote: string): ReadonlyArray<ParsedCommit> {
  return stdout.split(RECORD).flatMap((record) => {
    const [sha, authorName, authoredAt, parents, decoration, ...subject] = record
      .replace(/\n+$/, "")
      .split(FIELD);
    if (sha === undefined || sha.trim().length === 0) return [];
    return [
      {
        sha: sha.trim(),
        authorName: authorName ?? "",
        authoredAt: authoredAt ?? "",
        parents: (parents ?? "").split(" ").filter((parent) => parent.length > 0),
        refs: parseDecorations(decoration ?? "", remote),
        subject: subject.join(FIELD),
      },
    ];
  });
}

/** The base commits on its first-parent line from `tip`; the rest came in from merged branches. */
function baseLanes(
  commits: ReadonlyArray<ParsedCommit>,
  tip: string,
): ReadonlyMap<string, GitGraphLane> {
  const bySha = new Map(commits.map((commit) => [commit.sha, commit]));
  const lanes = new Map<string, GitGraphLane>(commits.map((commit) => [commit.sha, "side"]));
  let cursor: string | undefined = tip;
  while (cursor !== undefined && bySha.has(cursor)) {
    lanes.set(cursor, "base");
    cursor = bySha.get(cursor)?.parents[0];
  }
  return lanes;
}

const clip = (line: string) =>
  line.length > HUNK_LINE_CHARS ? `${line.slice(0, HUNK_LINE_CHARS - 1)}…` : line;

/**
 * Conflict blocks in a file merged with conflict markers: how many, and the first few with the
 * head side ("ours") and the base side ("theirs"). A diff3 base section is skipped.
 */
function parseConflictMarkers(content: string): {
  readonly count: number;
  readonly hunks: ReadonlyArray<GitConflictHunk>;
} {
  let state: "outside" | "ours" | "ancestor" | "theirs" = "outside";
  let oursLine = 0;
  let count = 0;
  const hunks: Array<GitConflictHunk> = [];
  let current: { line: number; ours: Array<string>; theirs: Array<string> } | null = null;
  const keep = (side: Array<string>, line: string) => {
    if (side.length < HUNK_SIDE_LINES) side.push(clip(line));
  };
  for (const raw of content.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const marker = (prefix: string) => line === prefix || line.startsWith(`${prefix} `);
    switch (state) {
      case "outside":
        if (marker("<<<<<<<")) {
          state = "ours";
          count += 1;
          current = { line: oursLine + 1, ours: [], theirs: [] };
        } else {
          oursLine += 1;
        }
        break;
      case "ours":
        if (marker("|||||||")) state = "ancestor";
        else if (line === "=======") state = "theirs";
        else {
          oursLine += 1;
          if (current) keep(current.ours, line);
        }
        break;
      case "ancestor":
        if (line === "=======") state = "theirs";
        break;
      case "theirs":
        if (marker(">>>>>>>")) {
          state = "outside";
          if (current && hunks.length < HUNKS_PER_FILE) hunks.push(current);
          current = null;
        } else if (current) {
          keep(current.theirs, line);
        }
        break;
    }
  }
  return { count, hunks };
}

type FileTouches = ReadonlyMap<
  string,
  { readonly shas: ReadonlyArray<string>; readonly author: string }
>;

/** Each file's commits in a `--name-only` log, newest first, with the newest one's author. */
function parseFileTouches(stdout: string): FileTouches {
  const touches = new Map<string, { shas: Array<string>; author: string }>();
  for (const record of stdout.split(RECORD)) {
    const [header, ...paths] = record.split("\n");
    const [sha, author] = (header ?? "").split(FIELD);
    if (sha === undefined || sha.trim().length === 0) continue;
    for (const path of paths) {
      if (path.length === 0) continue;
      const entry = touches.get(path);
      if (entry === undefined) touches.set(path, { shas: [sha.trim()], author: author ?? "" });
      else if (entry.shas.length < SHOWN_COMMITS) entry.shas.push(sha.trim());
    }
  }
  return touches;
}

/** Drops hunks from the last files first until the answer fits the payload budget. */
function fitPayload(graph: GitPullRequestGraph): GitPullRequestGraph {
  if (graph.conflicts === null) return graph;
  const files = [...graph.conflicts.files];
  const fitted = () => ({
    ...graph,
    conflicts: { truncated: graph.conflicts?.truncated ?? false, files },
  });
  for (let index = files.length - 1; index >= 0; index -= 1) {
    if (JSON.stringify(fitted()).length <= PAYLOAD_BUDGET_CHARS) break;
    const file = files[index];
    if (file !== undefined) files[index] = { ...file, hunks: [] };
  }
  return fitted();
}

const isSafeBranchName = (name: string) =>
  !/(^[-/.])|\.\.|[\s~^:?*[\\]|@\{|\/$|\.lock$/.test(name) && name.length <= 255;

const toCommit = (commit: ParsedCommit, lane: GitGraphLane, inHead?: boolean): GitGraphCommit => ({
  sha: commit.sha,
  subject: commit.subject,
  authorName: commit.authorName,
  authoredAt: commit.authoredAt,
  parents: commit.parents,
  refs: commit.refs,
  lane,
  ...(inHead === true ? { inHead } : {}),
});

export const readPullRequestGraph = Effect.fn("readPullRequestGraph")(function* (
  git: GitVcsDriver.GitVcsDriver["Service"],
  input: GitPullRequestGraphInput,
) {
  if (!isSafeBranchName(input.baseBranch) || !isSafeBranchName(input.headBranch)) return null;
  const { cwd } = input;
  const run = (operation: string, args: ReadonlyArray<string>, allowNonZeroExit = false) =>
    git.execute({
      operation: `GitWorkflowService.pullRequestGraph.${operation}`,
      cwd,
      args,
      allowNonZeroExit,
      timeoutMs: GIT_TIMEOUT_MS,
    });

  const remote = yield* git
    .resolvePrimaryRemoteName(cwd)
    .pipe(Effect.orElseSucceed(() => "origin"));
  const decorateRefs = ["--decorate-refs=refs/heads/", `--decorate-refs=refs/remotes/${remote}/`];
  const candidates = {
    head: [`refs/heads/${input.headBranch}`, `refs/remotes/${remote}/${input.headBranch}`],
    base: [`refs/remotes/${remote}/${input.baseBranch}`, `refs/heads/${input.baseBranch}`],
  };
  const [refsResult, viewerResult, mergeHeadResult] = yield* Effect.all(
    [
      run("refs", [
        "for-each-ref",
        `--format=%(refname)${FIELD}%(objectname)`,
        ...candidates.head,
        ...candidates.base,
      ]),
      run("viewer", ["config", "user.name"], true),
      run("mergeHead", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], true),
    ],
    { concurrency: "unbounded" },
  );
  const refs = new Map(
    refsResult.stdout
      .split("\n")
      .map((line) => line.split(FIELD))
      .filter((parts): parts is [string, string] => parts.length === 2)
      .map(([name, sha]) => [name, sha.trim()]),
  );
  const resolve = (names: ReadonlyArray<string>) =>
    names.map((name) => refs.get(name)).find((sha) => sha !== undefined) ?? null;
  const headSha = resolve(candidates.head);
  let baseTip = resolve(candidates.base);
  if (headSha === null || baseTip === null) return null;

  const ownCommits = (tip: string) =>
    run("own", [
      "log",
      "--first-parent",
      `-n${OWN_COMMIT_SCAN + 1}`,
      LOG_FORMAT,
      ...decorateRefs,
      headSha,
      `^${tip}`,
      "--",
    ]).pipe(Effect.map((result) => parseLog(result.stdout, remote)));

  let own = yield* ownCommits(baseTip);
  let merged = false;
  if (own.length === 0 && headSha !== baseTip) {
    // Merged with a merge commit: the head is in the base now. Show the base as it was just
    // before that merge, so the branch's commits still read as its own.
    const mergedBy = yield* run("mergedBy", [
      "rev-list",
      "--first-parent",
      "--ancestry-path",
      "--reverse",
      `${headSha}..${baseTip}`,
    ]);
    const mergeCommit = mergedBy.stdout.split("\n")[0]?.trim();
    if (mergeCommit) {
      const parent = yield* run(
        "mergedParent",
        ["rev-parse", "--verify", `${mergeCommit}^1`],
        true,
      );
      const before = parent.stdout.trim();
      if (parent.exitCode === 0 && before.length > 0 && before !== headSha) {
        baseTip = before;
        own = yield* ownCommits(baseTip);
      }
    }
    merged = true;
  }

  let mergeBase: string | null;
  if (own.length > OWN_COMMIT_SCAN) {
    const result = yield* run("mergeBase", ["merge-base", headSha, baseTip], true);
    mergeBase = result.exitCode === 0 ? result.stdout.trim() || null : null;
  } else {
    mergeBase = own.at(-1)?.parents[0] ?? (own.length === 0 ? headSha : null);
  }

  const baseTipSha = baseTip;
  const [baseLog, forkLog] =
    mergeBase === null
      ? [[], []]
      : yield* Effect.all(
          [
            run("base", [
              "log",
              `-n${SHOWN_COMMITS + 1}`,
              LOG_FORMAT,
              ...decorateRefs,
              baseTipSha,
              `^${mergeBase}`,
              "--",
            ]).pipe(Effect.map((result) => parseLog(result.stdout, remote))),
            run("fork", ["log", "-n1", LOG_FORMAT, ...decorateRefs, mergeBase, "--"]).pipe(
              Effect.map((result) => parseLog(result.stdout, remote)),
            ),
          ],
          { concurrency: "unbounded" },
        );
  const lanes = baseLanes(baseLog, baseTipSha);

  // A base commit the branch has merged in (conflicts resolved and committed) stays on the base
  // lane, marked as already in the head.
  const headMergedBase = own.some((commit) => commit.parents.length > 1);
  const notInHead =
    headMergedBase && mergeBase !== null
      ? new Set(
          (yield* run("notInHead", [
            "rev-list",
            `-n${SHOWN_COMMITS + 1}`,
            baseTipSha,
            `^${headSha}`,
            `^${mergeBase}`,
            "--",
          ])).stdout
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0),
        )
      : null;

  const conflicts = merged
    ? { files: [], truncated: false }
    : yield* readConflicts({
        run,
        headSha,
        baseTip: baseTipSha,
        mergeBase,
      });

  const resolving =
    mergeHeadResult.exitCode === 0
      ? yield* run("unresolved", [
          "-c",
          "core.quotePath=false",
          "diff",
          "--name-only",
          "-z",
          "--diff-filter=U",
        ]).pipe(
          Effect.map((result) => {
            const unresolved = result.stdout
              .split("\0")
              .filter((path) => path.length > 0)
              .slice(0, UNRESOLVED_PATHS);
            return {
              total: Math.max(conflicts?.files.length ?? 0, unresolved.length),
              unresolved,
            };
          }),
        )
      : null;

  const viewerName = viewerResult.exitCode === 0 ? viewerResult.stdout.trim() || null : null;
  return fitPayload({
    mergeBase,
    head: own.slice(0, SHOWN_COMMITS).map((commit) => toCommit(commit, "head")),
    headTruncated: own.length > SHOWN_COMMITS,
    base: baseLog
      .slice(0, SHOWN_COMMITS)
      .map((commit) =>
        toCommit(
          commit,
          lanes.get(commit.sha) ?? "side",
          notInHead !== null && !notInHead.has(commit.sha),
        ),
      ),
    baseTruncated: baseLog.length > SHOWN_COMMITS,
    fork: forkLog[0] === undefined ? null : toCommit(forkLog[0], "base"),
    merged,
    conflicts,
    resolving,
    viewerName,
  } satisfies GitPullRequestGraph);
});

const readConflicts = Effect.fn("readPullRequestGraph.conflicts")(function* (input: {
  readonly run: (
    operation: string,
    args: ReadonlyArray<string>,
    allowNonZeroExit?: boolean,
  ) => Effect.Effect<GitVcsDriver.ExecuteGitResult, GitCommandError>;
  readonly headSha: string;
  readonly baseTip: string;
  readonly mergeBase: string | null;
}) {
  const { run } = input;
  // The plain conflict style, whatever the user configured, so the markers parse the same way.
  const mergeTree = yield* run(
    "mergeTree",
    [
      "-c",
      "merge.conflictStyle=merge",
      "merge-tree",
      "--write-tree",
      "--name-only",
      "-z",
      "--no-messages",
      input.headSha,
      input.baseTip,
    ],
    true,
  );
  // 0 is clean and 1 conflicts; anything else is a Git without `--write-tree` (older than 2.38),
  // which can only say whether it conflicts by touching the checkout. The host still says so.
  if (mergeTree.exitCode !== 0 && mergeTree.exitCode !== 1) return null;
  const [tree, ...rest] = mergeTree.stdout.split("\0");
  const paths = [...new Set(rest.filter((path) => path.length > 0))];
  if (mergeTree.exitCode === 0 || tree === undefined || paths.length === 0) {
    return { files: [], truncated: false };
  }
  const files = paths.slice(0, CONFLICT_FILES);
  const pathspec = ["--", ...files];
  const touchArgs = (range: ReadonlyArray<string>) => [
    "--literal-pathspecs",
    "-c",
    "core.quotePath=false",
    "log",
    `-n${OWN_COMMIT_SCAN}`,
    `--format=${RECORD}%H${FIELD}%an`,
    "--name-only",
    ...range,
    ...pathspec,
  ];
  const [markers, baseTouches, headTouches] = yield* Effect.all(
    [
      Effect.forEach(
        files.slice(0, CONFLICT_FILES_READ),
        (path) =>
          run("conflictBlob", ["cat-file", "blob", `${tree.trim()}:${path}`], true).pipe(
            Effect.map((result) =>
              result.exitCode !== 0 || result.stdout.includes("\0")
                ? { count: 1, hunks: [] }
                : parseConflictMarkers(result.stdout),
            ),
          ),
        { concurrency: 4 },
      ),
      input.mergeBase === null
        ? Effect.succeed<FileTouches>(new Map())
        : run("baseTouches", touchArgs([input.baseTip, `^${input.mergeBase}`])).pipe(
            Effect.map((result) => parseFileTouches(result.stdout)),
          ),
      input.mergeBase === null
        ? Effect.succeed<FileTouches>(new Map())
        : run("headTouches", touchArgs([input.headSha, `^${input.mergeBase}`])).pipe(
            Effect.map((result) => parseFileTouches(result.stdout)),
          ),
    ],
    { concurrency: "unbounded" },
  );
  return {
    files: files.map((path, index): GitConflictFile => {
      const parsed = markers[index];
      const theirs = baseTouches.get(path);
      return {
        path,
        count: Math.max(1, parsed?.count ?? 1),
        baseCommits: theirs?.shas ?? [],
        oursAuthor: headTouches.get(path)?.author ?? null,
        theirsAuthor: theirs?.author ?? null,
        hunks: parsed?.hunks ?? [],
      };
    }),
    truncated: paths.length > CONFLICT_FILES,
  };
});
