// @effect-diagnostics nodeBuiltinImport:off - Builds a disposable git repository on disk.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect, it } from "vite-plus/test";

import { checkUpstreamMerge } from "./upstream-merge-check.ts";

const repos: Array<string> = [];

afterEach(() => {
  for (const repo of repos.splice(0)) NodeFS.rmSync(repo, { recursive: true, force: true });
});

function makeRepo() {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "upstream-merge-check-"));
  repos.push(cwd);
  const git = (...args: Array<string>) =>
    NodeChildProcess.execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
      ].concat(args),
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  const write = (path: string, content: string) => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(cwd, path)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(cwd, path), content);
  };
  const commit = (message: string) => {
    git("add", "-A");
    git("commit", "-q", "-m", message);
  };
  git("init", "-q", "-b", "main");
  return { cwd, git, write, commit };
}

it("flags a ViewCode fix and its tests that a clean-looking merge dropped", () => {
  const { cwd, git, write, commit } = makeRepo();
  write("src/ws.ts", "export const config = loadConfig();\n");
  write("src/server.test.ts", 'it("serves config", () => {});\n');
  write("src/other.test.ts", 'it("other", () => {});\n');
  commit("upstream base");

  git("switch", "-q", "-c", "viewcode");
  write("src/ws.ts", "export const config = boundCatalogsForWire(loadConfig());\n");
  write("src/server.test.ts", 'it("keeps config under the relay limit", () => {});\n');
  write("src/ws.viewcode.test.ts", 'it("bounds catalogs", () => {});\n');
  write("src/viewcode/relay.ts", "export const relay = true;\n");
  commit("fix: keep catalogs out of config");

  git("switch", "-q", "main");
  write("src/ws.ts", "export const config = loadConfigV2();\n");
  NodeFS.rmSync(NodePath.join(cwd, "src/server.test.ts"));
  NodeFS.rmSync(NodePath.join(cwd, "src/other.test.ts"));
  commit("upstream rewrite");

  // The merge takes upstream's side everywhere and drops the guard test as well.
  git("switch", "-q", "viewcode");
  git("merge", "-q", "-s", "ours", "--no-commit", "main");
  git("checkout", "main", "--", "src/ws.ts");
  git("rm", "-q", "src/server.test.ts", "src/other.test.ts", "src/ws.viewcode.test.ts");
  write("src/viewcode/relay.ts", "export const relay = false;\n");
  commit("merge upstream");

  const report = checkUpstreamMerge({ cwd });

  expect(report.deletedTests).toEqual([
    { path: "src/other.test.ts", viewcode: false },
    { path: "src/server.test.ts", viewcode: true },
    { path: "src/ws.viewcode.test.ts", viewcode: true },
  ]);
  expect(report.guardTestsChanged).toEqual(["src/ws.viewcode.test.ts"]);
  expect(report.ownedChanged).toEqual(["src/viewcode/relay.ts", "src/ws.viewcode.test.ts"]);
  expect(report.touchedChanged).toContainEqual({
    path: "src/ws.ts",
    status: "modified",
    viewcodeLines: 1,
    viewcodeLinesMissing: 1,
  });
});
