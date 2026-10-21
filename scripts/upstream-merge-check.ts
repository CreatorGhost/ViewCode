#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - a read-only wrapper around git plumbing.
// @effect-diagnostics globalConsole:off - CLI output for the person running it.
/**
 * Lists what an upstream T3 Code merge did to ViewCode's own work, so a reviewer
 * can check it. Merges have dropped ViewCode fixes without any conflict: upstream
 * rewrote or deleted the file and the resolution took upstream's side, together
 * with the test that guarded the fix. See docs/operations/upstream-merge.md.
 *
 *   node scripts/upstream-merge-check.ts [--merge <M>] [--viewcode <P>] [--upstream <U>]
 *
 * M defaults to HEAD. P (ViewCode before the merge) defaults to M's first parent
 * when M is a merge, else M. U defaults to M's second parent, else upstream/main.
 * Exits 1 when the merge deleted a ViewCode test file.
 */
import * as NodeChildProcess from "node:child_process";

/** Paths upstream never has: `viewcode/` folders, `ViewCode*` files, `*.viewcode.test.*` guards. */
const VIEWCODE_OWNED = [/viewcode/i, /^apps\/server\/src\/relay\//];
const GUARD_TEST = /\.viewcode\.test\.[cm]?[jt]sx?$/;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const IGNORED = /^\.repos\//;
/** Shorter added lines (braces, `return;`, imports of one name) say nothing about what was lost. */
const MIN_SIGNIFICANT_LINE = 12;

export interface ChangedFile {
  readonly path: string;
  readonly status: "modified" | "deleted";
  /** Lines ViewCode added since the merge base that M no longer has anywhere in the file. */
  readonly viewcodeLinesMissing: number;
  readonly viewcodeLines: number;
}

export interface DeletedTest {
  readonly path: string;
  readonly viewcode: boolean;
}

export interface UpstreamMergeReport {
  readonly merge: string;
  readonly viewcode: string;
  readonly upstream: string;
  readonly base: string;
  readonly touchedChanged: ReadonlyArray<ChangedFile>;
  readonly deletedTests: ReadonlyArray<DeletedTest>;
  readonly guardTestsChanged: ReadonlyArray<string>;
  readonly ownedChanged: ReadonlyArray<string>;
}

function git(cwd: string, args: ReadonlyArray<string>, input?: string): string {
  return NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    input,
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

const isViewCodeOwned = (path: string) => VIEWCODE_OWNED.some((pattern) => pattern.test(path));
const significant = (line: string) => line.trim().length >= MIN_SIGNIFICANT_LINE;
/** Formatting a merge applies (line wraps, trailing commas) must not read as lost code. */
const compact = (text: string) => text.replace(/[\s,;]+/g, "");

/** The `+` lines of a unified diff, grouped by the file they were added to. */
function addedLinesByFile(diff: string): Map<string, Array<string>> {
  const added = new Map<string, Array<string>>();
  let current: Array<string> | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const path = line.slice(4);
      current = path === "/dev/null" ? undefined : [];
      if (current) added.set(path.replace(/^b\//, ""), current);
    } else if (current && line.startsWith("+") && significant(line.slice(1))) {
      current.push(compact(line.slice(1)));
    }
  }
  return added;
}

/** Each path's text at `rev`, read through one `git cat-file --batch`. */
function readFiles(cwd: string, rev: string, paths: ReadonlyArray<string>): Map<string, string> {
  const files = new Map<string, string>();
  if (paths.length === 0) return files;
  const output = NodeChildProcess.execFileSync("git", ["cat-file", "--batch"], {
    cwd,
    input: paths.map((path) => `${rev}:${path}`).join("\n") + "\n",
    maxBuffer: 1024 * 1024 * 1024,
  });
  let offset = 0;
  for (const path of paths) {
    const headerEnd = output.indexOf(10, offset);
    const header = output.subarray(offset, headerEnd).toString("utf8");
    offset = headerEnd + 1;
    if (header.endsWith(" missing")) continue;
    const size = Number(header.split(" ")[2]);
    files.set(path, output.subarray(offset, offset + size).toString("utf8"));
    offset += size + 1;
  }
  return files;
}

function parents(cwd: string, rev: string): ReadonlyArray<string> {
  return git(cwd, ["rev-list", "--parents", "-n", "1", rev]).trim().split(" ").slice(1);
}

export function checkUpstreamMerge(options: {
  readonly cwd: string;
  readonly merge?: string | undefined;
  readonly viewcode?: string | undefined;
  readonly upstream?: string | undefined;
}): UpstreamMergeReport {
  const { cwd } = options;
  const resolve = (rev: string) => git(cwd, ["rev-parse", "--verify", `${rev}^{commit}`]).trim();
  const merge = resolve(options.merge ?? "HEAD");
  const mergeParents = parents(cwd, merge);
  const viewcode = resolve(
    options.viewcode ?? (mergeParents.length > 1 ? mergeParents[0]! : merge),
  );
  const upstream = resolve(options.upstream ?? mergeParents[1] ?? "upstream/main");
  const base = git(cwd, ["merge-base", viewcode, upstream]).trim();

  // Every ViewCode commit is out of upstream's reach, so base..P is all of ViewCode's own work.
  const touched = new Set(
    git(cwd, ["log", "--no-merges", "--format=", "--name-only", `${base}..${viewcode}`])
      .split("\n")
      .filter((path) => path && !IGNORED.test(path)),
  );
  const changed = git(cwd, ["diff", "--no-renames", "--name-status", viewcode, merge])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status = "", path = ""] = line.split("\t");
      return { status: status === "D" ? ("deleted" as const) : ("modified" as const), path };
    })
    .filter(({ path }) => !IGNORED.test(path));

  const touchedPaths = changed.filter(({ path }) => touched.has(path));
  const added =
    touchedPaths.length === 0
      ? new Map<string, Array<string>>()
      : addedLinesByFile(
          git(cwd, [
            "diff",
            "--no-renames",
            "--no-color",
            "--unified=0",
            base,
            viewcode,
            "--",
            ...touchedPaths.map(({ path }) => path),
          ]),
        );
  const after = readFiles(
    cwd,
    merge,
    touchedPaths.filter(({ status }) => status === "modified").map(({ path }) => path),
  );
  const touchedChanged = touchedPaths
    .map(({ path, status }): ChangedFile => {
      const lines = added.get(path) ?? [];
      const kept = compact(after.get(path) ?? "");
      return {
        path,
        status,
        viewcodeLines: lines.length,
        viewcodeLinesMissing: lines.filter((line) => !kept.includes(line)).length,
      };
    })
    .toSorted(
      (left, right) =>
        right.viewcodeLinesMissing - left.viewcodeLinesMissing ||
        left.path.localeCompare(right.path),
    );

  return {
    merge,
    viewcode,
    upstream,
    base,
    touchedChanged,
    deletedTests: changed
      .filter(({ status, path }) => status === "deleted" && TEST_FILE.test(path))
      .map(({ path }) => ({ path, viewcode: touched.has(path) || isViewCodeOwned(path) })),
    guardTestsChanged: changed.filter(({ path }) => GUARD_TEST.test(path)).map(({ path }) => path),
    ownedChanged: changed.filter(({ path }) => isViewCodeOwned(path)).map(({ path }) => path),
  };
}

export function formatUpstreamMergeReport(report: UpstreamMergeReport): string {
  const short = (rev: string) => rev.slice(0, 9);
  const section = (title: string, rows: ReadonlyArray<string>) =>
    [`${title} (${rows.length})`, ...(rows.length === 0 ? ["  none"] : rows)].join("\n");
  return [
    `merge ${short(report.merge)}  viewcode ${short(report.viewcode)}  upstream ${short(report.upstream)}  base ${short(report.base)}`,
    "",
    section(
      "Test files the merge deleted ([viewcode] = ViewCode wrote or changed it)",
      report.deletedTests.map((test) => `  ${test.viewcode ? "[viewcode] " : ""}${test.path}`),
    ),
    "",
    section(
      "ViewCode guard tests (*.viewcode.test.*) the merge changed or deleted",
      report.guardTestsChanged.map((path) => `  ${path}`),
    ),
    "",
    section(
      "ViewCode-owned paths the merge changed",
      report.ownedChanged.map((path) => `  ${path}`),
    ),
    "",
    section(
      "Files ViewCode changed that the merge changed, most ViewCode lines missing first",
      report.touchedChanged.map(
        (file) =>
          `  ${file.status === "deleted" ? "deleted " : ""}-${file.viewcodeLinesMissing}/${file.viewcodeLines}  ${file.path}`,
      ),
    ),
    "",
    "Review each listed file against `git diff <base> <viewcode> -- <file>`.",
  ].join("\n");
}

function readFlag(argv: ReadonlyArray<string>, name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a revision.`);
  return value;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const report = checkUpstreamMerge({
    cwd: process.cwd(),
    merge: readFlag(argv, "--merge"),
    viewcode: readFlag(argv, "--viewcode"),
    upstream: readFlag(argv, "--upstream"),
  });
  console.log(formatUpstreamMergeReport(report));
  if (report.deletedTests.some((test) => test.viewcode)) {
    console.error(
      "\nThe merge deleted ViewCode test files. Restore them or justify each in the PR.",
    );
    process.exitCode = 1;
  }
}
